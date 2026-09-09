# Conditional image-text: does turning it off per-chunk help?

Follow-up to the [performance profiling](README.md). Two questions from the
`documents/sample-24page-ja.pdf` run:

1. Does **chunk-5** (pages 16-18) - the 8m54s critical-path chunk - actually
   contain images?
2. Would a **conditional** policy (turn `translateTextWithinImage` ON only for
   chunks that contain images, OFF for text-only chunks) help?

Scripts (pure local + one OCR pass, no translation cost):

- [`detect-images.mjs`](detect-images.mjs) - parses the PDF for image XObjects
  per chunk and projects the conditional latency/cost from the two saved traces.
- [`measure-images.mjs`](measure-images.mjs) - measures each image's pixels,
  bytes and **displayed page-area coverage** (decodes the content-stream CTM).
- [`check-coverage.mjs`](check-coverage.mjs) - re-OCRs both translated outputs
  and counts residual Japanese per chunk, to see whether OFF actually loses any
  translation.

## Finding 1 - chunk-5 has NO images. The whole document has one.

XObject inspection (recurses Form XObjects, deduped by object ref):

- **1 image in the entire 24-page document** - a large figure on **page 2**
  (chunk-0): 2999x2120 px (6.36 MP), 718 KB, drawn at ~80% of the page area. Not
  a logo - a near-full-page diagram/figure (see [Finding 3](#finding-3---would-a-logosize-filter-help)).
- **chunk-5 (pages 16-18): zero images.** So its 8m54s was **not** image OCR.

This refutes the earlier "chunk-5 is image/chart-heavy" guess. the 24-page sample is a
**born-digital** PDF (vector text + tables), not a scanned one. The slowness is
the 2026-03-01 pipeline itself: with `translateTextWithinImage` on, Azure routes
**every** page through Document Intelligence and re-renders it, which is
pathologically slow on chunk-5's dense pages even though there is nothing to OCR.

| chunk | pages | images | ON time | OFF time |
|---|---|---|---|---|
| chunk-0 | 1-3 | **1** (718 KB) | 1m03s | 44.0s |
| chunk-1 | 4-6 | 0 | 2m39s | 44.0s |
| chunk-2 | 7-9 | 0 | 1m22s | 39.2s |
| chunk-3 | 10-12 | 0 | 1m49s | 44.0s |
| chunk-4 | 13-15 | 0 | 1m26s | 48.7s |
| **chunk-5** | **16-18** | **0** | **8m54s** | 39.2s |
| chunk-6 | 19-21 | 0 | 4m44s | 48.7s |
| chunk-7 | 22-24 | 0 | 1m08s | 19.6s |

## Finding 2 - image-text OFF is not just faster, it translates MORE here

Re-OCR of both translated outputs, counting residual Japanese (lower = more
fully translated; some residual is normal - proper nouns, stamps):

| chunk | pages | images | ON residual JA | OFF residual JA | who is better |
|---|---|---|---|---|---|
| chunk-0 | 1-3 | 1 | 101 | **24** | OFF (despite the image) |
| chunk-1 | 4-6 | 0 | 194 | **72** | OFF |
| chunk-2 | 7-9 | 0 | 103 | **55** | OFF |
| chunk-3 | 10-12 | 0 | 191 | **24** | OFF |
| chunk-4 | 13-15 | 0 | 26 | 29 | tie |
| chunk-5 | 16-18 | 0 | 1 | 6 | tie |
| chunk-6 | 19-21 | 0 | **14** | 36 | ON (+22 on OFF) |
| chunk-7 | 22-24 | 0 | **0** | 66 | ON (+66 on OFF) |
| **TOTAL** | | 1 | **630** | **312** | **OFF (half the residual)** |

For this born-digital file the image-text re-render **degrades** the clean text
layer on text-heavy pages (chunks 0-3 leave far more Japanese with ON). Only
chunks 6-7 have a little text that ON catches and OFF misses (+88 JA total) -
and chunk-6 paid **4m44s** for its 22-char gain.

## The image-presence proxy anti-correlates with benefit

The "turn ON where there are images" rule does the wrong thing on this file:

- It keeps **chunk-0 ON** because of the page-2 figure - but OFF is *better*
  there (24 vs 101 residual JA). The figure itself has no Japanese (0 residual
  either way, see Finding 3); ON just hurt the digital text on the other pages.
- It turns **chunks 6-7 OFF** (no images) - but those are the only chunks where
  ON actually added coverage.

So raster-image presence does not track where `translateTextWithinImage` helps.
Knowing that would require OCR-ing the images (the very cost we are avoiding) or
classifying pages as scanned vs born-digital.

## Finding 3 - would a logo/size filter help?

Direct question: skip "logo-kind" images when deciding image-text ON, and if so
above/below what size? Measured the one image with
[`measure-images.mjs`](measure-images.mjs), which decodes the content-stream CTM
to get the *displayed* size, not just the intrinsic pixels:

| page | pixels | MP | KB | displayed | **page coverage** |
|---|---|---|---|---|---|
| 2 | 2999x2120 | 6.36 | 718 | 1062x751 pt | **79.6%** |

Two lessons fall out of this single data point:

1. **Byte size is a useless discriminator.** This image is 718 KB - bigger than
   many real charts. A "skip images under N KB" rule either never fires (small N)
   or discards genuine figures (large N). Logos can be <20 KB *or* >700 KB
   depending on compression, so KB tells you nothing about content.
2. **Displayed page-area coverage is the right signal.** A logo / stamp / icon
   occupies a few percent of the page; a chart / figure / screenshot occupies
   tens of percent. This image is 79.6% -> clearly a figure, correctly *not*
   skipped.

But this file also exposes the ceiling of any size rule. Image-text ON gained
**nothing** on that 79.6% figure: re-OCR of page 2 shows **0 residual Japanese
with ON and with OFF** (272 vs 304 chars) - the figure has no Japanese baked in
(it is a diagram/photo, not a Japanese chart). Yet ON still paid the re-render
cost and degraded the digital text next to it (page 3: 101 residual JA with ON
vs 15 with OFF). So a coverage filter would have *kept this image ON* (it is
big), but ON was the wrong call anyway.

**Size/coverage tells you "is this a logo", not "does this image contain
translatable text."** Only OCR answers the latter - the very cost we are avoiding.

### Recommended thresholds (if you implement a filter)

- **Primary - coverage:** treat an image as translatable content only if its
  displayed area is **>= ~5% of the page**; skip anything below (logos, stamps,
  icons, signatures, rules). Needs content-stream CTM parsing - see
  `measure-images.mjs`.
- **Fallback - intrinsic pixels** (when CTM parsing is not worth it): skip images
  **< ~100 px on the short side** or **< ~0.05 MP**.
- **Do not threshold on byte size** (718 KB logo counterexample above).
- **Know the ceiling:** a size/coverage filter only avoids wasting the image
  pass on obvious non-text marks. It cannot tell whether a *large* image holds
  text. For that, prefer a document-level scanned-vs-born-digital signal.

## Projected options (same PDF)

| Option | Wall clock | Cost | Residual JA | Notes |
|---|---|---|---|---|
| all ON (current default) | 9m16s | $4.76 | 630 | slow, most untranslated |
| **all OFF** | **1m04s** | **$3.86** | **312** | best on all three axes |
| conditional (by image) | ~1m24s (proj.) | $3.91 | ~mixed | keeps chunk-0 ON (worse), turns 6-7 OFF (loses +88 JA) |

Conditional recovers most of the speed (turning the dense chunks OFF), but it is
**beaten by plain all-OFF** on this file: all-OFF is a touch faster (conditional
keeps chunk-0 ON as its 1m03s critical path), cheaper, and cleaner.

## Verdict

- **chunk-5 has no images** - confirmed. The multi-minute tail is the 2026-03-01
  Document-Intelligence re-render pass on dense pages, not image OCR.
- **Conditional image-text by image-presence is not worth it for the 24-page sample.** It
  adds branching logic yet loses to the simplest policy (all-OFF), because the
  proxy keeps the one image chunk ON where OFF is better, and turns off the two
  chunks where ON actually helped.
- **For born-digital PDFs, default image-text OFF.** Here it was ~8.7x faster,
  ~19% cheaper, and left half the untranslated Japanese.
- **Keep image-text ON only for genuinely scanned / raster-chart documents**
  (e.g. charts with text baked into images), where the digital text layer is
  absent and OCR is the only way to reach the text. A reliable per-document
  signal (scanned vs born-digital) beats per-chunk raster-image presence.

## Reproduce

```powershell
# 1. image map + conditional projection (local only, no Azure)
node optimization/detect-images.mjs

# 2. per-image size + page-coverage measurement (local only, no Azure)
node optimization/measure-images.mjs

# 3. coverage re-OCR of the two saved outputs (needs az login; DI OCR only)
node optimization/check-coverage.mjs
```

Data: [`results/conditional-image-text.json`](results/conditional-image-text.json),
[`results/image-sizes.json`](results/image-sizes.json),
[`results/coverage-check.json`](results/coverage-check.json). Measured 2026-07-02;
requires the two `results/image-{on,off}/output.pdf` files from the perf runs.

## Implemented

Shipped as a per-chunk gate in the production pipeline
([`src/lib/pdf-images.ts`](../src/lib/pdf-images.ts), wired into
[`src/lib/batch.ts`](../src/lib/batch.ts)):

- `significantImagePages(bytes)` returns the pages whose largest image covers at
  least the coverage threshold (or, if the display size can't be read, is big
  enough in pixels). It recurses Form XObjects and is conservative: if an image
  can't be measured, its page counts as significant so image-text is never
  wrongly dropped.
- `startPdfBatchJob` (split/async path) computes this once and enables
  `translateTextWithinImage` **only on chunks that include a significant-image
  page**; every other chunk uses the faster text-layer-only API version. The
  sync `translatePdfBatch` applies the same gate to the whole small PDF.
- Threshold: **5% page-area coverage** by default, override with
  `IMAGE_TEXT_MIN_IMAGE_COVERAGE` (a percentage, e.g. `10`). Pixel fallback skips
  images `< ~0.05 MP` or `< ~100 px` on the short side.
- The user's image-text toggle still wins: when it is off, detection is skipped
  and every chunk stays off.

On the 24-page sample this turns chunk-0 ON (the page-2 figure) and chunks 1-7 OFF -
matching the ~1m24s projection above (vs 9m16s all-ON). The honest caveat from
Finding 3 still holds: the one figure has no Japanese, so keeping chunk-0 ON is
slightly worse than all-OFF *for this file* - but the gate generalizes across
document types (it keeps image-text where a genuine large figure/chart lives, as
in scanned or chart-heavy PDFs, while skipping text-only and logo-only pages).
Verified: `tsc --noEmit` clean, `npm run build` clean, and the detector returns
`{page 2}` at 5%, `{}` at 90%, `{page 2}` at 0% against the real PDF.

