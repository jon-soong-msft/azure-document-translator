import { NextRequest, NextResponse } from "next/server";
import {
  finishPdfBatchJob,
  JobTokenError,
  StorageUnreachableError,
} from "@/lib/batch";
import { buildEvaluation } from "@/lib/evaluation";
import { logTranslation } from "@/lib/telemetry";

// Downloading + merging every translated chunk can take a little while.
export const maxDuration = 120;
export const runtime = "nodejs";

/**
 * Result endpoint for the async split-PDF job. Once POST /status reports
 * "succeeded", the client posts the token here and receives the merged
 * translated PDF — the same response shape (binary + headers) as the
 * synchronous layout path, so the client can read it identically.
 */
export async function POST(req: NextRequest) {
  try {
    const { token } = (await req.json().catch(() => ({}))) as { token?: string };
    if (!token) {
      return NextResponse.json({ error: "Missing job token." }, { status: 400 });
    }

    const { result, fileName, to, processingMs, evaluate } =
      await finishPdfBatchJob(token);

    // Build a sensible translated file name: name.pdf -> name.<lang>.pdf
    const dot = fileName.lastIndexOf(".");
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const translatedName = `${base}.${to}.pdf`;

    const headers: Record<string, string> = {
      "Content-Type": result.contentType,
      "Content-Disposition": `inline; filename="${encodeURIComponent(translatedName)}"`,
      "X-Translated-Filename": encodeURIComponent(translatedName),
      "X-Is-Image": result.isImage ? "1" : "0",
    };

    // Evaluation was requested (and platform-gated) at submit time; the batch
    // job summary gives the actual billed characters, so this is exact.
    if (evaluate) {
      const evaluation = buildEvaluation({
        mode: "layout",
        processingMs,
        charactersCharged: result.charactersCharged ?? 0,
      });
      headers["X-Evaluation"] = encodeURIComponent(JSON.stringify(evaluation));
    }

    logTranslation({
      status: "completed",
      mode: "layout",
      fileType: "pdf",
      to,
      async: true,
      processingMs,
      charactersCharged: result.charactersCharged ?? 0,
      httpStatus: 200,
    });

    return new NextResponse(new Uint8Array(result.bytes), { status: 200, headers });
  } catch (err) {
    if (err instanceof JobTokenError) {
      logTranslation({
        status: "failed",
        mode: "layout",
        async: true,
        errorType: "invalid_token",
        error: err.message,
        httpStatus: 400,
      });
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof StorageUnreachableError) {
      logTranslation({
        status: "failed",
        mode: "layout",
        async: true,
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
      async: true,
      errorType: "server_error",
      error: message,
      httpStatus: 500,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
