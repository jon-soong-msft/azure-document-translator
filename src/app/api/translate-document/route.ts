import { NextRequest, NextResponse } from "next/server";
import {
  translateDocument,
  extractTextWithMeta,
  LAYOUT_SUPPORTED_EXTENSIONS,
  LAYOUT_PDF_MESSAGE,
  isBatchTranslationConfigured,
} from "@/lib/azure";
import {
  translatePdfBatch,
  StorageUnreachableError,
  getPdfPageCount,
  shouldUseAsyncPdf,
  startPdfBatchJob,
} from "@/lib/batch";
import { buildEvaluation, type EvaluationReport } from "@/lib/evaluation";
import { isEvaluationEnabled } from "@/lib/evaluation-config";
import { logTranslation } from "@/lib/telemetry";

// Document translation can take a while for large files.
export const maxDuration = 120;
export const runtime = "nodejs";

// Reject oversized files with a clear message before they ever reach Azure.
// Azure Document Translation's own per-file limits are 40 MB for the async/
// batch endpoint (PDF) and 10 MB for the sync endpoint (other formats). We cap
// PDFs a little below that for now; raise MAX_PDF_BYTES toward 40 MB to allow
// larger files (keep next.config's middlewareClientMaxBodySize above whatever
// value you choose).
const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB (batch; Azure allows up to 40 MB)
const MAX_SYNC_BYTES = 10 * 1024 * 1024; // 10 MB (sync)

// Standalone images are billed per image; text-based formats can be measured by
// decoding their bytes; everything else (docx/pptx/xlsx) needs OCR to count
// characters for the (estimated) cost.
const IMAGE_EXTS = ["png", "jpg", "jpeg", "bmp", "webp"];
const TEXT_DECODE_EXTS = ["html", "htm", "txt", "csv", "tsv", "xlf"];

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const targetLanguage = String(formData.get("targetLanguage") || "en");
    const sourceLanguage = String(formData.get("sourceLanguage") || "auto");
    // Whether to also translate text baked into images (charts/figures/stamps).
    // Defaults on; the UI can turn it off for cleaner, faster digital-only output.
    const translateImageText = String(formData.get("translateImageText") || "1") !== "0";
    // Evaluation is opt-in (toggle) and only when enabled at the platform level.
    const evaluate =
      String(formData.get("evaluate") || "") === "1" && isEvaluationEnabled();

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const isPdf = ext === "pdf";

    // PDF needs the async batch API + blob storage. If storage isn't configured,
    // explain that PDFs work in Text view instead.
    if (isPdf && !isBatchTranslationConfigured()) {
      logTranslation({
        status: "failed",
        mode: "layout",
        fileType: ext,
        sizeBytes: file.size,
        errorType: "pdf_storage_unconfigured",
        httpStatus: 415,
      });
      return NextResponse.json({ error: LAYOUT_PDF_MESSAGE }, { status: 415 });
    }

    if (!isPdf && !LAYOUT_SUPPORTED_EXTENSIONS.includes(ext)) {
      logTranslation({
        status: "failed",
        mode: "layout",
        fileType: ext,
        sizeBytes: file.size,
        errorType: "unsupported_type",
        httpStatus: 415,
      });
      return NextResponse.json(
        {
          error: `Unsupported file type ".${ext}" for layout-preserving translation. Supported: pdf, ${LAYOUT_SUPPORTED_EXTENSIONS.join(", ")}.`,
        },
        { status: 415 }
      );
    }

    const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_SYNC_BYTES;
    if (file.size > maxBytes) {
      const maxMb = Math.round(maxBytes / (1024 * 1024));
      logTranslation({
        status: "failed",
        mode: "layout",
        fileType: ext,
        sizeBytes: file.size,
        errorType: "file_too_large",
        httpStatus: 400,
      });
      return NextResponse.json(
        { error: `File is too large. Maximum size is ${maxMb} MB for this format.` },
        { status: 400 }
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // Large or dense PDFs take minutes to translate (Document Intelligence +
    // image-text re-render) — too long to hold this request open. Split them
    // into parallel batch jobs and hand back a token the client polls.
    if (isPdf) {
      const pageCount = await getPdfPageCount(bytes);
      if (shouldUseAsyncPdf(bytes, pageCount)) {
        const dot = file.name.lastIndexOf(".");
        const base = dot > 0 ? file.name.slice(0, dot) : file.name;
        const job = await startPdfBatchJob(
          bytes,
          file.name,
          targetLanguage,
          sourceLanguage === "auto" ? undefined : sourceLanguage,
          evaluate,
          translateImageText
        );
        logTranslation({
          status: "started",
          mode: "layout",
          fileType: ext,
          sizeBytes: file.size,
          to: targetLanguage,
          from: sourceLanguage,
          async: true,
          chunks: job.chunkCount,
          httpStatus: 202,
        });
        return NextResponse.json(
          {
            async: true,
            token: job.token,
            totalPages: job.totalPages,
            chunks: job.chunkCount,
            translatedFilename: `${base}.${targetLanguage}.pdf`,
          },
          { status: 202 }
        );
      }
    }

    const startedAt = Date.now();
    const result = isPdf
      ? await translatePdfBatch(bytes, targetLanguage, sourceLanguage, translateImageText)
      : await translateDocument(bytes, ext, targetLanguage, sourceLanguage);
    const processingMs = Date.now() - startedAt;

    // Build a sensible translated file name: name.ext -> name.<lang>.ext
    const dot = file.name.lastIndexOf(".");
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const translatedName = `${base}.${targetLanguage}.${ext}`;

    // Optional evaluation report. Different file types bill differently, so the
    // billing basis is chosen per type. For non-PDF documents an extra OCR pass
    // is only run when evaluation is requested.
    let evaluation: EvaluationReport | undefined;
    if (evaluate) {
      if (isPdf) {
        evaluation =
          result.charactersCharged != null
            ? buildEvaluation({
                mode: "layout",
                processingMs,
                charactersCharged: result.charactersCharged,
              })
            : buildEvaluation({
                mode: "layout",
                processingMs,
                estimatedDocumentCharacters: (await extractTextWithMeta(bytes))
                  .content.length,
              });
      } else if (IMAGE_EXTS.includes(ext)) {
        evaluation = buildEvaluation({ mode: "layout", processingMs, images: 1 });
      } else {
        const characters = TEXT_DECODE_EXTS.includes(ext)
          ? bytes.toString("utf8").length
          : (await extractTextWithMeta(bytes)).content.length;
        evaluation = buildEvaluation({
          mode: "layout",
          processingMs,
          estimatedDocumentCharacters: characters,
        });
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": result.contentType,
      "Content-Disposition": `inline; filename="${encodeURIComponent(translatedName)}"`,
      "X-Translated-Filename": encodeURIComponent(translatedName),
      "X-Is-Image": result.isImage ? "1" : "0",
    };
    if (evaluation) {
      // URL-encoded JSON keeps the header ASCII-safe (no user content inside).
      headers["X-Evaluation"] = encodeURIComponent(JSON.stringify(evaluation));
    }

    const isImageFile = IMAGE_EXTS.includes(ext);
    logTranslation({
      status: "completed",
      mode: "layout",
      fileType: ext,
      sizeBytes: file.size,
      to: targetLanguage,
      from: sourceLanguage,
      async: false,
      processingMs,
      // PDF batch reports actual billed characters; images bill per image; text
      // formats can be counted from their bytes. Office docs (docx/pptx/xlsx)
      // would need an extra OCR pass to count, so cost is left unknown here
      // rather than adding a billable call just for telemetry.
      charactersCharged: isPdf ? result.charactersCharged : undefined,
      images: isImageFile ? 1 : undefined,
      estimatedDocumentCharacters:
        !isPdf && !isImageFile && TEXT_DECODE_EXTS.includes(ext)
          ? bytes.toString("utf8").length
          : undefined,
      httpStatus: 200,
    });

    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers,
    });
  } catch (err) {
    // Storage being unreachable (e.g. public network access disabled) is an
    // environment/config issue, not a server bug — surface it as 502 with a
    // clear, actionable message rather than a generic 500.
    if (err instanceof StorageUnreachableError) {
      logTranslation({
        status: "failed",
        mode: "layout",
        errorType: "storage_unreachable",
        error: err.message,
        httpStatus: 502,
      });
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : "Unexpected server error.";
    logTranslation({
      status: "failed",
      mode: "layout",
      errorType: "server_error",
      error: message,
      httpStatus: 500,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
