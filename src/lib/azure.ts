/**
 * Thin server-side clients for the two Azure AI services used by this app:
 *
 *   1. Azure AI Document Intelligence (prebuilt-read) -> OCR / text extraction
 *   2. Azure AI Translator (Text Translation v3.0)    -> translation
 *
 * Authentication supports two modes, chosen automatically per service:
 *
 *   - Microsoft Entra ID (keyless, recommended): used when no resource key is
 *     configured. Tokens come from `DefaultAzureCredential`, which uses your
 *     `az login` session locally and a managed identity when hosted in Azure.
 *   - Resource key: used when an `*_KEY` env var is provided.
 */

import { DefaultAzureCredential, type AccessToken } from "@azure/identity";
import { SpanKind } from "@opentelemetry/api";
import { withSpan } from "./tracing";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.startsWith("<")) return undefined;
  return value;
}

function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(
      `Missing environment variable "${name}". Copy .env.example to .env.local and fill it in.`
    );
  }
  return value;
}

const DI_API_VERSION = "2024-11-30";
const TRANSLATOR_API_VERSION = "3.0";
const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

// Translator allows up to 50,000 chars per request; stay well under that.
const MAX_CHARS_PER_REQUEST = 45000;
const MAX_ELEMENTS_PER_REQUEST = 900;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Microsoft Entra ID token (keyless auth), lazily created and cached
// ---------------------------------------------------------------------------

let credential: DefaultAzureCredential | undefined;
let cachedToken: AccessToken | undefined;

/** Returns a shared DefaultAzureCredential (managed identity in Azure, az login locally). */
export function getAzureCredential(): DefaultAzureCredential {
  if (!credential) credential = new DefaultAzureCredential();
  return credential;
}

export async function getEntraToken(): Promise<string> {
  // Refresh if missing or within 5 minutes of expiry.
  const now = Date.now();
  if (!cachedToken || cachedToken.expiresOnTimestamp - now < 5 * 60 * 1000) {
    try {
      cachedToken = await getAzureCredential().getToken(COGNITIVE_SERVICES_SCOPE);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not obtain a Microsoft Entra ID token. Make sure you're signed in (run "az login") or that a managed identity is available. ${detail}`
      );
    }
    if (!cachedToken) {
      throw new Error("Microsoft Entra ID returned an empty access token.");
    }
  }
  return cachedToken.token;
}

// ---------------------------------------------------------------------------
// 1. OCR via Azure AI Document Intelligence (prebuilt-read)
// ---------------------------------------------------------------------------

async function docIntelAuthHeaders(): Promise<Record<string, string>> {
  const key = optionalEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY");
  if (key) return { "Ocp-Apim-Subscription-Key": key };
  return { Authorization: `Bearer ${await getEntraToken()}` };
}

export interface OcrResult {
  /** Recognised text content. */
  content: string;
  /** Number of pages analysed — the billing unit for Document Intelligence. */
  pages: number;
}

/**
 * Runs OCR / text extraction on a document and returns the recognised text.
 * Supports PDF, images (PNG/JPG/TIFF/BMP) and Office files (DOCX/XLSX/PPTX/HTML).
 */
export async function extractText(fileBytes: Buffer): Promise<string> {
  return (await extractTextWithMeta(fileBytes)).content;
}

/**
 * Like {@link extractText} but also reports the page count, used for cost
 * evaluation. Both go through the same single analyze call — no extra billing.
 */
export async function extractTextWithMeta(fileBytes: Buffer): Promise<OcrResult> {
  return withSpan(
    "ocr.analyze",
    async (span) => {
      const result = await extractTextWithMetaImpl(fileBytes);
      span.setAttributes({
        "translation.ocr_pages": result.pages,
        "translation.characters": result.content.length,
      });
      return result;
    },
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "translation.provider": "document-intelligence",
        "translation.file_bytes": fileBytes.length,
      },
    }
  );
}

async function extractTextWithMetaImpl(fileBytes: Buffer): Promise<OcrResult> {
  const endpoint = trimSlash(requireEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT"));
  const auth = await docIntelAuthHeaders();

  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${DI_API_VERSION}`;

  const submit = await fetch(analyzeUrl, {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/octet-stream",
    },
    body: fileBytes,
  });

  if (submit.status !== 202) {
    const detail = await safeReadError(submit);
    throw new Error(`Document Intelligence analyze failed (${submit.status}). ${detail}`);
  }

  const operationLocation = submit.headers.get("operation-location");
  if (!operationLocation) {
    throw new Error("Document Intelligence did not return an operation-location to poll.");
  }

  // Poll the long-running operation until it succeeds (max ~90s).
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(1500);

    const poll = await fetch(operationLocation, {
      headers: await docIntelAuthHeaders(),
    });

    if (!poll.ok) {
      const detail = await safeReadError(poll);
      throw new Error(`Polling OCR result failed (${poll.status}). ${detail}`);
    }

    const result = (await poll.json()) as {
      status: string;
      analyzeResult?: { content?: string; pages?: unknown[] };
      error?: { message?: string };
    };

    if (result.status === "succeeded") {
      return {
        content: result.analyzeResult?.content ?? "",
        pages: result.analyzeResult?.pages?.length ?? 0,
      };
    }
    if (result.status === "failed") {
      throw new Error(`OCR failed: ${result.error?.message ?? "unknown error"}`);
    }
  }

  throw new Error("OCR timed out while waiting for Document Intelligence to finish.");
}

// ---------------------------------------------------------------------------
// 2. Translation via Azure AI Translator (Text Translation v3.0)
// ---------------------------------------------------------------------------

export interface TranslationResult {
  translated: string;
  detectedLanguage?: string;
}

interface TranslatorResponseItem {
  detectedLanguage?: { language: string; score: number };
  translations: { text: string; to: string }[];
}

/**
 * Builds Translator auth headers for either key or Entra ID mode.
 *  - Key mode: Ocp-Apim-Subscription-Key (+ region for multi-service/regional).
 *  - Entra ID mode (global endpoint): Authorization bearer + Ocp-Apim-ResourceId
 *    + Ocp-Apim-Subscription-Region.
 */
async function translatorAuthHeaders(): Promise<Record<string, string>> {
  const region = requireEnv("AZURE_TRANSLATOR_REGION");
  const key = optionalEnv("AZURE_TRANSLATOR_KEY");

  if (key) {
    return {
      "Ocp-Apim-Subscription-Key": key,
      "Ocp-Apim-Subscription-Region": region,
    };
  }

  const resourceId = requireEnv("AZURE_TRANSLATOR_RESOURCE_ID");
  return {
    Authorization: `Bearer ${await getEntraToken()}`,
    "Ocp-Apim-ResourceId": resourceId,
    "Ocp-Apim-Subscription-Region": region,
  };
}

/**
 * Translates text into the target language, preserving line structure.
 * Long documents are split into batches that respect the Translator limits.
 */
export async function translateText(
  text: string,
  to: string,
  from?: string
): Promise<TranslationResult> {
  return withSpan(
    "translate.text",
    () => translateTextImpl(text, to, from),
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "translation.provider": "translator-text",
        "translation.characters": text.length,
        "translation.to": to,
        "translation.from": from ?? "auto",
      },
    }
  );
}

async function translateTextImpl(
  text: string,
  to: string,
  from?: string
): Promise<TranslationResult> {
  const paragraphs = text.split("\n");
  const results: string[] = paragraphs.slice();
  let detectedLanguage: string | undefined;

  // Indices of paragraphs that actually contain text worth translating.
  const work = paragraphs
    .map((value, index) => ({ value, index }))
    .filter((item) => item.value.trim().length > 0);

  let batch: { index: number; value: string }[] = [];
  let batchChars = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const items = await postTranslate(
      batch.map((b) => b.value),
      to,
      from
    );
    items.forEach((item, i) => {
      results[batch[i].index] = item.translations[0]?.text ?? batch[i].value;
      if (!detectedLanguage) detectedLanguage = item.detectedLanguage?.language;
    });
    batch = [];
    batchChars = 0;
  };

  for (const item of work) {
    // A single very long paragraph must be hard-split on its own.
    if (item.value.length > MAX_CHARS_PER_REQUEST) {
      await flush();
      const pieces = hardSplit(item.value, MAX_CHARS_PER_REQUEST);
      const translatedPieces: string[] = [];
      for (const piece of pieces) {
        const [res] = await postTranslate([piece], to, from);
        translatedPieces.push(res.translations[0]?.text ?? piece);
        if (!detectedLanguage) detectedLanguage = res.detectedLanguage?.language;
      }
      results[item.index] = translatedPieces.join("");
      continue;
    }

    if (
      batchChars + item.value.length > MAX_CHARS_PER_REQUEST ||
      batch.length >= MAX_ELEMENTS_PER_REQUEST
    ) {
      await flush();
    }
    batch.push(item);
    batchChars += item.value.length;
  }

  await flush();

  return { translated: results.join("\n"), detectedLanguage };
}

async function postTranslate(
  texts: string[],
  to: string,
  from?: string
): Promise<TranslatorResponseItem[]> {
  const endpoint = trimSlash(
    process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com"
  );
  const auth = await translatorAuthHeaders();

  const params = new URLSearchParams({ "api-version": TRANSLATOR_API_VERSION, to });
  if (from && from !== "auto") params.set("from", from);

  const res = await fetch(`${endpoint}/translate?${params.toString()}`, {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(texts.map((Text) => ({ Text }))),
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`Translation failed (${res.status}). ${detail}`);
  }

  return (await res.json()) as TranslatorResponseItem[];
}

// ---------------------------------------------------------------------------
// 3. Layout-preserving translation via Azure Translator Document Translation
//    (synchronous single-document endpoint, hosted on the resource's custom
//    domain). Preserves tables, formatting and structure for documents, and
//    renders translated text back onto standalone images.
// ---------------------------------------------------------------------------

// Document formats supported by the SYNCHRONOUS document:translate endpoint.
// NOTE: PDF is intentionally NOT here. The synchronous endpoint rejects PDF with
// "The format parameter is not valid." (target: ContentType). PDF translation is
// only available through Azure's ASYNCHRONOUS batch API, which requires Blob
// Storage. Use Text view (OCR + text translation) for PDFs instead.
const DOCUMENT_CONTENT_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xlf: "application/xliff+xml",
};

// Standalone image formats -> require the newer api-version which renders the
// translated text back onto the image (the "camera translate" experience).
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  bmp: "image/bmp",
  webp: "image/webp",
};

const DOC_TRANSLATION_API_VERSION = "2024-05-01";
const IMAGE_TRANSLATION_API_VERSION = "2026-03-01";

export const LAYOUT_SUPPORTED_EXTENSIONS = [
  ...Object.keys(DOCUMENT_CONTENT_TYPES),
  ...Object.keys(IMAGE_CONTENT_TYPES),
];

/** Formats the sync endpoint can't do; surfaced with a helpful message. */
export const LAYOUT_PDF_MESSAGE =
  "Layout-preserving PDF translation isn't available here: Azure's synchronous Document Translation endpoint doesn't accept PDF (it requires the asynchronous batch API with Blob Storage). Your PDF works today in Text view — switch modes to translate it. In Preserve layout mode, DOCX, PPTX, XLSX, HTML and images keep their formatting.";

export interface DocumentTranslationResult {
  bytes: Buffer;
  contentType: string;
  /** True when the input was a standalone image rendered back with translation. */
  isImage: boolean;
  /** Actual characters billed by the batch Document Translation job, if known. */
  charactersCharged?: number;
}

/** Document Translation lives on the same resource endpoint as OCR. */
export async function documentTranslationAuthHeaders(): Promise<Record<string, string>> {
  const key =
    optionalEnv("AZURE_TRANSLATOR_KEY") ?? optionalEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY");
  if (key) return { "Ocp-Apim-Subscription-Key": key };
  return { Authorization: `Bearer ${await getEntraToken()}` };
}

/** Custom-domain endpoint hosting the Document Translation REST API. */
export function documentTranslationEndpoint(): string {
  return trimSlash(
    optionalEnv("AZURE_DOCUMENT_TRANSLATION_ENDPOINT") ??
      requireEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
  );
}

/** True when blob storage is configured, enabling batch (layout) PDF translation. */
export function isBatchTranslationConfigured(): boolean {
  return Boolean(
    optionalEnv("AZURE_STORAGE_BLOB_ENDPOINT") && optionalEnv("AZURE_STORAGE_ACCOUNT_NAME")
  );
}

/**
 * Translates a whole document (or image) while preserving its layout.
 * Returns the translated file bytes plus the content type to serve them with.
 */
export async function translateDocument(
  fileBytes: Buffer,
  fileExtension: string,
  to: string,
  from?: string
): Promise<DocumentTranslationResult> {
  return withSpan(
    "translate.document",
    async (span) => {
      const result = await translateDocumentImpl(fileBytes, fileExtension, to, from);
      span.setAttribute("translation.is_image", result.isImage);
      return result;
    },
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "translation.provider": "translator-document-sync",
        "translation.file_ext": fileExtension.toLowerCase().replace(/^\./, ""),
        "translation.file_bytes": fileBytes.length,
        "translation.to": to,
        "translation.from": from ?? "auto",
      },
    }
  );
}

async function translateDocumentImpl(
  fileBytes: Buffer,
  fileExtension: string,
  to: string,
  from?: string
): Promise<DocumentTranslationResult> {
  const ext = fileExtension.toLowerCase().replace(/^\./, "");

  // PDF needs the async batch API; give a clear, actionable message.
  if (ext === "pdf") {
    throw new Error(LAYOUT_PDF_MESSAGE);
  }

  const isImage = ext in IMAGE_CONTENT_TYPES;
  const contentType = isImage ? IMAGE_CONTENT_TYPES[ext] : DOCUMENT_CONTENT_TYPES[ext];

  if (!contentType) {
    throw new Error(
      `Layout-preserving translation does not support ".${ext}". Supported: ${LAYOUT_SUPPORTED_EXTENSIONS.join(", ")}.`
    );
  }

  const endpoint = trimSlash(
    optionalEnv("AZURE_DOCUMENT_TRANSLATION_ENDPOINT") ??
      requireEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
  );
  const apiVersion = isImage ? IMAGE_TRANSLATION_API_VERSION : DOC_TRANSLATION_API_VERSION;

  const params = new URLSearchParams({ "api-version": apiVersion, targetLanguage: to });
  if (from && from !== "auto") params.set("sourceLanguage", from);

  // Build a multipart/form-data body with the single `document` part.
  const form = new FormData();
  const blob = new Blob([new Uint8Array(fileBytes)], { type: contentType });
  form.append("document", blob, `document.${ext}`);

  const res = await fetch(
    `${endpoint}/translator/document:translate?${params.toString()}`,
    {
      method: "POST",
      headers: await documentTranslationAuthHeaders(),
      body: form,
    }
  );

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`Document translation failed (${res.status}). ${detail}`);
  }

  // Prefer our known MIME type so browsers render the result inline (the API
  // often returns a generic application/octet-stream).
  const responseType = res.headers.get("content-type");
  const outType =
    responseType && responseType !== "application/octet-stream"
      ? responseType
      : contentType;
  const out = Buffer.from(await res.arrayBuffer());
  return { bytes: out, contentType: outType, isImage };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hardSplit(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size));
  }
  return pieces;
}

async function safeReadError(res: Response): Promise<string> {
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
