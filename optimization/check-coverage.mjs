/**
 * Coverage check: does turning image-text OFF lose any translation on this file?
 *
 * The conditional-image-text idea turns `translateTextWithinImage` OFF for chunks
 * with no raster images. That is only safe if the OFF output translates just as
 * much as the ON output on those pages. To verify, we re-OCR both already-saved
 * translated PDFs (optimization/results/image-{on,off}/output.pdf) with Document
 * Intelligence (prebuilt-read) and count residual Japanese characters per page,
 * aggregated per 3-page chunk. Equal residual => OFF loses nothing => conditional
 * is lossless. More residual on OFF => image-text ON was catching real text there.
 *
 * Pure read of the two output PDFs + DI OCR (no storage, no translation). Needs
 * `az login`. Uses the same DI endpoint/version as scripts/evaluate.mjs.
 *
 * Usage:  node optimization/check-coverage.mjs [--pages 3]
 */

import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DefaultAzureCredential } from "@azure/identity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const PAGES_PER_CHUNK = Number(args.pages ?? 3);

const ON_PDF = path.join(__dirname, "results", "image-on", "output.pdf");
const OFF_PDF = path.join(__dirname, "results", "image-off", "output.pdf");
const OUT_JSON = path.join(__dirname, "results", "coverage-check.json");

const DI_API_VERSION = "2024-11-30";
const SCOPE = "https://cognitiveservices.azure.com/.default";
// Japanese script: Hiragana, Katakana, CJK ideographs, halfwidth Katakana.
const JP_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F]/g;
const countJa = (s) => (s.match(JP_RE) || []).length;

loadDotenv(azdEnvFile(repoRoot), ["AZURE_CLIENT_ID"]);
const trimSlash = (u) => u.replace(/\/+$/, "");
function reqEnv(n) {
  const v = process.env[n];
  if (!v || v.startsWith("<")) throw new Error(`Missing env var ${n}`);
  return v;
}
const DI_ENDPOINT = trimSlash(reqEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const credential = new DefaultAzureCredential();
let tok;
async function bearer() {
  if (!tok || tok.expiresOnTimestamp - Date.now() < 5 * 60 * 1000) tok = await credential.getToken(SCOPE);
  return tok.token;
}

/** OCR a PDF, return per-page Japanese counts (1-based page index). */
async function ocrPerPage(bytes) {
  const url = `${DI_ENDPOINT}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${DI_API_VERSION}`;
  const submit = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (submit.status !== 202) throw new Error(`OCR submit ${submit.status}: ${(await submit.text()).slice(0, 200)}`);
  const op = submit.headers.get("operation-location");
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const poll = await fetch(op, { headers: { Authorization: `Bearer ${await bearer()}` } });
    if (!poll.ok) continue;
    const body = await poll.json();
    if (body.status === "succeeded") {
      const pages = body.analyzeResult?.pages ?? [];
      return pages.map((p) => {
        const text = (p.lines ?? []).map((l) => l.content).join("\n");
        return { page: p.pageNumber, ja: countJa(text), chars: text.length };
      });
    }
    if (body.status === "failed") throw new Error(`OCR failed: ${JSON.stringify(body.error)}`);
  }
  throw new Error("OCR timed out");
}

function toChunks(perPage, total) {
  const n = Math.ceil(total / PAGES_PER_CHUNK);
  const out = [];
  for (let c = 0; c < n; c++) {
    const start = c * PAGES_PER_CHUNK;
    const slice = perPage.filter((p) => p.page > start && p.page <= start + PAGES_PER_CHUNK);
    out.push({
      chunk: c,
      pages: `${start + 1}-${Math.min(start + PAGES_PER_CHUNK, total)}`,
      ja: slice.reduce((a, b) => a + b.ja, 0),
    });
  }
  return out;
}

async function main() {
  if (!existsSync(ON_PDF) || !existsSync(OFF_PDF)) {
    throw new Error("Missing output.pdf files. Run perf-test-translation.mjs for both --image on and --image off first.");
  }
  console.log("Re-OCRing both translated outputs (residual Japanese = untranslated)...\n");
  const [onBytes, offBytes] = await Promise.all([readFile(ON_PDF), readFile(OFF_PDF)]);
  const [onPages, offPages] = await Promise.all([ocrPerPage(onBytes), ocrPerPage(offBytes)]);

  const total = Math.max(onPages.length, offPages.length);
  const onChunks = toChunks(onPages, total);
  const offChunks = toChunks(offPages, total);

  const onJa = onPages.reduce((a, b) => a + b.ja, 0);
  const offJa = offPages.reduce((a, b) => a + b.ja, 0);

  console.log("Residual Japanese characters per chunk (lower = more fully translated):");
  console.log("chunk  pages    image-text ON   image-text OFF   delta(OFF-ON)");
  for (let c = 0; c < onChunks.length; c++) {
    const on = onChunks[c].ja, off = offChunks[c]?.ja ?? 0, d = off - on;
    const flag = d > 20 ? "  <-- OFF leaves more" : "";
    console.log(
      `  ${String(c).padEnd(4)} ${onChunks[c].pages.padEnd(7)} ${String(on).padStart(11)}   ${String(off).padStart(13)}   ${String(d >= 0 ? "+" + d : d).padStart(12)}${flag}`
    );
  }
  console.log(`\n  TOTAL residual JA:  ON ${onJa}   OFF ${offJa}   delta ${offJa - onJa >= 0 ? "+" : ""}${offJa - onJa}`);

  const verdict =
    offJa - onJa <= 30
      ? "OFF matches ON coverage -> conditional (image chunks ON, text chunks OFF) is effectively LOSSLESS on this file."
      : "OFF leaves noticeably more Japanese -> image-text ON is catching real text; conditional would degrade those pages.";
  console.log(`\nVerdict: ${verdict}`);

  await writeFile(
    OUT_JSON,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), pagesPerChunk: PAGES_PER_CHUNK, onJa, offJa, onChunks, offChunks, onPages, offPages },
      null,
      2
    )
  );
  console.log(`Data: ${OUT_JSON}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
/**
 * Locate the active azd environment's .env file, without hard-coding an
 * environment name. Prefers the default recorded in .azure/config.json, then
 * falls back to the sole environment directory if there is exactly one.
 */
function azdEnvFile(root) {
  const azureDir = path.join(root, ".azure");
  if (!existsSync(azureDir)) return null;

  const configPath = path.join(azureDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const name = JSON.parse(readFileSync(configPath, "utf8"))?.defaultEnvironment;
      if (name) {
        const file = path.join(azureDir, name, ".env");
        if (existsSync(file)) return file;
      }
    } catch {
      // fall through to directory scan
    }
  }

  const envDirs = readdirSync(azureDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(azureDir, d.name, ".env")))
    .map((d) => d.name);
  return envDirs.length === 1 ? path.join(azureDir, envDirs[0], ".env") : null;
}

function loadDotenv(file, skip = []) {
  if (!file || !existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (skip.includes(key) || process.env[key] !== undefined) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env[key] = val;
  }
}

main().catch((e) => {
  console.error("\nCoverage check failed:", e?.message ?? e);
  process.exitCode = 1;
});
