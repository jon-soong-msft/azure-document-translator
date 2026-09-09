import { NextRequest, NextResponse } from "next/server";
import {
  getPdfJobStatus,
  JobTokenError,
  StorageUnreachableError,
} from "@/lib/batch";
import { logTranslation } from "@/lib/telemetry";

// Polling should return quickly; it only checks each chunk's job status.
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Progress endpoint for the async split-PDF job. The client posts the signed
 * job token it got from POST /api/translate-document (202) and gets back
 * `{ status, done, total, error? }` until every chunk has finished.
 */
export async function POST(req: NextRequest) {
  try {
    const { token } = (await req.json().catch(() => ({}))) as { token?: string };
    if (!token) {
      return NextResponse.json({ error: "Missing job token." }, { status: 400 });
    }

    const status = await getPdfJobStatus(token);
    if (status.status === "failed") {
      logTranslation({
        status: "failed",
        mode: "layout",
        async: true,
        errorType: "batch_failed",
        error: status.error,
        processingMs: status.startedAt ? Date.now() - status.startedAt : undefined,
        httpStatus: 200,
      });
    }
    return NextResponse.json(status, { status: 200 });
  } catch (err) {
    if (err instanceof JobTokenError) {
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
