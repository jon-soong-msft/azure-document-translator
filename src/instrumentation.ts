/**
 * Next.js instrumentation hook — runs once when a server instance starts,
 * before any request is handled (https://nextjs.org/docs/app/guides/open-telemetry).
 *
 * The Azure Monitor OpenTelemetry Distro is Node-only, so it is imported lazily
 * and only in the Node.js runtime. The auth middleware runs in the Edge runtime,
 * which must never load the Node SDK — hence the `NEXT_RUNTIME` guard.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
