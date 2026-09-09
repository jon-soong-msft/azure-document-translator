/**
 * OpenTelemetry helpers for end-to-end distributed tracing.
 *
 * Spans created here are exported to Azure Application Insights by the Azure
 * Monitor OpenTelemetry Distro configured in `../instrumentation.node.ts`.
 * When no connection string is set (e.g. local dev without App Insights), the
 * OpenTelemetry API is a no-op: `withSpan` still runs its callback and the
 * attribute/context helpers do nothing. They are therefore always safe to call.
 *
 * The custom spans model each step of the translation pipeline (OCR, translate,
 * batch submit/poll/download, merge) so the App Insights transaction view shows
 * how long each activity takes. For the large-PDF async job — which spans a
 * submit request, several status polls, and a final result request — the submit
 * captures its W3C trace context into the signed job token so the final
 * `translate.pdf.finish` span rejoins the original trace, giving one end-to-end
 * distributed transaction.
 */
import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

const TRACER_NAME = "doc-translator";

/** The app's shared tracer. */
export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export interface WithSpanOptions {
  attributes?: Attributes;
  kind?: SpanKind;
  /** Parent context (e.g. rebuilt from a job token) to attach the span to. */
  parent?: Context;
}

/**
 * Runs `fn` inside a span that is ended automatically. Exceptions are recorded
 * on the span and the status set to ERROR before rethrowing, so failures show
 * up in Application Insights with their stack — the caller's behavior is
 * otherwise unchanged.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options: WithSpanOptions = {}
): Promise<T> {
  const parentCtx = options.parent ?? context.active();
  return context.with(parentCtx, () =>
    getTracer().startActiveSpan(
      name,
      { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes },
      async (span) => {
        try {
          return await fn(span);
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      }
    )
  );
}

/** Sets attributes on the currently active span, if any (no-op otherwise). */
export function setActiveSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** Records an exception on the active span and marks it errored (no-op if none). */
export function recordActiveSpanError(err: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.recordException(
    err instanceof Error ? err : { name: "Error", message: String(err) }
  );
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Opaque W3C trace-context carrier embedded in async job tokens. */
export type TraceCarrier = Record<string, string>;

/**
 * Serializes the active trace context (W3C `traceparent`) into a carrier so it
 * can be embedded in a signed job token and later used to rejoin the trace.
 */
export function captureTraceContext(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Rebuilds a parent context from a carrier previously produced by
 * {@link captureTraceContext}, or `undefined` when there's nothing to rejoin.
 */
export function contextFromCarrier(carrier: TraceCarrier | undefined): Context | undefined {
  if (!carrier || Object.keys(carrier).length === 0) return undefined;
  return propagation.extract(context.active(), carrier);
}
