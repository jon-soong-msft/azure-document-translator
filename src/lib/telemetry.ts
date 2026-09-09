/**
 * Structured translation telemetry for server-side monitoring.
 *
 * Every translation attempt emits ONE single-line JSON record to stdout
 * (stderr for failures). On Azure Container Apps these lines are captured by
 * the environment's Log Analytics workspace in the `ContainerAppConsoleLogs_CL`
 * table, so you can count completed vs failed translations and sum characters,
 * cost and processing time with KQL — no extra Azure resources required.
 *
 * The record shape is stable so it parses cleanly:
 *   {
 *     "ts": "2026-07-02T…Z", "event": "translation", "source": "doc-translator",
 *     "status": "started|completed|failed",
 *     "mode": "text|layout", "fileType": "pdf", "sizeBytes": 1343794,
 *     "to": "en", "from": "auto", "async": true, "chunks": 5, "pages": 14,
 *     "characters": 15941, "charactersCharged": 15941,
 *     "costUSD": 0.2391, "costEstimated": false,
 *     "processingMs": 41230, "httpStatus": 200,
 *     "error": "…", "errorType": "…"
 *   }
 *
 * Example KQL (last 24h): completed vs failed, characters, cost, avg time:
 *   ContainerAppConsoleLogs_CL
 *   | where TimeGenerated > ago(24h) and Log_s has '"event":"translation"'
 *   | extend d = parse_json(Log_s)
 *   | where tostring(d.event) == "translation"
 *   | summarize
 *       completed = countif(tostring(d.status) == "completed"),
 *       failed    = countif(tostring(d.status) == "failed"),
 *       characters = sum(tolong(d.characters)),
 *       costUSD    = round(sum(todouble(d.costUSD)), 4),
 *       avgMs      = avg(tolong(d.processingMs))
 *     by mode = tostring(d.mode)
 *
 * Set TELEMETRY_DISABLED=1 to turn logging off.
 */

import { metrics, type Attributes, type Counter } from "@opentelemetry/api";
import { buildEvaluation, type TranslationMode } from "./evaluation";
import { setActiveSpanAttributes, recordActiveSpanError } from "./tracing";

export type TranslationStatus = "started" | "completed" | "failed";

export interface TranslationTelemetry {
  status: TranslationStatus;
  mode: TranslationMode;
  /** File extension, e.g. "pdf", "docx". */
  fileType?: string;
  sizeBytes?: number;
  /** Target / source language codes. */
  to?: string;
  from?: string;
  /** True for the split/parallel large-PDF path. */
  async?: boolean;
  /** Number of parallel chunks (async PDF). */
  chunks?: number;
  /** Server-measured processing time in milliseconds. */
  processingMs?: number;
  /** HTTP status returned to the client. */
  httpStatus?: number;
  // --- Billing units (optional; used to derive cost for completed events) ---
  ocrPages?: number;
  sourceCharacters?: number;
  translatedCharacters?: number;
  charactersCharged?: number;
  images?: number;
  estimatedDocumentCharacters?: number;
  // --- Failure info ---
  error?: string;
  errorType?: string;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// Lazily-created counter; a no-op until the Azure Monitor distro registers a
// meter provider (e.g. no App Insights connection string in local dev).
let translationCounter: Counter | undefined;
function translationCount(): Counter {
  if (!translationCounter) {
    translationCounter = metrics
      .getMeter("doc-translator")
      .createCounter("translation.count", {
        description: "Count of translation attempts, dimensioned by status and mode.",
      });
  }
  return translationCounter;
}

/**
 * Emits one structured telemetry record for a translation attempt. Cost is
 * derived from whatever billing units are supplied (reusing the evaluation cost
 * model), so it's recorded even when the user hasn't opted into the on-screen
 * evaluation report. Never throws — telemetry must not break a request.
 */
export function logTranslation(t: TranslationTelemetry): void {
  if (process.env.TELEMETRY_DISABLED === "1") return;
  try {
    let costUSD: number | undefined;
    let costEstimated: boolean | undefined;
    let characters: number | undefined;
    let pages: number | undefined;
    let images: number | undefined;

    const hasUnits =
      t.ocrPages != null ||
      t.sourceCharacters != null ||
      t.charactersCharged != null ||
      t.images != null ||
      t.estimatedDocumentCharacters != null;

    if (t.status === "completed" && hasUnits) {
      const report = buildEvaluation({
        mode: t.mode,
        processingMs: t.processingMs ?? 0,
        ocrPages: t.ocrPages,
        sourceCharacters: t.sourceCharacters,
        translatedCharacters: t.translatedCharacters,
        charactersCharged: t.charactersCharged,
        images: t.images,
        estimatedDocumentCharacters: t.estimatedDocumentCharacters,
      });
      costUSD = round4(report.cost.totalUSD);
      costEstimated = report.cost.estimated;
      characters =
        report.characters.charged ??
        report.characters.source ??
        report.characters.translated;
      pages = report.pages;
      images = report.images;
    }

    // Mirror the record onto the active OpenTelemetry span and a metric so it's
    // queryable in Application Insights (requests/dependencies customDimensions
    // and the `translation.count` customMetric), alongside the stdout line that
    // Log Analytics captures. Best-effort: telemetry must never break a request.
    try {
      const attributes: Attributes = {
        "translation.status": t.status,
        "translation.mode": t.mode,
      };
      if (t.fileType) attributes["translation.file_type"] = t.fileType;
      if (t.sizeBytes != null) attributes["translation.size_bytes"] = t.sizeBytes;
      if (t.to) attributes["translation.to"] = t.to;
      if (t.from) attributes["translation.from"] = t.from;
      if (t.async != null) attributes["translation.async"] = t.async;
      if (characters != null) attributes["translation.characters"] = characters;
      if (costUSD != null) attributes["translation.cost_usd"] = costUSD;
      if (t.processingMs != null) attributes["translation.processing_ms"] = t.processingMs;
      if (t.httpStatus != null) attributes["translation.http_status"] = t.httpStatus;
      if (t.errorType) attributes["translation.error_type"] = t.errorType;
      setActiveSpanAttributes(attributes);
      if (t.status === "failed" && t.error) recordActiveSpanError(t.error);
      translationCount().add(1, {
        status: t.status,
        mode: t.mode,
        ...(t.fileType ? { file_type: t.fileType } : {}),
      });
    } catch {
      // Ignore: never let OpenTelemetry issues affect the response.
    }

    // JSON.stringify drops keys whose value is undefined, keeping lines compact.
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "translation",
      source: "doc-translator",
      status: t.status,
      mode: t.mode,
      fileType: t.fileType,
      sizeBytes: t.sizeBytes,
      to: t.to,
      from: t.from,
      async: t.async,
      chunks: t.chunks,
      pages,
      images,
      characters,
      charactersCharged: t.charactersCharged,
      costUSD,
      costEstimated,
      processingMs: t.processingMs,
      httpStatus: t.httpStatus,
      error: t.error ? String(t.error).slice(0, 300) : undefined,
      errorType: t.errorType,
    });

    if (t.status === "failed") console.error(line);
    else console.log(line);
  } catch {
    // Swallow — logging must never affect the translation response.
  }
}
