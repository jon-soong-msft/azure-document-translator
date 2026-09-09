/**
 * Copies the pinned pdf.js worker out of node_modules into ./public so the
 * browser can load it from a stable URL (`/pdf.worker.min.mjs`) in both
 * `next dev` and the standalone Docker build. Runs automatically via the
 * package.json `postinstall` hook, so the copied file is always in sync with
 * the installed pdfjs-dist version (and need not be committed).
 */
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const destDir = path.join(root, "public");
const dest = path.join(destDir, "pdf.worker.min.mjs");

try {
  if (!existsSync(source)) {
    console.warn(`[copy-pdf-worker] source not found, skipping: ${source}`);
    process.exit(0);
  }
  await mkdir(destDir, { recursive: true });
  await copyFile(source, dest);
  console.log("[copy-pdf-worker] copied pdf.js worker -> public/pdf.worker.min.mjs");
} catch (err) {
  // Never fail install/build because of this best-effort copy.
  console.warn(`[copy-pdf-worker] skipped: ${err?.message ?? err}`);
  process.exit(0);
}
