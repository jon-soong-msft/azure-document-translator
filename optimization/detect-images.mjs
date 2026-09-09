/**
 * Conditional image-text analysis for the layout-preserving PDF pipeline.
 *
 * Two questions:
 *   1. Which chunks (3-page ranges) actually contain raster images? In
 *      particular chunk-5 (pages 16-18), the critical-path chunk in the
 *      image-text ON run.
 *   2. If we turned `translateTextWithinImage` ON only for chunks that contain
 *      images and OFF for text-only chunks (the cheapest possible per-chunk
 *      detection), what would happen to wall-clock and cost?
 *
 * This is pure local analysis: it parses the PDF for image XObjects with pdf-lib
 * (no OCR, no rendering, no Azure calls) and combines the detection with the two
 * measured traces already in optimization/results/{image-on,image-off}. It
 * writes optimization/results/conditional-image-text.json and prints a summary.
 *
 * IMPORTANT NUANCE: "contains an image" is only a proxy for "contains image
 * *text*". We can't know whether an image has text baked in without OCR-ing it
 * (which is the very cost we're trying to avoid). So the model is conservative:
 * any chunk with a raster image keeps image-text ON. That means the projection
 * is a BEST CASE for the conditional approach's speed-up (it never wrongly turns
 * a text-bearing image chunk OFF).
 *
 * Usage:  node optimization/detect-images.mjs [--file "documents/sample-24page-ja.pdf"] [--pages 3]
 */

import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PDFDocument, PDFName, PDFDict, PDFStream } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error(
    "Missing --file. This repo ships no sample documents; point it at your own PDF:\n" +
      "  node optimization/detect-images.mjs --file path/to/your.pdf"
  );
  process.exit(1);
}
const PDF_PATH = path.resolve(repoRoot, args.file);
const PAGES_PER_CHUNK = Number(args.pages ?? 3);
const DOC_TRANSLATION_USD_PER_M = 15; // "S1 Document Characters" $15 / 1M
const ON_TRACE = path.join(__dirname, "results", "image-on", "trace.json");
const OFF_TRACE = path.join(__dirname, "results", "image-off", "trace.json");
const OUT_JSON = path.join(__dirname, "results", "conditional-image-text.json");

// ---------------------------------------------------------------------------
// Image detection (XObject traversal, recurses into Form XObjects)
// ---------------------------------------------------------------------------
function getResources(page) {
  const ctx = page.doc.context;
  const node = page.node;
  try {
    if (typeof node.Resources === "function") {
      const r = node.Resources();
      if (r) return r;
    }
  } catch {}
  try {
    const resolved = ctx.lookup(node.get(PDFName.of("Resources")), PDFDict);
    if (resolved) return resolved;
  } catch {}
  try {
    if (typeof node.getInheritableAttribute === "function") {
      return ctx.lookup(node.getInheritableAttribute(PDFName.of("Resources")), PDFDict);
    }
  } catch {}
  return undefined;
}

function numOf(dict, key) {
  try {
    const v = dict.get(PDFName.of(key));
    return v && typeof v.asNumber === "function" ? v.asNumber() : null;
  } catch {
    return null;
  }
}

/** Returns the image XObjects reachable from a page (deduped by object ref). */
function pageImages(page) {
  const ctx = page.doc.context;
  const images = new Map(); // refKey -> {w,h,bytes}
  const visitedForms = new Set();

  function walk(resources, depth) {
    if (!resources || depth > 12) return;
    let xobj;
    try {
      xobj = resources.lookup(PDFName.of("XObject"), PDFDict);
    } catch {
      xobj = undefined;
    }
    if (!xobj) return;
    for (const [, value] of xobj.entries()) {
      let stream;
      try {
        stream = ctx.lookup(value);
      } catch {
        continue;
      }
      if (!(stream instanceof PDFStream)) continue;
      const dict = stream.dict;
      let sub = "";
      try {
        const s = dict.get(PDFName.of("Subtype"));
        sub = s ? s.toString() : "";
      } catch {}
      const key = value.toString();
      if (sub === "/Image") {
        if (images.has(key)) continue;
        const bytes = (stream.contents && stream.contents.length) || 0;
        images.set(key, { w: numOf(dict, "Width"), h: numOf(dict, "Height"), bytes });
      } else if (sub === "/Form") {
        if (visitedForms.has(key)) continue;
        visitedForms.add(key);
        let formRes;
        try {
          formRes = dict.lookup(PDFName.of("Resources"), PDFDict);
        } catch {}
        walk(formRes, depth + 1);
      }
    }
  }

  walk(getResources(page), 0);
  return [...images.values()];
}

// ---------------------------------------------------------------------------
// Trace helpers
// ---------------------------------------------------------------------------
function chunkStats(tracePath) {
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  const map = {};
  for (const s of trace.spans) {
    if (s.thread && s.thread.startsWith("chunk-") && s.name === "process-azure") {
      const i = Number(s.thread.split("-")[1]);
      map[i] = { durMs: s.dur, chars: s.meta?.chars ?? 0, pages: s.meta?.pages };
    }
  }
  return { config: trace.config, chunks: map };
}

/** Wall-clock model: fixed overhead (everything except the poll wait) + the
 *  slowest chunk. The fixed overhead is calibrated from the ON trace in main(),
 *  then we swap in a different "slowest chunk" for the projection. */
function fmt(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}
const usd = (chars) => (chars * DOC_TRANSLATION_USD_PER_M) / 1e6;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(PDF_PATH)) throw new Error(`File not found: ${PDF_PATH}`);
  if (!existsSync(ON_TRACE) || !existsSync(OFF_TRACE)) {
    throw new Error("Missing traces. Run perf-test-translation.mjs for both --image on and --image off first.");
  }

  const bytes = await readFile(PDF_PATH);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const totalPages = pages.length;

  // Per-page image detection.
  const perPage = pages.map((p, i) => {
    const imgs = pageImages(p);
    return {
      page: i + 1,
      images: imgs.length,
      imageBytes: imgs.reduce((a, b) => a + b.bytes, 0),
      maxDim: imgs.reduce((a, b) => Math.max(a, (b.w || 0) * (b.h || 0)), 0),
    };
  });

  // Whole-doc cross-check via indirect-object enumeration.
  let enumImages = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      try {
        const s = obj.dict.get(PDFName.of("Subtype"));
        if (s && s.toString() === "/Image") enumImages++;
      } catch {}
    }
  }

  // Aggregate to chunks.
  const on = chunkStats(ON_TRACE);
  const off = chunkStats(OFF_TRACE);
  const chunkCount = Math.ceil(totalPages / PAGES_PER_CHUNK);
  const chunks = [];
  for (let c = 0; c < chunkCount; c++) {
    const start = c * PAGES_PER_CHUNK;
    const end = Math.min(start + PAGES_PER_CHUNK, totalPages);
    const slice = perPage.slice(start, end);
    const images = slice.reduce((a, b) => a + b.images, 0);
    const imageBytes = slice.reduce((a, b) => a + b.imageBytes, 0);
    chunks.push({
      chunk: c,
      pages: `${start + 1}-${end}`,
      images,
      imageBytes,
      pagesWithImages: slice.filter((p) => p.images > 0).map((p) => p.page),
      hasImages: images > 0,
      onMs: on.chunks[c]?.durMs,
      offMs: off.chunks[c]?.durMs,
      onChars: on.chunks[c]?.chars,
      offChars: off.chunks[c]?.chars,
    });
  }

  // Wall-clock model calibrated from the ON trace: fixed overhead = total minus
  // the poll-phase wait; the poll wait itself ~= the slowest chunk's azure time.
  const onTrace = JSON.parse(readFileSync(ON_TRACE, "utf8"));
  const wall = (spans) => Math.max(...spans.map((s) => s.t1 || 0));
  const onWallMs = wall(onTrace.spans);
  const onMaxChunk = Math.max(...chunks.map((c) => c.onMs || 0));
  const fixedOverheadMs = onWallMs - onMaxChunk; // split+auth+submit+download+merge + poll granularity

  const offTrace = JSON.parse(readFileSync(OFF_TRACE, "utf8"));
  const offWallMs = wall(offTrace.spans);

  // Conditional projection: image chunks -> ON time/chars, text-only -> OFF.
  const condChunkMs = chunks.map((c) => (c.hasImages ? c.onMs : c.offMs) || 0);
  const condMaxChunk = Math.max(...condChunkMs);
  const condWallMs = fixedOverheadMs + condMaxChunk;
  const condChars = chunks.reduce((a, c) => a + ((c.hasImages ? c.onChars : c.offChars) || 0), 0);

  const onChars = chunks.reduce((a, c) => a + (c.onChars || 0), 0);
  const offChars = chunks.reduce((a, c) => a + (c.offChars || 0), 0);
  const imageChunks = chunks.filter((c) => c.hasImages);
  const textChunks = chunks.filter((c) => !c.hasImages);

  const result = {
    generatedAt: new Date().toISOString(),
    file: path.basename(PDF_PATH),
    totalPages,
    pagesPerChunk: PAGES_PER_CHUNK,
    chunkCount,
    detection: {
      method: "pdf-lib XObject traversal (recurses Form XObjects), deduped by object ref",
      totalImageXObjectsEnumerated: enumImages,
      pagesWithImages: perPage.filter((p) => p.images > 0).length,
      note: "Inline images (BI/ID/EI) are not counted; scanned PDFs use XObjects.",
    },
    chunks,
    imageChunkIndexes: imageChunks.map((c) => c.chunk),
    textChunkIndexes: textChunks.map((c) => c.chunk),
    model: {
      fixedOverheadMs,
      onWallMs,
      offWallMs,
      condWallMs,
      onMaxChunkMs: onMaxChunk,
      condMaxChunkMs: condMaxChunk,
      onCriticalChunk: chunks.findIndex((c) => c.onMs === onMaxChunk),
      condCriticalChunk: condChunkMs.findIndex((v) => v === condMaxChunk),
    },
    cost: {
      onChars,
      offChars,
      condChars,
      onUSD: +usd(onChars).toFixed(4),
      offUSD: +usd(offChars).toFixed(4),
      condUSD: +usd(condChars).toFixed(4),
    },
  };

  await writeFile(OUT_JSON, JSON.stringify(result, null, 2));

  // ---- console summary ----
  const c5 = chunks[5];
  console.log(`\nFile: ${result.file}  (${totalPages} pages, ${chunkCount} chunks of ${PAGES_PER_CHUNK})`);
  console.log(`Image XObjects (whole doc): ${enumImages}; pages with images: ${result.detection.pagesWithImages}/${totalPages}\n`);

  console.log("Per-chunk image detection + measured times:");
  console.log("chunk  pages   images  imgBytes   ON time    OFF time   hasImages");
  for (const c of chunks) {
    console.log(
      `  ${String(c.chunk).padEnd(4)} ${c.pages.padEnd(7)} ${String(c.images).padStart(5)}  ${String(Math.round(c.imageBytes / 1024) + "KB").padStart(8)}  ${fmt(c.onMs).padStart(8)}  ${fmt(c.offMs).padStart(8)}   ${c.hasImages ? "YES" : "no"}${c.chunk === 5 ? "   <-- chunk-5" : ""}`
    );
  }

  console.log(`\nchunk-5 (pages ${c5.pages}): ${c5.hasImages ? `HAS ${c5.images} image(s)` : "NO images"}` +
    (c5.pagesWithImages.length ? ` on page(s) ${c5.pagesWithImages.join(", ")}` : ""));

  console.log("\nConditional image-text projection (image chunks ON, text-only chunks OFF):");
  console.log(`  image chunks : ${result.imageChunkIndexes.join(", ") || "(none)"}`);
  console.log(`  text  chunks : ${result.textChunkIndexes.join(", ") || "(none)"}`);
  console.log(`  wall clock   : all-ON ${fmt(onWallMs)}  ->  conditional ${fmt(condWallMs)}  (all-OFF ${fmt(offWallMs)})`);
  console.log(`  critical path: chunk-${result.model.condCriticalChunk} (${fmt(condMaxChunk)})`);
  console.log(`  characters   : all-ON ${onChars.toLocaleString()}  ->  conditional ${condChars.toLocaleString()}  (all-OFF ${offChars.toLocaleString()})`);
  console.log(`  cost (USD)   : all-ON $${result.cost.onUSD}  ->  conditional $${result.cost.condUSD}  (all-OFF $${result.cost.offUSD})`);

  const latencySaved = onWallMs - condWallMs;
  const costSaved = result.cost.onUSD - result.cost.condUSD;
  console.log(`\nVerdict: conditional vs all-ON  ->  latency ${latencySaved > 1000 ? "-" + fmt(latencySaved) : "~no change"}, cost -$${costSaved.toFixed(4)} (${((costSaved / result.cost.onUSD) * 100).toFixed(1)}%)`);
  console.log(`Data: ${OUT_JSON}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

main().catch((e) => {
  console.error("\nAnalysis failed:", e?.message ?? e);
  process.exitCode = 1;
});
