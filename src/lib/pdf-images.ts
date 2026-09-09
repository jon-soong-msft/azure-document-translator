/**
 * Detects which pages of a PDF contain a raster image large enough to plausibly
 * hold translatable text — used to decide, per chunk, whether to pay for Azure's
 * image-text translation (`translateTextWithinImage`).
 *
 * Turning image-text on routes every page of a chunk through Document
 * Intelligence and re-renders it, which is slow and can even degrade the clean
 * digital text layer. Measured on a 24-page born-digital PDF: 9m16s with
 * image-text on vs 1m04s off, and ON left *more* untranslated text (see
 * optimization/ for the full profiling). So we only want it where it can help:
 * a chunk that contains a real figure / chart / screenshot with text baked in —
 * not a text-only chunk, and not one whose only image is a small logo / stamp /
 * icon.
 *
 * "Large enough" is judged primarily by DISPLAYED page-area coverage (a figure
 * covers a meaningful fraction of the page; a logo a few percent), read from the
 * content-stream transformation matrix. When that can't be parsed we fall back
 * to the image's intrinsic pixel size. The check is deliberately CONSERVATIVE:
 * if a chunk has an image whose size can't be determined, it counts as
 * significant (image-text stays on) so we never silently drop real text.
 *
 * Byte size is intentionally NOT used as a signal: a logo can be < 20 KB or
 * > 700 KB depending on compression, so it doesn't track content (the sample's
 * one image is a 718 KB, 6.36 MP figure — bigger than many real charts).
 */

import zlib from "node:zlib";
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFRawStream,
  type PDFContext,
  type PDFPage,
} from "pdf-lib";

/** Default minimum share of a page's area a raster image must cover to be
 *  treated as translatable content (below this ≈ logo/stamp/icon). */
export const DEFAULT_MIN_IMAGE_COVERAGE = 0.05; // 5% of the page area

/** Intrinsic-pixel fallback thresholds, used only when the displayed size can't
 *  be read from the content stream. */
const MIN_IMAGE_PIXEL_AREA = 50_000; // ≈ 0.05 megapixels
const MIN_IMAGE_SHORT_SIDE = 100; // px

/**
 * Minimum page-area coverage, overridable via `IMAGE_TEXT_MIN_IMAGE_COVERAGE`
 * (a percentage, e.g. "5" for 5%). Falls back to {@link DEFAULT_MIN_IMAGE_COVERAGE}.
 */
export function minImageCoverage(): number {
  const raw = process.env.IMAGE_TEXT_MIN_IMAGE_COVERAGE;
  const pct = raw ? Number(raw) : NaN;
  return Number.isFinite(pct) && pct >= 0 ? pct / 100 : DEFAULT_MIN_IMAGE_COVERAGE;
}

type Mat = [number, number, number, number, number, number];
interface ImageInfo {
  widthPx: number | null;
  heightPx: number | null;
  /** Largest displayed page-area fraction seen for this image, or null if the
   *  content stream couldn't be parsed. */
  coverage: number | null;
}

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function numOf(dict: PDFDict, key: string): number | null {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** Resolves a page's Resources dict, walking up the page tree for inheritance. */
function resolveResources(node: PDFDict): PDFDict | undefined {
  let cur: PDFDict | undefined = node;
  for (let i = 0; i < 32 && cur; i++) {
    const looked: unknown = cur.lookup(PDFName.of("Resources"));
    if (looked instanceof PDFDict) return looked;
    const parent: unknown = cur.lookup(PDFName.of("Parent"));
    cur = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/**
 * Collects every image XObject reachable from `resources` (recursing into Form
 * XObjects), keyed by indirect-object ref so duplicates count once. At the top
 * level it also records the page-level name -> ref map so a `/Name Do` in the
 * page content stream can be matched back to an image for coverage.
 */
function collectImages(
  ctx: PDFContext,
  resources: PDFDict,
  out: Map<string, ImageInfo>,
  pageNameToRef: Map<string, string> | null,
  visitedForms: Set<string>,
  depth: number
): void {
  if (depth > 12) return;
  const xobj = resources.lookup(PDFName.of("XObject"));
  if (!(xobj instanceof PDFDict)) return;
  for (const [name, value] of xobj.entries()) {
    const stream = ctx.lookup(value);
    if (!(stream instanceof PDFRawStream)) continue;
    const subtype = stream.dict.get(PDFName.of("Subtype"))?.toString() ?? "";
    const refKey = value.toString();
    if (subtype === "/Image") {
      if (!out.has(refKey)) {
        out.set(refKey, {
          widthPx: numOf(stream.dict, "Width"),
          heightPx: numOf(stream.dict, "Height"),
          coverage: null,
        });
      }
      if (pageNameToRef) pageNameToRef.set(name.toString(), refKey);
    } else if (subtype === "/Form") {
      if (visitedForms.has(refKey)) continue;
      visitedForms.add(refKey);
      const formRes = stream.dict.lookup(PDFName.of("Resources"));
      if (formRes instanceof PDFDict) {
        collectImages(ctx, formRes, out, null, visitedForms, depth + 1);
      }
    }
  }
}

/** Concatenates and inflates a page's content stream(s) to raw operator text. */
function readPageContent(ctx: PDFContext, node: PDFDict): string {
  const resolved = node.lookup(PDFName.of("Contents"));
  const streams: PDFRawStream[] = [];
  if (resolved instanceof PDFArray) {
    for (const el of resolved.asArray()) {
      const s = ctx.lookup(el);
      if (s instanceof PDFRawStream) streams.push(s);
    }
  } else if (resolved instanceof PDFRawStream) {
    streams.push(resolved);
  }
  let text = "";
  for (const s of streams) {
    let bytes = Buffer.from(s.contents);
    const filter = s.dict.get(PDFName.of("Filter"))?.toString() ?? "";
    if (filter.includes("FlateDecode")) {
      try {
        bytes = zlib.inflateSync(bytes);
      } catch {
        try {
          bytes = zlib.inflateRawSync(bytes);
        } catch {
          continue;
        }
      }
    }
    text += bytes.toString("latin1") + "\n";
  }
  return text;
}

/**
 * Walks the content stream tracking the CTM (q/Q/cm) and, at each `/Name Do`
 * that draws a known page-level image, records the displayed page-area coverage.
 */
function assignCoverage(
  content: string,
  pageNameToRef: Map<string, string>,
  images: Map<string, ImageInfo>,
  pageArea: number
): void {
  const tokens = content.split(/\s+/);
  let ctm: Mat = [...IDENTITY];
  const stack: Mat[] = [];
  let nums: number[] = [];
  let lastName: string | null = null;
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
        stack.push([...ctm]);
        nums = [];
        break;
      case "Q":
        ctm = stack.pop() ?? [...IDENTITY];
        nums = [];
        break;
      case "cm":
        if (nums.length >= 6) ctm = matMul(ctm, nums.slice(-6) as Mat);
        nums = [];
        break;
      case "Do": {
        if (lastName && pageNameToRef.has(lastName)) {
          const im = images.get(pageNameToRef.get(lastName)!);
          if (im) {
            const areaPt = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
            const cov = areaPt / pageArea;
            im.coverage = im.coverage == null ? cov : Math.max(im.coverage, cov);
          }
        }
        nums = [];
        break;
      }
      default:
        nums = [];
    }
  }
}

function isSignificant(im: ImageInfo, minCoverage: number): boolean {
  // Primary signal: how much of the page the image is actually drawn over.
  if (im.coverage != null) return im.coverage >= minCoverage;
  // Fallback when the display size couldn't be read: intrinsic pixels.
  if (im.widthPx != null && im.heightPx != null) {
    const area = im.widthPx * im.heightPx;
    const shortSide = Math.min(im.widthPx, im.heightPx);
    return area >= MIN_IMAGE_PIXEL_AREA && shortSide >= MIN_IMAGE_SHORT_SIDE;
  }
  // Nothing measurable — be conservative and keep image-text on.
  return true;
}

function pageIsSignificant(page: PDFPage, minCoverage: number): boolean {
  const ctx = page.doc.context;
  const resources = resolveResources(page.node);
  if (!resources) return false; // no resources -> no images

  const images = new Map<string, ImageInfo>();
  const pageNameToRef = new Map<string, string>();
  collectImages(ctx, resources, images, pageNameToRef, new Set(), 0);
  if (images.size === 0) return false; // text-only page

  const { width, height } = page.getSize();
  const pageArea = width * height;
  if (pageArea > 0 && pageNameToRef.size > 0) {
    try {
      assignCoverage(readPageContent(ctx, page.node), pageNameToRef, images, pageArea);
    } catch {
      // Leave coverage null -> per-image pixel fallback in isSignificant.
    }
  }

  for (const im of images.values()) {
    if (isSignificant(im, minCoverage)) return true;
  }
  return false;
}

/**
 * Returns the 0-based indices of the pages that contain a raster image large
 * enough to be worth image-text translation. Pages absent from the set are
 * text-only or contain only small logos/icons.
 *
 * Conservative by design: any page whose images can't be measured is included
 * (treated as significant) so image-text is never wrongly turned off.
 */
export async function significantImagePages(
  fileBytes: Buffer,
  minCoverage: number = minImageCoverage()
): Promise<Set<number>> {
  const doc = await PDFDocument.load(fileBytes, { updateMetadata: false });
  const pages = doc.getPages();
  const out = new Set<number>();
  pages.forEach((page, i) => {
    let significant = true;
    try {
      significant = pageIsSignificant(page, minCoverage);
    } catch {
      significant = true; // parse error on a page -> conservative: keep on
    }
    if (significant) out.add(i);
  });
  return out;
}
