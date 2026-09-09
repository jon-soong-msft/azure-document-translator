import { NextRequest, NextResponse } from "next/server";
import { extractTextWithMeta, translateText } from "@/lib/azure";
import { buildEvaluation, type EvaluationReport } from "@/lib/evaluation";
import { isEvaluationEnabled } from "@/lib/evaluation-config";
import { logTranslation } from "@/lib/telemetry";

// OCR + translation can take a while for large PDFs.
export const maxDuration = 120;
export const runtime = "nodejs";

// Document Intelligence OCR accepts up to 500 MB / 2000 pages, but the app
// buffers the upload in memory on a small (1 GiB) container, so we keep a
// prudent 40 MB cap (also matching the layout PDF batch limit).
const MAX_FILE_BYTES = 40 * 1024 * 1024; // 40 MB

const ALLOWED_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "bmp",
  "heif",
  "docx",
  "xlsx",
  "pptx",
  "html",
  "htm",
];

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const targetLanguage = String(formData.get("targetLanguage") || "en");
    const sourceLanguage = String(formData.get("sourceLanguage") || "auto");
    // Evaluation is opt-in (toggle) and only when enabled at the platform level.
    const evaluate =
      String(formData.get("evaluate") || "") === "1" && isEvaluationEnabled();

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      logTranslation({
        status: "failed",
        mode: "text",
        fileType: ext,
        sizeBytes: file.size,
        errorType: "unsupported_type",
        httpStatus: 400,
      });
      return NextResponse.json(
        {
          error: `Unsupported file type ".${ext}". Supported: ${ALLOWED_EXTENSIONS.join(", ")}.`,
        },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_BYTES) {
      logTranslation({
        status: "failed",
        mode: "text",
        fileType: ext,
        sizeBytes: file.size,
        errorType: "file_too_large",
        httpStatus: 400,
      });
      return NextResponse.json(
        { error: "File is too large. Maximum size is 40 MB." },
        { status: 400 }
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    const startedAt = Date.now();

    // 1. OCR / text extraction (page count is reused for cost evaluation).
    const { content: original, pages } = await extractTextWithMeta(bytes);

    if (!original.trim()) {
      logTranslation({
        status: "failed",
        mode: "text",
        fileType: ext,
        sizeBytes: file.size,
        errorType: "no_text",
        httpStatus: 422,
      });
      return NextResponse.json(
        { error: "No text could be extracted from this document." },
        { status: 422 }
      );
    }

    // 2. Translation
    const { translated, detectedLanguage } = await translateText(
      original,
      targetLanguage,
      sourceLanguage
    );

    const processingMs = Date.now() - startedAt;

    logTranslation({
      status: "completed",
      mode: "text",
      fileType: ext,
      sizeBytes: file.size,
      to: targetLanguage,
      from: sourceLanguage,
      processingMs,
      ocrPages: pages,
      sourceCharacters: original.length,
      translatedCharacters: translated.length,
      httpStatus: 200,
    });

    // 3. Optional evaluation report — built from units already measured above,
    //    so it adds no extra Azure calls in Text view.
    let evaluation: EvaluationReport | undefined;
    if (evaluate) {
      evaluation = buildEvaluation({
        mode: "text",
        processingMs,
        ocrPages: pages,
        sourceCharacters: original.length,
        translatedCharacters: translated.length,
      });
    }

    return NextResponse.json({
      fileName: file.name,
      original,
      translated,
      detectedLanguage,
      targetLanguage,
      evaluation,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected server error.";
    logTranslation({
      status: "failed",
      mode: "text",
      errorType: "server_error",
      error: message,
      httpStatus: 500,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
