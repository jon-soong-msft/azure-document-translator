/**
 * Layout-preserving PDF translation via Azure Translator's ASYNCHRONOUS batch
 * Document Translation API.
 *
 * The synchronous endpoint rejects PDF, so PDFs go through this flow:
 *   1. Upload the source PDF to a blob in the "source" container.
 *   2. Start a batch job pointing at source + target blob URLs (no SAS — the
 *      Translator resource's managed identity reads/writes the blobs).
 *   3. Poll the job until it succeeds.
 *   4. Download the translated PDF from the "target" container.
 *   5. Delete both working blobs.
 *
 * Uses Document Translation API 2026-03-01 with `translateTextWithinImage` when
 * a page actually contains an image large enough to hold text (chart, figure,
 * screenshot, stamp), so text baked into it is OCR'd and translated back in
 * place. Text-only and logo/icon-only pages skip that pass (API 2024-05-01),
 * which is much faster and often cleaner — see `./pdf-images` and the
 * optimization/ profiling. The trade-off when it does run is higher character
 * cost and a larger output file where images are re-rendered.
 *
 * Requires storage env vars (set by the azd infra) and that the Translator
 * resource identity has "Storage Blob Data Contributor" on the account.
 */

import { randomUUID } from "node:crypto";
import { BlobServiceClient, type BlockBlobClient } from "@azure/storage-blob";
import { PDFDocument } from "pdf-lib";
import {
  getAzureCredential,
  documentTranslationAuthHeaders,
  documentTranslationEndpoint,
  type DocumentTranslationResult,
} from "./azure";
import { signJob, verifyJob, JobTokenError } from "./job-token";
import { significantImagePages } from "./pdf-images";
import { SpanKind } from "@opentelemetry/api";
import {
  withSpan,
  captureTraceContext,
  contextFromCarrier,
  setActiveSpanAttributes,
  type TraceCarrier,
} from "./tracing";

export { JobTokenError };

// 2026-03-01 (GA) translates PDFs via Document Intelligence and, with
// `translateTextWithinImage` enabled, also OCRs and re-renders text baked into
// embedded images (charts, figures, stamps). When image-text translation is
// turned off we use the older 2024-05-01, which does a cleaner text-layer-only
// translation.
const batchApiVersion = (translateImageText: boolean) =>
  translateImageText ? "2026-03-01" : "2024-05-01";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("<")) {
    throw new Error(`Missing environment variable "${name}" for batch PDF translation.`);
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thrown when the app can't reach Blob Storage to stage the PDF. The usual
 * cause in locked-down environments is the storage account having public
 * network access disabled (no private endpoint), or a firewall rule — which
 * returns a 403 "not authorized" even when the RBAC roles are correct. Callers
 * can map this to a clear client response instead of a generic 500.
 */
export class StorageUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnreachableError";
  }
}

/**
 * Returns a friendly, actionable message if `err` looks like a Blob Storage
 * connectivity/authorization failure, otherwise undefined.
 */
function storageUnreachableMessage(err: unknown): string | undefined {
  const e = err as { statusCode?: number; code?: string; message?: string };
  const haystack = `${e?.code ?? ""} ${e?.message ?? ""}`;
  const looksAuth =
    e?.statusCode === 403 ||
    /AuthorizationFailure|not authorized to perform this operation/i.test(haystack);
  const looksNetwork =
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|ENETUNREACH|socket hang up/i.test(
      haystack
    );
  if (!looksAuth && !looksNetwork) return undefined;
  const account = process.env.AZURE_STORAGE_ACCOUNT_NAME ?? "the storage account";
  return (
    `Couldn't reach Blob Storage to translate this PDF. The storage account ` +
    `"${account}" is blocking the request — most often because its public ` +
    `network access is disabled (with no private endpoint) or a firewall rule ` +
    `excludes this host. Layout-preserving PDF translation must upload the file ` +
    `to storage first, so it can't run here. Use Text view (it doesn't need ` +
    `storage), or enable network access / add a private endpoint for the app.`
  );
}

interface BatchStatus {
  status: string;
  error?: { message?: string; code?: string };
  summary?: {
    total: number;
    failed: number;
    success: number;
    totalCharacterCharged?: number;
  };
}

/**
 * Translates a PDF while preserving layout, using the batch API + blob storage.
 */
export async function translatePdfBatch(
  fileBytes: Buffer,
  to: string,
  from?: string,
  translateImageText = true
): Promise<DocumentTranslationResult> {
  return withSpan(
    "translate.pdf.sync",
    async (span) => {
      const result = await translatePdfBatchImpl(fileBytes, to, from, translateImageText);
      if (result.charactersCharged != null) {
        span.setAttribute("translation.characters_charged", result.charactersCharged);
      }
      return result;
    },
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "translation.provider": "translator-document-batch",
        "translation.file_bytes": fileBytes.length,
        "translation.to": to,
        "translation.from": from ?? "auto",
        "translation.image_text_requested": translateImageText,
      },
    }
  );
}

async function translatePdfBatchImpl(
  fileBytes: Buffer,
  to: string,
  from?: string,
  translateImageText = true
): Promise<DocumentTranslationResult> {
  const blobEndpoint = requireEnv("AZURE_STORAGE_BLOB_ENDPOINT");
  const sourceContainer = requireEnv("AZURE_STORAGE_SOURCE_CONTAINER");
  const targetContainer = requireEnv("AZURE_STORAGE_TARGET_CONTAINER");

  // Only pay for image-text translation if the PDF actually contains an image
  // big enough to hold text; a text-only or logo-only doc translates faster and
  // often cleaner without it. Detection failure falls back to honoring the flag.
  let effectiveImageText = translateImageText;
  if (translateImageText) {
    try {
      effectiveImageText = (await significantImagePages(fileBytes)).size > 0;
    } catch {
      effectiveImageText = true;
    }
  }

  const blobService = new BlobServiceClient(blobEndpoint, getAzureCredential());
  const sourceClient = blobService.getContainerClient(sourceContainer);
  const targetClient = blobService.getContainerClient(targetContainer);

  // Unique blob name per request so concurrent jobs don't collide.
  const blobName = `${randomUUID()}.pdf`;
  const sourceBlob = sourceClient.getBlockBlobClient(blobName);
  const targetBlob = targetClient.getBlockBlobClient(blobName);

  try {
    // 1. Upload the source PDF.
    try {
      await sourceBlob.uploadData(fileBytes, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
      });
    } catch (err) {
      const friendly = storageUnreachableMessage(err);
      if (friendly) throw new StorageUnreachableError(friendly);
      throw err;
    }

    // 2. Start the batch job (blob-level: storageType "File").
    const target: Record<string, string> = { targetUrl: targetBlob.url, language: to };
    const source: Record<string, string> = { sourceUrl: sourceBlob.url };
    if (from && from !== "auto") source.language = from;

    const startRes = await fetch(
      `${documentTranslationEndpoint()}/translator/document/batches?api-version=${batchApiVersion(effectiveImageText)}`,
      {
        method: "POST",
        headers: {
          ...(await documentTranslationAuthHeaders()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: [{ storageType: "File", source, targets: [target] }],
          // Also translate text embedded inside images (charts, screenshots,
          // stamps), rendering the translation back in place, when requested.
          options: { translateTextWithinImage: effectiveImageText },
        }),
      }
    );

    if (startRes.status !== 202) {
      const detail = await safeError(startRes);
      throw new Error(`Could not start PDF translation (${startRes.status}). ${detail}`);
    }

    const operationLocation = startRes.headers.get("operation-location");
    if (!operationLocation) {
      throw new Error("Batch translation did not return an operation-location to poll.");
    }

    // 3. Poll until the job finishes (up to ~2 minutes).
    let succeeded = false;
    let charactersCharged: number | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(2000);
      const pollRes = await fetch(operationLocation, {
        headers: await documentTranslationAuthHeaders(),
      });
      if (!pollRes.ok) {
        const detail = await safeError(pollRes);
        throw new Error(`Polling PDF translation failed (${pollRes.status}). ${detail}`);
      }
      const body = (await pollRes.json()) as BatchStatus;
      const status = body.status?.toLowerCase();
      if (status === "succeeded") {
        succeeded = true;
        charactersCharged = body.summary?.totalCharacterCharged;
        break;
      }
      if (status === "failed" || status === "validationfailed") {
        throw new Error(
          `PDF translation failed: ${body.error?.message ?? "unknown error"}`
        );
      }
    }

    if (!succeeded) {
      throw new Error("PDF translation timed out. Try a smaller document.");
    }

    // 4. Download the translated PDF.
    let download: Buffer;
    try {
      download = await downloadBlobToBuffer(targetBlob);
    } catch (err) {
      const friendly = storageUnreachableMessage(err);
      if (friendly) throw new StorageUnreachableError(friendly);
      throw err;
    }
    return {
      bytes: download,
      contentType: "application/pdf",
      isImage: false,
      charactersCharged,
    };
  } finally {
    // 5. Best-effort cleanup of working blobs.
    await Promise.allSettled([
      sourceBlob.deleteIfExists(),
      targetBlob.deleteIfExists(),
    ]);
  }
}

async function safeError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return typeof data?.error?.message === "string"
      ? data.error.message
      : JSON.stringify(data);
  } catch {
    try {
      return await res.text();
    } catch {
      return "No error detail available.";
    }
  }
}

// ===========================================================================
// Split + parallel + async batch translation (for large / dense PDFs)
// ===========================================================================
//
// As a single batch job a big PDF can take many minutes — Document Intelligence
// plus image-text translation re-renders every page (measured ~23 min for a
// dense 24-page file). Splitting it into small page-range chunks and translating
// them as PARALLEL batch jobs cuts the wall-clock several-fold (~3.4x measured,
// at the same character cost). Because even the split job runs for minutes —
// too long to hold one HTTP request open through the browser and Container Apps
// ingress — the work is exposed as an async job: the submit returns a signed
// token, the client polls status, then fetches the merged result.

/** Pages per chunk when splitting a PDF for parallel translation. */
const PAGES_PER_CHUNK = 3;

/** Use the split + async path for PDFs above either threshold. */
export const ASYNC_PDF_PAGE_THRESHOLD = 8;
export const ASYNC_PDF_BYTES_THRESHOLD = 15 * 1024 * 1024; // 15 MB

interface ChunkRef {
  /** Operation-location URL to poll this chunk's batch job. */
  op: string;
  /** Blob name (identical in source + target containers) for download/cleanup. */
  name: string;
  /** First page index (0-based) and page count — used to order the merge. */
  p0: number;
  n: number;
}

interface PdfJobPayload {
  v: 1;
  file: string;
  to: string;
  from?: string;
  /** Whether the caller asked for an evaluation report. */
  ev: boolean;
  /** Submit time (epoch ms), used to report processing duration. */
  created: number;
  /** W3C trace context captured at submit, to rejoin the distributed trace. */
  tp?: TraceCarrier;
  chunks: ChunkRef[];
}

export interface PdfJobStatus {
  status: "running" | "succeeded" | "failed";
  done: number;
  total: number;
  error?: string;
  /** Submit time (epoch ms), so callers can report processing duration. */
  startedAt?: number;
}

/** Reads a PDF's page count (used to decide between the sync and async paths). */
export async function getPdfPageCount(fileBytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(fileBytes, { updateMetadata: false });
  return doc.getPageCount();
}

/** Whether a PDF is big/dense enough to warrant the split + async path. */
export function shouldUseAsyncPdf(fileBytes: Buffer, pageCount: number): boolean {
  return (
    pageCount > ASYNC_PDF_PAGE_THRESHOLD || fileBytes.length > ASYNC_PDF_BYTES_THRESHOLD
  );
}

function batchBlobClients() {
  const blobService = new BlobServiceClient(
    requireEnv("AZURE_STORAGE_BLOB_ENDPOINT"),
    getAzureCredential()
  );
  return {
    source: blobService.getContainerClient(requireEnv("AZURE_STORAGE_SOURCE_CONTAINER")),
    target: blobService.getContainerClient(requireEnv("AZURE_STORAGE_TARGET_CONTAINER")),
  };
}

/** Splits a PDF into chunks of at most `pagesPerChunk` pages, in page order. */
async function splitPdf(
  fileBytes: Buffer,
  pagesPerChunk: number
): Promise<{ chunks: { bytes: Buffer; p0: number; n: number }[]; total: number }> {
  const src = await PDFDocument.load(fileBytes, { updateMetadata: false });
  const total = src.getPageCount();
  const chunks: { bytes: Buffer; p0: number; n: number }[] = [];
  for (let start = 0; start < total; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, total);
    const doc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const pages = await doc.copyPages(src, indices);
    pages.forEach((p) => doc.addPage(p));
    chunks.push({ bytes: Buffer.from(await doc.save()), p0: start, n: end - start });
  }
  return { chunks, total };
}

/** Merges translated chunk PDFs back into one document, preserving order. */
async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf, { updateMetadata: false });
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

/**
 * Downloads a blob fully into a Buffer by reading the stream ourselves.
 *
 * We deliberately avoid the SDK's `downloadToBuffer()`, whose internal stream
 * read is capped at a hardcoded 100s (it rejects with "The operation cannot be
 * completed in timeout."). A slow or briefly stalled link to the storage region
 * can trip that on a multi-megabyte translated chunk and surface as a 500. A
 * plain `download()` + manual read has no such cap, the SDK transparently
 * retries dropped reads (`maxRetryRequests`), and a small outer retry covers a
 * failed initial GET. Storage firewall/permission blocks are rethrown straight
 * away so the caller can surface the actionable "storage unreachable" message.
 */
async function downloadBlobToBuffer(blob: BlockBlobClient): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await blob.download(0, undefined, { maxRetryRequests: 3 });
      const stream = resp.readableStreamBody;
      if (!stream) throw new Error("Storage returned an empty download stream.");
      const parts: Buffer[] = [];
      for await (const part of stream) {
        parts.push(typeof part === "string" ? Buffer.from(part) : part);
      }
      return Buffer.concat(parts);
    } catch (err) {
      // A storage firewall/permission block won't improve by retrying.
      if (storageUnreachableMessage(err)) throw err;
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

type ContainerClient = ReturnType<typeof batchBlobClients>["source"];

/** Uploads one chunk and starts its batch job; returns the poll URL + blob name. */
async function submitChunk(
  source: ContainerClient,
  target: ContainerClient,
  bytes: Buffer,
  to: string,
  from: string | undefined,
  translateImageText: boolean
): Promise<{ op: string; name: string }> {
  const name = `${randomUUID()}.pdf`;
  const sourceBlob = source.getBlockBlobClient(name);
  const targetBlob = target.getBlockBlobClient(name);

  try {
    await sourceBlob.uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: "application/pdf" },
    });
  } catch (err) {
    const friendly = storageUnreachableMessage(err);
    if (friendly) throw new StorageUnreachableError(friendly);
    throw err;
  }

  const targetInput: Record<string, string> = { targetUrl: targetBlob.url, language: to };
  const sourceInput: Record<string, string> = { sourceUrl: sourceBlob.url };
  if (from && from !== "auto") sourceInput.language = from;

  let op: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch(
        `${documentTranslationEndpoint()}/translator/document/batches?api-version=${batchApiVersion(translateImageText)}`,
        {
          method: "POST",
          headers: {
            ...(await documentTranslationAuthHeaders()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputs: [
              {
                storageType: "File",
                source: sourceInput,
                targets: [targetInput],
              },
            ],
            // `options` is a TOP-LEVEL sibling of `inputs` in the batch schema
            // (matches the sync path and Azure's docs). Nesting it inside
            // inputs[0] makes Azure silently ignore it, which drops image-text
            // translation on the split path (verified: 88.81% vs 100%).
            options: { translateTextWithinImage: translateImageText },
          }),
        }
      );
    } catch {
      // Transient DNS/connection blip — wait and retry.
      await sleep(3000);
      continue;
    }
    // Back off and retry if the service throttles a burst of parallel submits.
    if (res.status === 429) {
      await sleep(5000);
      continue;
    }
    if (res.status !== 202) {
      const detail = await safeError(res);
      throw new Error(`Could not start PDF translation (${res.status}). ${detail}`);
    }
    op = res.headers.get("operation-location");
    break;
  }
  if (!op) {
    throw new Error("Batch translation did not return an operation-location to poll.");
  }
  return { op, name };
}

interface ChunkState {
  status: string;
  charactersCharged?: number;
  error?: { message?: string };
}

async function pollChunk(op: string): Promise<ChunkState> {
  let res: Response;
  try {
    res = await fetch(op, { headers: await documentTranslationAuthHeaders() });
  } catch {
    // Transient network blip while polling — treat as "still running".
    return { status: "running" };
  }
  if (!res.ok) return { status: "running" };
  const body = (await res.json()) as BatchStatus;
  return {
    status: (body.status ?? "running").toLowerCase(),
    charactersCharged: body.summary?.totalCharacterCharged,
    error: body.error,
  };
}

/** Best-effort deletion of every working blob for a job. */
async function cleanupJob(payload: PdfJobPayload): Promise<void> {
  const { source, target } = batchBlobClients();
  await Promise.allSettled(
    payload.chunks.flatMap((c) => [
      source.getBlockBlobClient(c.name).deleteIfExists(),
      target.getBlockBlobClient(c.name).deleteIfExists(),
    ])
  );
}

/**
 * Splits a PDF into page chunks, starts a parallel batch job for each, and
 * returns a signed token describing the job plus its size. The caller then polls
 * {@link getPdfJobStatus} and finally {@link finishPdfBatchJob}.
 */
export async function startPdfBatchJob(
  fileBytes: Buffer,
  fileName: string,
  to: string,
  from: string | undefined,
  evaluate: boolean,
  translateImageText = true
): Promise<{ token: string; totalPages: number; chunkCount: number }> {
  return withSpan(
    "translate.pdf.submit",
    () =>
      startPdfBatchJobImpl(fileBytes, fileName, to, from, evaluate, translateImageText),
    { kind: SpanKind.INTERNAL }
  );
}

async function startPdfBatchJobImpl(
  fileBytes: Buffer,
  fileName: string,
  to: string,
  from: string | undefined,
  evaluate: boolean,
  translateImageText = true
): Promise<{ token: string; totalPages: number; chunkCount: number }> {
  const { source, target } = batchBlobClients();
  const { chunks, total } = await splitPdf(fileBytes, PAGES_PER_CHUNK);

  // Enable image-text translation only on chunks that actually contain an image
  // big enough to hold text. Text-only and logo-only chunks translate much
  // faster (and often cleaner) with it off — the slowest chunk floors the whole
  // job's wall-clock, so this can cut minutes. Detection failure falls back to
  // honoring the flag on every chunk (conservative).
  let significantPages: Set<number> | null = null;
  if (translateImageText) {
    try {
      significantPages = await significantImagePages(fileBytes);
    } catch {
      significantPages = null;
    }
  }
  const wantsImageText = (p0: number, n: number): boolean => {
    if (!translateImageText) return false;
    if (!significantPages) return true; // couldn't detect -> keep on
    for (let p = p0; p < p0 + n; p++) if (significantPages.has(p)) return true;
    return false;
  };

  setActiveSpanAttributes({
    "translation.provider": "translator-document-batch",
    "translation.file_bytes": fileBytes.length,
    "translation.pages": total,
    "translation.chunks": chunks.length,
    "translation.to": to,
    "translation.from": from ?? "auto",
    "translation.image_text_requested": translateImageText,
  });

  // Promise.all preserves input order, so `submitted` stays in page order. Each
  // chunk's submit is traced so the parallel fan-out is visible end-to-end.
  const submitted = await Promise.all(
    chunks.map((c) => {
      const imageText = wantsImageText(c.p0, c.n);
      return withSpan(
        "translate.pdf.chunk.submit",
        () =>
          submitChunk(source, target, c.bytes, to, from, imageText).then((s) => ({
            op: s.op,
            name: s.name,
            p0: c.p0,
            n: c.n,
          })),
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "translation.chunk.page_start": c.p0,
            "translation.chunk.page_count": c.n,
            "translation.chunk.bytes": c.bytes.length,
            "translation.chunk.image_text": imageText,
          },
        }
      );
    })
  );

  const payload: PdfJobPayload = {
    v: 1,
    file: fileName,
    to,
    from,
    ev: evaluate,
    created: Date.now(),
    // W3C trace context of this submit span, so the eventual result request can
    // rejoin the same distributed trace (one end-to-end transaction).
    tp: captureTraceContext(),
    chunks: submitted,
  };
  return { token: await signJob(payload), totalPages: total, chunkCount: chunks.length };
}

/** Polls every chunk and reports overall progress. Cleans up on failure. */
export async function getPdfJobStatus(token: string): Promise<PdfJobStatus> {
  const payload = await verifyJob<PdfJobPayload>(token);
  if (!payload || payload.v !== 1) throw new JobTokenError();

  const states = await Promise.all(payload.chunks.map((c) => pollChunk(c.op)));
  let done = 0;
  let failed = 0;
  let error: string | undefined;
  for (const s of states) {
    if (s.status === "succeeded") done++;
    else if (s.status === "failed" || s.status === "validationfailed") {
      failed++;
      error = s.error?.message ?? error;
    }
  }

  const total = payload.chunks.length;
  if (failed > 0) {
    await cleanupJob(payload).catch(() => {});
    return {
      status: "failed",
      done,
      total,
      error: error ?? "One or more parts of the document failed to translate.",
      startedAt: payload.created,
    };
  }
  return {
    status: done === total ? "succeeded" : "running",
    done,
    total,
    startedAt: payload.created,
  };
}

/**
 * Downloads every translated chunk for a finished job, merges them back into a
 * single PDF (in page order), then deletes the working blobs.
 */
export async function finishPdfBatchJob(token: string): Promise<{
  result: DocumentTranslationResult;
  fileName: string;
  to: string;
  processingMs: number;
  evaluate: boolean;
}> {
  const payload = await verifyJob<PdfJobPayload>(token);
  if (!payload || payload.v !== 1) throw new JobTokenError();

  // Rejoin the trace started by the submit request so the whole async job
  // (submit, polling, and this final download + merge) is a single end-to-end
  // distributed transaction in Application Insights.
  return withSpan(
    "translate.pdf.finish",
    async (span) => {
      const states = await Promise.all(payload.chunks.map((c) => pollChunk(c.op)));
      if (!states.every((s) => s.status === "succeeded")) {
        throw new Error("Translation is not finished yet.");
      }

      const { target } = batchBlobClients();
      const buffers: Buffer[] = [];
      for (const c of payload.chunks) {
        try {
          buffers.push(
            await withSpan(
              "translate.pdf.chunk.download",
              () => downloadBlobToBuffer(target.getBlockBlobClient(c.name)),
              {
                kind: SpanKind.CLIENT,
                attributes: {
                  "translation.chunk.page_start": c.p0,
                  "translation.chunk.page_count": c.n,
                },
              }
            )
          );
        } catch (err) {
          const friendly = storageUnreachableMessage(err);
          if (friendly) throw new StorageUnreachableError(friendly);
          throw err;
        }
      }

      const merged = await withSpan("translate.pdf.merge", () => mergePdfs(buffers));
      const charactersCharged = states.reduce(
        (sum, s) => sum + (s.charactersCharged ?? 0),
        0
      );
      span.setAttributes({
        "translation.chunks": payload.chunks.length,
        "translation.characters_charged": charactersCharged,
      });
      await cleanupJob(payload).catch(() => {});

      return {
        result: {
          bytes: merged,
          contentType: "application/pdf",
          isImage: false,
          charactersCharged,
        },
        fileName: payload.file,
        to: payload.to,
        processingMs: Date.now() - payload.created,
        evaluate: payload.ev,
      };
    },
    { kind: SpanKind.INTERNAL, parent: contextFromCarrier(payload.tp) }
  );
}
