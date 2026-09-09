import { NextResponse } from "next/server";
import { isBatchTranslationConfigured } from "@/lib/azure";
import { isEvaluationEnabled } from "@/lib/evaluation-config";

export const runtime = "nodejs";

/** Lightweight feature-flags the client uses to adapt the UI. */
export async function GET() {
  return NextResponse.json({
    // When true, PDFs can be translated in Preserve layout mode (batch API).
    batchPdf: isBatchTranslationConfigured(),
    // When true, the optional per-translation evaluation report is available.
    evaluationEnabled: isEvaluationEnabled(),
  });
}
