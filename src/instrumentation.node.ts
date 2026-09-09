/**
 * Initializes the Azure Monitor OpenTelemetry Distro so the app exports
 * end-to-end distributed traces, dependencies, logs, and metrics to Azure
 * Application Insights. Loaded once at server start (Node.js runtime only) from
 * `instrumentation.ts`, before the route handlers are imported, so the SDK can
 * instrument outgoing calls.
 *
 * This is a no-op unless `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, so
 * local development works without App Insights. In that case the OpenTelemetry
 * API stays a no-op and the tracing helpers (`src/lib/tracing.ts`) still run
 * their callbacks normally — nothing else changes.
 *
 * Once connected, you get in Application Insights:
 *   - `requests`     — one row per incoming HTTP request (named by route).
 *   - `dependencies` — outgoing Azure AI / Storage calls plus the custom spans
 *                      that model each pipeline step (OCR, translate, batch,
 *                      per-chunk submit/download, merge).
 *   - `customMetrics`— `translation.count` (by status + mode).
 *   - Application Map + end-to-end transaction view across the async PDF job.
 */
import {
  useAzureMonitor,
  type AzureMonitorOpenTelemetryOptions,
} from "@azure/monitor-opentelemetry";

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
  // Cloud Role Name on the Application Map (and to disambiguate if several
  // services report to the same App Insights resource). Overridable via env.
  if (!process.env.OTEL_SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = "doc-translator";
  }

  const options: AzureMonitorOpenTelemetryOptions = {
    azureMonitorExporterOptions: { connectionString },
    instrumentationOptions: {
      // Next.js already emits a `SpanKind.SERVER` span per request (named by
      // method + route) that becomes the Application Insights request, and it
      // instruments outgoing `fetch` (the Azure AI REST calls). Disable the
      // distro's own HTTP instrumentation so requests aren't double-counted.
      // The Azure SDK instrumentation still captures Storage dependencies, and
      // our custom spans (src/lib/tracing.ts) capture each pipeline step.
      http: { enabled: false },
      azureSdk: { enabled: true },
    },
    // Real-time Live Metrics stream — handy while demoing / troubleshooting.
    enableLiveMetrics: true,
  };

  useAzureMonitor(options);
}
