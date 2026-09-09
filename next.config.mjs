/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained server build for a small Docker image.
  output: "standalone",
  eslint: {
    // This is a demo app; don't fail the production build on lint.
    ignoreDuringBuilds: true,
  },
  // Keep the Azure Monitor OpenTelemetry Distro (and the OpenTelemetry API) out
  // of the webpack bundle. The distro instruments modules by patching them at
  // require-time, which only works when it's loaded from node_modules rather
  // than bundled. Marking `@opentelemetry/api` external too guarantees the app
  // code and the distro share ONE api instance, so the global tracer provider
  // the distro registers is the same one our spans resolve — otherwise our
  // spans would silently no-op. These are traced into the standalone output.
  serverExternalPackages: ["@azure/monitor-opentelemetry", "@opentelemetry/api"],
  experimental: {
    // This app uses middleware (the auth gate) on the upload API routes. When
    // middleware is present, Next.js buffers a copy of the request body in
    // memory so both middleware and the route handler can read it, capped at
    // 10MB by default. Larger uploads get truncated to 10MB, which corrupts the
    // multipart payload and makes `request.formData()` throw "Failed to parse
    // body as FormData". Keep this above the largest allowed upload (Azure's
    // batch limit is 40MB; the app's own size cap is set at or below that), with
    // headroom for multipart encoding overhead, so big PDFs pass through intact.
    // NOTE: pinned to Next 15.x where this option is `middlewareClientMaxBodySize`;
    // Next 16 renamed it to `proxyClientMaxBodySize`.
    middlewareClientMaxBodySize: 45 * 1024 * 1024, // 45 MB
  },
};

export default nextConfig;
