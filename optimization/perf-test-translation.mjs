/**
 * Performance test + tracing harness for the layout-preserving PDF translation
 * pipeline (the async split / parallel / merge path implemented in
 * src/lib/batch.ts: startPdfBatchJob -> getPdfJobStatus -> finishPdfBatchJob).
 *
 * It mirrors the production steps EXACTLY (same split size, same batch request
 * body with top-level `options.translateTextWithinImage`, same 4s poll cadence,
 * same manual streamed blob download) but wraps every process / activity / task
 * in a span so we can see, per "thread" (the main pipeline + each parallel
 * chunk), how long each step takes. It then writes, into
 * optimization/results/image-{on|off}/ (one folder per mode so ON and OFF runs
 * never overwrite each other):
 *
 *   - trace.json    raw span trace (source of truth)
 *   - report.html   self-contained waterfall / threads report
 *   - output.pdf    the merged translated PDF (validation)
 *
 * Local only; hits the LIVE Azure resources. Needs `az login` and the storage
 * account reachable (public network access enabled). Auth + endpoints are read
 * from the active azd environment's .env (loaded below) or the ambient
 * environment.
 *
 * Usage (run from the repo root) — `--file` is required; supply your own PDF:
 *   node optimization/perf-test-translation.mjs --file path/to/your.pdf
 *   node optimization/perf-test-translation.mjs --file path/to/your.pdf --pages 3 --image on --to en --from ja
 *
 * NOTE: running this against a dense multi-page PDF takes several minutes and
 * incurs real Document Translation character charges (image-text ON by default,
 * matching the production default).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { PDFDocument } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Config (defaults mirror the production pipeline)
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error(
    "Missing --file. This repo ships no sample documents; point it at your own PDF:\n" +
      "  node optimization/perf-test-translation.mjs --file path/to/your.pdf"
  );
  process.exit(1);
}
const PDF_PATH = path.resolve(repoRoot, args.file);
const PAGES_PER_CHUNK = Number(args.pages ?? 3); // matches PAGES_PER_CHUNK in batch.ts
const IMAGE_TEXT = String(args.image ?? "on").toLowerCase() !== "off";
const TO = args.to ?? "en";
const FROM = args.from ?? "ja";
const POLL_INTERVAL_MS = 4000; // client polls /status every 4s (page.tsx pollLayoutJob)
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 min safety cap
const SCOPE = "https://cognitiveservices.azure.com/.default";
const API_VERSION = IMAGE_TEXT ? "2026-03-01" : "2024-05-01"; // batchApiVersion()

// Output folder: results/[label/]image-{on|off}. A `--label` keeps a document's
// runs in their own subfolder so different PDFs don't overwrite each other; with
// no label the runs stay flat (the original the 24-page sample findings location).
const LABEL = typeof args.label === "string" ? args.label : "";
const OUT_DIR = path.join(
  __dirname,
  "results",
  ...(LABEL ? [LABEL] : []),
  IMAGE_TEXT ? "image-on" : "image-off"
);
const OUT_PDF = path.join(OUT_DIR, "output.pdf");
const OUT_TRACE = path.join(OUT_DIR, "trace.json");
const OUT_HTML = path.join(OUT_DIR, "report.html");

// Load the azd environment's .env without overriding real env. We skip
// AZURE_CLIENT_ID so DefaultAzureCredential doesn't lock onto a user-assigned
// managed identity that only exists in the deployed container -> falls back to
// the Azure CLI credential (`az login`) locally.
loadDotenv(azdEnvFile(repoRoot), ["AZURE_CLIENT_ID"]);

const trimSlash = (u) => u.replace(/\/+$/, "");
function reqEnv(name) {
  const v = process.env[name];
  if (!v || v.startsWith("<")) throw new Error(`Missing env var ${name}`);
  return v;
}
const DOC_ENDPOINT = trimSlash(
  process.env.AZURE_DOCUMENT_TRANSLATION_ENDPOINT ||
    reqEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
);
const BLOB_ENDPOINT = reqEnv("AZURE_STORAGE_BLOB_ENDPOINT");
const SRC_CONTAINER = reqEnv("AZURE_STORAGE_SOURCE_CONTAINER");
const TGT_CONTAINER = reqEnv("AZURE_STORAGE_TARGET_CONTAINER");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Timing is credential-independent (token fetched once, cached, and measured as
// its own span); production uses the same DefaultAzureCredential class.
const credential = new DefaultAzureCredential();
const blobService = new BlobServiceClient(BLOB_ENDPOINT, credential);
const srcContainer = blobService.getContainerClient(SRC_CONTAINER);
const tgtContainer = blobService.getContainerClient(TGT_CONTAINER);

let tokenCache;
async function bearer() {
  const now = Date.now();
  if (!tokenCache || tokenCache.expiresOnTimestamp - now < 5 * 60 * 1000) {
    tokenCache = await credential.getToken(SCOPE);
  }
  return tokenCache.token;
}
async function authHeaders() {
  return { Authorization: `Bearer ${await bearer()}` };
}

// ---------------------------------------------------------------------------
// Span tracing
// ---------------------------------------------------------------------------
const RUN_T0 = performance.now();
const WALL_START = new Date();
const spans = [];
function span(thread, cat, name, meta = {}) {
  const s = { thread, cat, name, meta, t0: performance.now() - RUN_T0, t1: null, dur: null };
  spans.push(s);
  return {
    raw: s,
    end(extra) {
      s.t1 = performance.now() - RUN_T0;
      s.dur = s.t1 - s.t0;
      if (extra) Object.assign(s.meta, extra);
      return s;
    },
  };
}
async function timed(thread, cat, name, meta, fn) {
  const sp = span(thread, cat, name, meta);
  try {
    const r = await fn();
    sp.end();
    return r;
  } catch (e) {
    sp.end({ error: String(e?.message ?? e) });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Pipeline steps (faithful copies of the batch.ts internals)
// ---------------------------------------------------------------------------
async function splitPdfTraced(bytes) {
  const sp = span("main", "activity", "split-pdf", {});
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const total = src.getPageCount();
  const chunks = [];
  for (let start = 0; start < total; start += PAGES_PER_CHUNK) {
    const end = Math.min(start + PAGES_PER_CHUNK, total);
    const csp = span("main", "task", `split p${start + 1}-${end}`, { p0: start, n: end - start });
    const doc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const pages = await doc.copyPages(src, indices);
    pages.forEach((p) => doc.addPage(p));
    const out = Buffer.from(await doc.save());
    csp.end({ bytes: out.length });
    chunks.push({ bytes: out, p0: start, n: end - start });
  }
  sp.end({ total, chunkCount: chunks.length });
  return { chunks, total };
}

async function uploadBlob(name, bytes) {
  const blob = srcContainer.getBlockBlobClient(name);
  await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: "application/pdf" } });
}

async function postBatch(name, to, from) {
  const srcBlob = srcContainer.getBlockBlobClient(name);
  const tgtBlob = tgtContainer.getBlockBlobClient(name);
  const targetInput = { targetUrl: tgtBlob.url, language: to };
  const sourceInput = { sourceUrl: srcBlob.url };
  if (from && from !== "auto") sourceInput.language = from;

  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(`${DOC_ENDPOINT}/translator/document/batches?api-version=${API_VERSION}`, {
        method: "POST",
        headers: { ...(await authHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: [{ storageType: "File", source: sourceInput, targets: [targetInput] }],
          // Top-level sibling of `inputs` (matches batch.ts + Azure schema).
          options: { translateTextWithinImage: IMAGE_TEXT },
        }),
      });
    } catch {
      await sleep(3000);
      continue;
    }
    if (res.status === 429) {
      await sleep(5000);
      continue;
    }
    if (res.status !== 202) throw new Error(`submit ${res.status}: ${await safeErr(res)}`);
    const op = res.headers.get("operation-location");
    if (!op) throw new Error("batch submit returned no operation-location");
    return op;
  }
  throw new Error("batch submit exhausted retries");
}

async function pollOnce(op) {
  let res;
  try {
    res = await fetch(op, { headers: await authHeaders() });
  } catch {
    return { status: "running" };
  }
  if (!res.ok) return { status: "running" };
  const b = await res.json();
  return {
    status: (b.status ?? "running").toLowerCase(),
    chars: b.summary?.totalCharacterCharged,
    error: b.error,
  };
}

async function downloadToBuffer(blob) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await blob.download(0, undefined, { maxRetryRequests: 3 });
      const stream = resp.readableStreamBody;
      if (!stream) throw new Error("empty download stream");
      const parts = [];
      for await (const part of stream) parts.push(typeof part === "string" ? Buffer.from(part) : part);
      return Buffer.concat(parts);
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function mergePdfs(buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf, { updateMetadata: false });
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(PDF_PATH)) throw new Error(`File not found: ${PDF_PATH}`);
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Perf test: ${path.basename(PDF_PATH)}`);
  console.log(
    `  pages/chunk=${PAGES_PER_CHUNK}  imageText=${IMAGE_TEXT}  api=${API_VERSION}  ${FROM}->${TO}`
  );

  const root = span("total", "total", "wall-clock", {
    file: path.basename(PDF_PATH),
    pagesPerChunk: PAGES_PER_CHUNK,
    imageText: IMAGE_TEXT,
    apiVersion: API_VERSION,
    to: TO,
    from: FROM,
  });

  const bytes = await timed("main", "activity", "read-file", {}, () => readFile(PDF_PATH));
  root.raw.meta.fileBytes = bytes.length;
  console.log(`  file: ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);

  await timed("main", "activity", "auth-token", {}, async () => {
    await bearer();
  });

  const { chunks, total } = await splitPdfTraced(bytes);
  console.log(`  split: ${total} pages -> ${chunks.length} chunks`);

  // PHASE A: startPdfBatchJob (parallel upload + submit per chunk)
  const phaseA = span("phase", "phase", "A: submit (startPdfBatchJob)", {});
  const names = chunks.map(() => `${randomUUID()}.pdf`);
  const submitted = await Promise.all(
    chunks.map(async (c, i) => {
      await timed(`chunk-${i}`, "task", "upload-blob", { bytes: c.bytes.length, pages: c.n }, () =>
        uploadBlob(names[i], c.bytes)
      );
      const op = await timed(`chunk-${i}`, "task", "submit-batch", { pages: c.n }, () =>
        postBatch(names[i], TO, FROM)
      );
      return { op, name: names[i], i, p0: c.p0, n: c.n };
    })
  );
  phaseA.end();
  console.log(`  submitted ${submitted.length} batch jobs (+${sec()})`);

  // Per-chunk "process-azure" spans start when that chunk's job was accepted.
  const procSpans = submitted.map((s) =>
    span(`chunk-${s.i}`, "azure", "process-azure", { pages: s.n })
  );
  const doneStatus = new Array(submitted.length).fill(null);
  const charsPer = new Array(submitted.length).fill(undefined);

  // PHASE B: getPdfJobStatus poll loop (centralized, every 4s, all chunks)
  const phaseB = span("phase", "phase", "B: poll (getPdfJobStatus)", {});
  let rounds = 0;
  const waitStart = performance.now();
  while (doneStatus.some((d) => d === null)) {
    if (performance.now() - waitStart > MAX_WAIT_MS) throw new Error("poll loop timed out");
    await sleep(POLL_INTERVAL_MS);
    rounds++;
    const pending = submitted.map((_, i) => i).filter((i) => doneStatus[i] === null);
    const states = await Promise.all(pending.map((i) => pollOnce(submitted[i].op)));
    states.forEach((st, k) => {
      const i = pending[k];
      if (st.status === "succeeded" || st.status === "failed") {
        doneStatus[i] = st.status;
        charsPer[i] = st.chars;
        procSpans[i].end({ status: st.status, chars: st.chars, error: st.error?.message });
      }
    });
    const done = doneStatus.filter((d) => d !== null).length;
    console.log(`  [poll ${rounds}] ${done}/${submitted.length} done (+${sec()})`);
  }
  phaseB.end({ rounds });

  // PHASE C: finishPdfBatchJob (download + ordered merge). We measure the
  // download two ways to characterize the /result route:
  //   C1 sequential — EXACTLY what finishPdfBatchJob does today (for-loop await),
  //   C2 parallel   — the proposed fix (Promise.all), timed on the same blobs.
  const phaseC = span("phase", "phase", "C: download+merge (finishPdfBatchJob)", {});
  const okIdx = submitted.map((_, i) => i).filter((i) => doneStatus[i] === "succeeded");

  const seqSpan = span("main", "activity", "download-sequential (/result today)", {});
  const seqBufs = {};
  for (const i of okIdx) {
    // Per-chunk spans keep the "download-blob" name so the per-chunk table still
    // populates; being sequential, they stagger in the waterfall (the point).
    seqBufs[i] = await timed(`chunk-${i}`, "task", "download-blob", {}, () =>
      downloadToBuffer(tgtContainer.getBlockBlobClient(submitted[i].name))
    );
  }
  const totalDownloadBytes = Object.values(seqBufs).reduce((a, b) => a + b.length, 0);
  seqSpan.end({ bytes: totalDownloadBytes, chunks: okIdx.length });

  const parSpan = span("main", "activity", "download-parallel (proposed fix)", {});
  await Promise.all(
    okIdx.map((i) => downloadToBuffer(tgtContainer.getBlockBlobClient(submitted[i].name)))
  );
  parSpan.end({ bytes: totalDownloadBytes, chunks: okIdx.length });

  const ok = okIdx
    .map((i) => ({ i, p0: submitted[i].p0, buf: seqBufs[i], bytes: seqBufs[i].length }))
    .sort((a, b) => a.p0 - b.p0);
  const merged = await timed("main", "activity", "merge-pdfs", { count: ok.length }, () =>
    mergePdfs(ok.map((o) => o.buf))
  );
  phaseC.end({ seqMs: seqSpan.raw.dur, parMs: parSpan.raw.dur });
  console.log(
    `  download: sequential ${fmtDur(seqSpan.raw.dur)} vs parallel ${fmtDur(parSpan.raw.dur)} ` +
      `(${(totalDownloadBytes / 1024 / 1024).toFixed(1)} MB over ${okIdx.length} chunks)`
  );

  await timed("main", "activity", "write-output", { bytes: merged.length }, () =>
    writeFile(OUT_PDF, merged)
  );

  // Cleanup (measured but off the critical path).
  await timed("main", "activity", "cleanup-blobs", {}, async () => {
    await Promise.allSettled(
      submitted.flatMap((s) => [
        srcContainer.getBlockBlobClient(s.name).deleteIfExists(),
        tgtContainer.getBlockBlobClient(s.name).deleteIfExists(),
      ])
    );
  });

  let mergedPages = null;
  try {
    mergedPages = (await PDFDocument.load(merged, { updateMetadata: false })).getPageCount();
  } catch {
    /* non-fatal */
  }

  const charactersCharged = charsPer.reduce((a, b) => a + (b || 0), 0);
  root.end({
    totalPages: total,
    chunkCount: chunks.length,
    charactersCharged,
    outputBytes: merged.length,
    mergedPages,
    failedChunks: doneStatus.filter((d) => d === "failed").length,
    validPdf: merged.subarray(0, 5).toString("latin1") === "%PDF-",
  });

  // Attach per-chunk download bytes to the download spans' meta for the report.
  const dlSeq = spans.find((s) => s.name.startsWith("download-sequential"));
  const dlPar = spans.find((s) => s.name.startsWith("download-parallel"));
  const trace = {
    generatedAt: new Date().toISOString(),
    wallStart: WALL_START.toISOString(),
    config: {
      file: path.basename(PDF_PATH),
      label: LABEL || null,
      fileBytes: bytes.length,
      pagesPerChunk: PAGES_PER_CHUNK,
      imageText: IMAGE_TEXT,
      apiVersion: API_VERSION,
      to: TO,
      from: FROM,
      totalPages: total,
      chunkCount: chunks.length,
      charactersCharged,
      costUSD: +(charactersCharged * 15 / 1e6).toFixed(4), // Doc Translation $15/1M chars
      outputBytes: merged.length,
      mergedPages,
      pollRounds: rounds,
      downloadSeqMs: dlSeq ? Math.round(dlSeq.dur) : null,
      downloadParMs: dlPar ? Math.round(dlPar.dur) : null,
      validPdf: root.raw.meta.validPdf,
      endpoint: DOC_ENDPOINT,
    },
    spans,
  };

  await writeFile(OUT_TRACE, JSON.stringify(trace, null, 2));
  await writeFile(OUT_HTML, renderHtml(trace));

  console.log("\nDone.");
  console.log(`  wall clock       : ${fmtDur(root.raw.dur)}`);
  console.log(`  characters charged: ${charactersCharged.toLocaleString()} (US$${trace.config.costUSD})`);
  console.log(`  output           : ${(merged.length / 1024 / 1024).toFixed(2)} MB, ${mergedPages} pages, valid=${trace.config.validPdf}`);
  if (trace.config.downloadSeqMs != null) {
    console.log(`  /result download : sequential ${fmtDur(trace.config.downloadSeqMs)} -> parallel ${fmtDur(trace.config.downloadParMs)} (proposed fix)`);
  }
  console.log(`  trace  : ${OUT_TRACE}`);
  console.log(`  report : ${OUT_HTML}`);
}

function sec() {
  return `${((performance.now() - RUN_T0) / 1000).toFixed(0)}s`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.includes("=")) {
      const [k, v] = key.split(/=(.*)/s);
      out[k] = v;
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[key] = argv[++i];
    } else {
      out[key] = true;
    }
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
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (skip.includes(key) || process.env[key] !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

async function safeErr(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function fmtDur(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------
function renderHtml(trace) {
  // Embedded in a <script type="application/json"> block; escaping every '<'
  // as \u003c keeps it valid JSON (only appears inside string values) and makes
  // a </script> breakout impossible, regardless of quotes/backslashes/newlines.
  const json = JSON.stringify(trace).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Translation pipeline perf trace - ${escapeHtml(trace.config.file)}</title>
<style>
  :root{
    --bg:#0b1020; --panel:#131a2e; --panel2:#0f1526; --line:#243149; --ink:#e6ecf7;
    --muted:#93a2c0; --total:#64748b; --phase:#a855f7; --activity:#3b82f6; --task:#14b8a6; --azure:#f59e0b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#0b1020,#0a0e1c);color:var(--ink);
    font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1240px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 10px;color:#c8d4ea}
  .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
  .cfg{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}
  .chip{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:12px;color:#c8d4ea}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:8px}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .kpi .v{font-size:22px;font-weight:650} .kpi .l{color:var(--muted);font-size:12px;margin-top:3px}
  .kpi.warn .v{color:var(--azure)} .kpi.good .v{color:#34d399}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin:6px 0 14px;color:var(--muted);font-size:12px}
  .legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
  .gaxis{position:relative;height:16px;margin-left:150px;color:var(--muted);font-size:11px}
  .gaxis .t{position:absolute;transform:translateX(-50%)}
  .gwrap{display:flex}
  .glabels{width:150px;flex:none}
  .glabel{height:30px;display:flex;align-items:center;font-size:12px;color:#c8d4ea;
    border-top:1px solid var(--line);padding-right:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .glabel.grp{color:#8ea3c9;font-weight:600}
  .gplot{position:relative;flex:1;border-left:1px solid var(--line)}
  .grid{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.05)}
  .lanebg{position:absolute;left:0;right:0;height:30px;border-top:1px solid var(--line)}
  .bar{position:absolute;height:22px;min-width:2px;border-radius:4px;top:4px;overflow:hidden;
    font-size:10px;line-height:22px;color:#04122b;padding:0 5px;white-space:nowrap;cursor:default}
  .bar.total{background:var(--total);color:#e6ecf7} .bar.phase{background:var(--phase);color:#f6ecff}
  .bar.activity{background:var(--activity);color:#eaf1ff} .bar.task{background:var(--task)}
  .bar.azure{background:var(--azure)}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
  th{color:#9db0d4;font-weight:600;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--panel)}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  tr:hover td{background:rgba(255,255,255,.03)}
  .pill{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:#c8d4ea}
  .tag{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:-1px}
  .foot{color:var(--muted);font-size:11.5px;margin-top:18px}
  .tblwrap{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:12px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Translation pipeline - performance trace</h1>
  <div class="sub" id="sub"></div>
  <div class="cfg" id="cfg"></div>

  <h2>Summary</h2>
  <div class="kpis" id="kpis"></div>

  <h2>Threads &amp; traces (waterfall)</h2>
  <div class="panel">
    <div class="legend">
      <span><i style="background:var(--total)"></i>wall clock</span>
      <span><i style="background:var(--phase)"></i>phase</span>
      <span><i style="background:var(--activity)"></i>activity (main)</span>
      <span><i style="background:var(--task)"></i>task</span>
      <span><i style="background:var(--azure)"></i>azure translation</span>
    </div>
    <div class="gaxis" id="gaxis"></div>
    <div class="gwrap">
      <div class="glabels" id="glabels"></div>
      <div class="gplot" id="gplot"></div>
    </div>
  </div>

  <h2>Per-chunk breakdown</h2>
  <div class="tblwrap"><table id="chunkTbl"></table></div>

  <h2>All spans</h2>
  <div class="tblwrap"><table id="spanTbl"></table></div>

  <div class="foot" id="foot"></div>
</div>

<script id="trace-data" type="application/json">${json}</script>
<script>
const DATA = JSON.parse(document.getElementById('trace-data').textContent);
const C = DATA.config, S = DATA.spans;
const COL = {total:'var(--total)',phase:'var(--phase)',activity:'var(--activity)',task:'var(--task)',azure:'var(--azure)'};
const totalMs = Math.max.apply(null, S.map(s=>s.t1||0));

function fmtDur(ms){ if(ms==null) return '-'; if(ms<1000) return Math.round(ms)+'ms';
  const s=ms/1000; if(s<60) return s.toFixed(1)+'s'; const m=Math.floor(s/60); return m+'m'+Math.round(s-m*60)+'s'; }
function fmtClock(ms){ const s=Math.floor(ms/1000), m=Math.floor(s/60);
  return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function mb(b){ return (b/1048576).toFixed(2)+' MB'; }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function metaStr(m){ return Object.keys(m||{}).filter(k=>k!=='error')
  .map(k=>k+'='+(typeof m[k]==='number'?m[k].toLocaleString():m[k])).join('  '); }

// ---- header / config ----
document.getElementById('sub').textContent =
  C.file+'  -  '+mb(C.fileBytes)+', '+C.totalPages+' pages  -  run '+new Date(DATA.wallStart).toLocaleString();
const cfg = [['pages/chunk',C.pagesPerChunk],['chunks',C.chunkCount],['image-text',C.imageText?'ON':'off'],
  ['api',C.apiVersion],['route',C.from+' -> '+C.to],['poll rounds',C.pollRounds]];
document.getElementById('cfg').innerHTML = cfg.map(([k,v])=>'<span class="chip">'+k+': <b>'+esc(v)+'</b></span>').join('');

// ---- KPIs ----
const wall = S.find(s=>s.thread==='total');
const azure = S.filter(s=>s.cat==='azure');
const slow = azure.reduce((a,b)=>(b.dur>a.dur?b:a), azure[0]||{dur:0});
const fast = azure.reduce((a,b)=>(b.dur<a.dur?b:a), azure[0]||{dur:0});
const avgAz = azure.length? azure.reduce((a,b)=>a+b.dur,0)/azure.length : 0;
const find = n => S.find(s=>s.thread==='main'&&s.name===n) || {dur:0};
const phase = n => S.find(s=>s.thread==='phase'&&s.name.indexOf(n)===0) || {dur:0};
const kpis = [
  ['wall clock', fmtDur(wall?.dur), 'total', 'good'],
  ['split', fmtDur(find('split-pdf').dur), C.chunkCount+' chunks',''],
  ['submit phase', fmtDur(phase('A').dur), 'upload + POST',''],
  ['poll phase', fmtDur(phase('B').dur), C.pollRounds+' rounds x 4s',''],
  ['download+merge', fmtDur(phase('C').dur), '',''],
  ['/result download', fmtDur(C.downloadSeqMs)+' seq', 'vs '+fmtDur(C.downloadParMs)+' parallel','warn'],
  ['slowest chunk', fmtDur(slow.dur), 'chunk-'+(azure.indexOf(slow))+' (critical path)','warn'],
  ['fastest chunk', fmtDur(fast.dur), '',''],
  ['avg chunk', fmtDur(avgAz), 'Azure translate',''],
  ['characters', (C.charactersCharged||0).toLocaleString(), 'US$'+C.costUSD,''],
  ['output', mb(C.outputBytes), (C.mergedPages||'?')+' pages',''],
];
document.getElementById('kpis').innerHTML = kpis.map(([l,v,s,cl])=>
  '<div class="kpi '+(cl||'')+'"><div class="v">'+esc(v)+'</div><div class="l">'+esc(l)+
  (s?' &middot; '+esc(s):'')+'</div></div>').join('');

// ---- waterfall ----
const order = ['total','phase','main'];
const chunkThreads = [...new Set(S.map(s=>s.thread))].filter(t=>t.indexOf('chunk-')===0)
  .sort((a,b)=>(+a.split('-')[1])-(+b.split('-')[1]));
const threads = order.filter(t=>S.some(s=>s.thread===t)).concat(chunkThreads);
const ROW=30;
const labels = document.getElementById('glabels');
const plot = document.getElementById('gplot');
plot.style.height = threads.length*ROW+'px';
labels.innerHTML = threads.map(t=>'<div class="glabel'+(t==='total'?' grp':'')+'">'+esc(t)+'</div>').join('');

// gridlines + axis
const steps=[5,10,15,30,60,120,300,600];
let step=steps[steps.length-1];
for(const s of steps){ if(totalMs/1000/s<=12){ step=s; break; } }
let axis='', grid='';
for(let t=0;t<=totalMs/1000;t+=step){
  const x=(t*1000/totalMs)*100;
  axis+='<div class="t" style="left:'+x+'%">'+fmtClock(t*1000)+'</div>';
  grid+='<div class="grid" style="left:'+x+'%"></div>';
}
document.getElementById('gaxis').innerHTML=axis;

let bars=grid;
threads.forEach((t,i)=>{ bars+='<div class="lanebg" style="top:'+(i*ROW)+'px"></div>'; });
S.forEach(s=>{
  const i=threads.indexOf(s.thread); if(i<0||s.t1==null) return;
  const l=(s.t0/totalMs)*100, w=Math.max((s.dur/totalMs)*100,0.15);
  const tip=s.thread+' | '+s.cat+' | '+s.name+'\\n'+fmtClock(s.t0)+' -> '+fmtClock(s.t1)+
    '  (dur '+fmtDur(s.dur)+')'+(metaStr(s.meta)?'\\n'+metaStr(s.meta):'')+
    (s.meta&&s.meta.error?'\\nERROR: '+s.meta.error:'');
  const label=(s.dur/totalMs>0.05)?esc(s.name):'';
  bars+='<div class="bar '+s.cat+'" style="left:'+l+'%;width:'+w+'%;top:'+(i*ROW+4)+'px" title="'+esc(tip)+'">'+label+'</div>';
});
plot.innerHTML=bars;

// ---- per-chunk table ----
const chunkRows = chunkThreads.map(t=>{
  const i=+t.split('-')[1];
  const g=n=>S.find(s=>s.thread===t&&s.name===n)||{};
  const up=g('upload-blob'), sub=g('submit-batch'), az=g('process-azure'), dl=g('download-blob');
  return {i,pages:az.meta?.pages,up:up.dur,sub:sub.dur,az:az.dur,dl:dl.dur,
    chars:az.meta?.chars,status:az.meta?.status,dlbytes:dl.meta?.bytes};
});
const maxAz = Math.max.apply(null, chunkRows.map(r=>r.az||0));
document.getElementById('chunkTbl').innerHTML =
  '<thead><tr><th>chunk</th><th class="n">pages</th><th class="n">upload</th><th class="n">submit</th>'+
  '<th class="n">azure translate</th><th class="n">download</th><th class="n">chars</th><th>status</th></tr></thead><tbody>'+
  chunkRows.map(r=>'<tr><td>chunk-'+r.i+(r.az===maxAz?' <span class="pill">critical</span>':'')+'</td>'+
    '<td class="n">'+(r.pages??'-')+'</td><td class="n">'+fmtDur(r.up)+'</td><td class="n">'+fmtDur(r.sub)+'</td>'+
    '<td class="n">'+fmtDur(r.az)+'</td><td class="n">'+fmtDur(r.dl)+'</td>'+
    '<td class="n">'+(r.chars?r.chars.toLocaleString():'-')+'</td><td>'+esc(r.status||'-')+'</td></tr>').join('')+
  '</tbody>';

// ---- all spans table (sortable) ----
let sortKey='t0', sortDir=1;
function renderSpans(){
  const rows=[...S].sort((a,b)=>{
    const va=a[sortKey]??a.meta?.[sortKey]??0, vb=b[sortKey]??b.meta?.[sortKey]??0;
    return (va>vb?1:va<vb?-1:0)*sortDir;
  });
  document.getElementById('spanTbl').innerHTML =
    '<thead><tr>'+['thread','cat','name','t0','dur','meta'].map(h=>
      '<th data-k="'+({t0:'t0',dur:'dur'}[h]||h)+'">'+h+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(s=>'<tr><td>'+esc(s.thread)+'</td><td><span class="tag" style="background:'+COL[s.cat]+'"></span>'+
      esc(s.cat)+'</td><td>'+esc(s.name)+'</td><td class="n">'+fmtClock(s.t0)+'</td>'+
      '<td class="n">'+fmtDur(s.dur)+'</td><td style="color:var(--muted)">'+esc(metaStr(s.meta))+
      (s.meta&&s.meta.error?' <span style="color:var(--azure)">'+esc(s.meta.error)+'</span>':'')+
      '</td></tr>').join('')+'</tbody>';
  document.querySelectorAll('#spanTbl th').forEach(th=>th.onclick=()=>{
    const k=th.dataset.k; if(k===sortKey) sortDir*=-1; else {sortKey=k;sortDir=1;} renderSpans();
  });
}
renderSpans();

document.getElementById('foot').textContent =
  'Faithful replica of the src/lib/batch.ts async split path (startPdfBatchJob -> getPdfJobStatus -> finishPdfBatchJob). '+
  'Threads = the main pipeline plus one lane per parallel chunk job. Generated '+new Date(DATA.generatedAt).toLocaleString()+'.';
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

main().catch((e) => {
  console.error("\nPerf test failed:", e?.message ?? e);
  process.exitCode = 1;
});
