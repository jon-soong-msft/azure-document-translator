/**
 * Measure raster images in a PDF to inform a "skip logos" rule for the
 * conditional image-text decision.
 *
 * For each image XObject it reports:
 *   - intrinsic pixels (Width x Height) and megapixels
 *   - encoded stream bytes (what /detect-images.mjs calls imageBytes)
 *   - DISPLAYED size on the page: the area the image is actually drawn at, from
 *     the content-stream CTM, expressed as a percentage of the page area. This
 *     is the signal that separates a small logo/stamp (a few % of the page) from
 *     a chart/figure/screenshot (tens of % of the page).
 *
 * Pure local parse (pdf-lib + Node zlib to inflate FlateDecode content). No
 * Azure, no network.
 *
 * Usage:  node optimization/measure-images.mjs [--file "documents/sample-24page-ja.pdf"]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import path from "node:path";
import { PDFDocument, PDFName, PDFDict, PDFStream, PDFArray } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error(
    "Missing --file. This repo ships no sample documents; point it at your own PDF:\n" +
      "  node optimization/measure-images.mjs --file path/to/your.pdf"
  );
  process.exit(1);
}
const PDF_PATH = path.resolve(repoRoot, args.file);
// A `--label` keeps a document's measurement in results/<label>/ so different
// PDFs don't overwrite each other's image-sizes.json.
const LABEL = typeof args.label === "string" ? args.label : "";
const OUT_JSON = path.join(__dirname, "results", ...(LABEL ? [LABEL] : []), "image-sizes.json");

function getResources(page) {
  const ctx = page.doc.context;
  const node = page.node;
  try {
    const r = node.Resources?.();
    if (r) return r;
  } catch {}
  try {
    const r = ctx.lookup(node.get(PDFName.of("Resources")), PDFDict);
    if (r) return r;
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

/** name (e.g. "/Im0") -> { w, h, bytes } for image XObjects at page top level. */
function imageXObjects(page) {
  const ctx = page.doc.context;
  const res = getResources(page);
  const map = {};
  if (!res) return map;
  let xobj;
  try {
    xobj = res.lookup(PDFName.of("XObject"), PDFDict);
  } catch {
    xobj = undefined;
  }
  if (!xobj) return map;
  for (const [name, value] of xobj.entries()) {
    let stream;
    try {
      stream = ctx.lookup(value);
    } catch {
      continue;
    }
    if (!(stream instanceof PDFStream)) continue;
    let sub = "";
    try {
      sub = stream.dict.get(PDFName.of("Subtype"))?.toString() ?? "";
    } catch {}
    if (sub !== "/Image") continue;
    map[name.toString()] = {
      w: numOf(stream.dict, "Width"),
      h: numOf(stream.dict, "Height"),
      bytes: (stream.contents && stream.contents.length) || 0,
    };
  }
  return map;
}

function contentStreams(page) {
  const ctx = page.doc.context;
  const ref = page.node.get(PDFName.of("Contents"));
  if (!ref) return [];
  const resolved = ctx.lookup(ref);
  const out = [];
  const add = (o) => {
    if (o instanceof PDFStream) out.push(o);
  };
  if (resolved instanceof PDFArray) {
    for (const el of resolved.asArray()) add(ctx.lookup(el));
  } else {
    add(resolved);
  }
  return out;
}

function inflate(buf) {
  try {
    return zlib.inflateSync(buf);
  } catch {
    try {
      return zlib.inflateRawSync(buf);
    } catch {
      return null;
    }
  }
}

function decodedContent(page) {
  let text = "";
  for (const s of contentStreams(page)) {
    let filt = "";
    try {
      filt = s.dict.get(PDFName.of("Filter"))?.toString() ?? "";
    } catch {}
    let bytes = s.contents ? Buffer.from(s.contents) : Buffer.alloc(0);
    if (filt.includes("FlateDecode")) {
      const inf = inflate(bytes);
      if (!inf) continue;
      bytes = inf;
    }
    text += bytes.toString("latin1") + "\n";
  }
  return text;
}

const matMul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Walk the content stream tracking the CTM; record displayed size at each
 *  `<name> Do` that references an image XObject. Returns name -> {wPt,hPt,areaPt}. */
function displayedSizes(page, imageNames) {
  const text = decodedContent(page);
  if (!text) return {};
  const tokens = text.split(/\s+/);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let nums = [];
  let lastName = null;
  const out = {};
  for (const tok of tokens) {
    if (tok === "") continue;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      nums.push(parseFloat(tok));
      if (nums.length > 6) nums.shift();
      continue;
    }
    if (tok[0] === "/") {
      lastName = tok;
      nums = [];
      continue;
    }
    switch (tok) {
      case "q":
        stack.push(ctm.slice());
        nums = [];
        break;
      case "Q":
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        nums = [];
        break;
      case "cm":
        if (nums.length >= 6) ctm = matMul(ctm, nums.slice(-6));
        nums = [];
        break;
      case "Do": {
        if (lastName && lastName in imageNames) {
          const wPt = Math.hypot(ctm[0], ctm[1]);
          const hPt = Math.hypot(ctm[2], ctm[3]);
          const areaPt = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
          // Keep the largest placement if drawn more than once.
          if (!out[lastName] || areaPt > out[lastName].areaPt) out[lastName] = { wPt, hPt, areaPt };
        }
        nums = [];
        break;
      }
      default:
        nums = [];
    }
  }
  return out;
}

async function main() {
  if (!existsSync(PDF_PATH)) throw new Error(`File not found: ${PDF_PATH}`);
  const bytes = await readFile(PDF_PATH);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();

  const images = [];
  pages.forEach((page, i) => {
    const size = page.getSize(); // points
    const pageArea = size.width * size.height;
    const names = imageXObjects(page);
    if (Object.keys(names).length === 0) return;
    const disp = displayedSizes(page, names);
    for (const [name, meta] of Object.entries(names)) {
      const d = disp[name];
      const mp = meta.w && meta.h ? (meta.w * meta.h) / 1e6 : null;
      const coverage = d ? (d.areaPt / pageArea) * 100 : null;
      images.push({
        page: i + 1,
        name,
        widthPx: meta.w,
        heightPx: meta.h,
        megapixels: mp != null ? +mp.toFixed(2) : null,
        bytesKB: +(meta.bytes / 1024).toFixed(1),
        displayedWidthPt: d ? +d.wPt.toFixed(1) : null,
        displayedHeightPt: d ? +d.hPt.toFixed(1) : null,
        pageCoveragePct: coverage != null ? +coverage.toFixed(2) : null,
        pageWidthPt: +size.width.toFixed(1),
        pageHeightPt: +size.height.toFixed(1),
      });
    }
  });

  console.log(`\nFile: ${path.basename(PDF_PATH)}  (${pages.length} pages)`);
  console.log(`Raster image XObjects found: ${images.length}\n`);
  if (images.length) {
    console.log("page  name    pixels        MP     KB       displayed(pt)     page%");
    for (const im of images) {
      const px = im.widthPx && im.heightPx ? `${im.widthPx}x${im.heightPx}` : "?";
      const disp = im.displayedWidthPt ? `${im.displayedWidthPt}x${im.displayedHeightPt}` : "n/a";
      console.log(
        `  ${String(im.page).padEnd(3)} ${im.name.padEnd(6)} ${px.padEnd(12)} ${String(im.megapixels ?? "?").padStart(5)} ${String(im.bytesKB).padStart(7)}  ${disp.padEnd(15)} ${im.pageCoveragePct != null ? im.pageCoveragePct + "%" : "n/a"}`
      );
    }
  }

  await mkdir(path.dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify({ file: path.basename(PDF_PATH), pages: pages.length, images }, null, 2));
  console.log(`\nData: ${OUT_JSON}\n`);
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

main().catch((e) => {
  console.error("\nMeasure failed:", e?.message ?? e);
  process.exitCode = 1;
});
