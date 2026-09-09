# Translation pipeline optimization

Performance profiling of the layout-preserving PDF translation pipeline (the
async split / parallel / merge path in [`src/lib/batch.ts`](../src/lib/batch.ts):
`startPdfBatchJob` -> `getPdfJobStatus` -> `finishPdfBatchJob`).

The goal was to answer: **"8 chunks run in parallel, so why does a large PDF
still take ~8-9 minutes?"** and to measure where the time actually goes, per
process / activity / task and per parallel chunk.

## Folder layout

```
optimization/
├── README.md                     <- you are here
├── conditional-image-text.md     <- follow-up: does per-chunk image-text help?
├── perf-test-translation.mjs     <- instrumented harness (span tracing)
├── detect-images.mjs             <- per-chunk image detection + conditional projection
├── measure-images.mjs            <- per-image size + page-coverage measurement
├── check-coverage.mjs            <- re-OCR both outputs, compare residual Japanese
└── results/
    ├── image-on/                 <- translateTextWithinImage = true  (api 2026-03-01)
    │   ├── report.html           <- interactive waterfall + tables (open in a browser)
    │   ├── trace.json            <- raw span data
    │   └── output.pdf            <- merged translated PDF (validation, git-ignored)
    ├── image-off/                <- translateTextWithinImage = false (api 2024-05-01)
    │   ├── report.html
    │   ├── trace.json
    │   └── output.pdf            <- git-ignored
    ├── conditional-image-text.json  <- image map + conditional projection
    ├── image-sizes.json          <- per-image size + page coverage
    └── coverage-check.json           <- residual-Japanese comparison
```

Open either `report.html` in a browser for the interactive threads-and-traces
waterfall, KPI cards, per-chunk table, and a sortable span table. See
[`conditional-image-text.md`](conditional-image-text.md) for the follow-up
analysis on turning image-text off per chunk.

## Test subject

`documents/sample-24page-ja.pdf` - 26.38 MB, 24 pages, dense. Despite first
appearances it is **born-digital** (vector text + tables), not scanned: XObject
inspection found only **one raster image in the whole document** - a near-full-
page figure on page 2 (6.36 MP, ~80% page coverage) with no translatable text,
not a logo. Split into 8 chunks of 3 pages each (production default),
Japanese -> English.

## Headline finding

The 8 chunk jobs **are** submitted and processed in parallel - confirmed by the
trace: all 8 `process-azure` spans start together (~14 s). But the wall-clock is
**floored by the single slowest chunk**, not the sum of the chunks.

And the slow chunk is **not** the one with the most characters. In fact
[chunk-5 contains no images at all](conditional-image-text.md) - the cost is the
2026-03-01 pipeline routing **every** page through Document Intelligence and
re-rendering it, which is pathologically slow on dense pages regardless of
images. Adding more concurrency cannot help a job that is bound by one heavy
chunk.

## Image-text ON vs OFF (same PDF)

| Metric | image-text **ON** | image-text **OFF** | Delta |
|---|---|---|---|
| Wall clock | 9m16s | **1m04s** | **~8.7x faster** |
| Slowest chunk | chunk-5 @ **8m54s** | chunk-6 @ 48.7s | - |
| Chunk spread | 1m03s - 8m54s (very uneven) | 19.6s - 48.7s (uniform) | - |
| Poll rounds (4s each) | 119 | 10 | - |
| Characters billed | 317,356 | 257,001 | -60,355 |
| Cost (Doc Translation $15/1M) | US$4.76 | **US$3.86** | -US$0.90 |
| Output size | 24.65 MB | 17.23 MB | pages not re-rendered when OFF |
| API version | 2026-03-01 | 2024-05-01 | - |

## Per-chunk breakdown (Azure translate time / characters)

| chunk | pages | image-text ON | image-text OFF |
|---|---|---|---|
| chunk-0 | 1-3 | 1m03s / 20,801 | 44.0s / 17,199 |
| chunk-1 | 4-6 | 2m39s / 35,621 | 44.0s / 24,621 |
| chunk-2 | 7-9 | 1m22s / 27,738 | 39.2s / 20,995 |
| chunk-3 | 10-12 | 1m49s / 55,033 | 44.0s / 45,990 |
| chunk-4 | 13-15 | 1m26s / 48,520 | 48.7s / 42,310 |
| **chunk-5** | 16-18 | **8m54s** / 59,284 | 39.2s / 39,259 |
| chunk-6 | 19-21 | 4m44s / 49,203 | 48.7s / 45,169 |
| chunk-7 | 22-24 | 1m08s / 21,156 | 19.6s / 21,458 |

Note chunk-3 (ON): 55,033 chars in **1m49s**, yet chunk-5: 59,284 chars in
**8m54s**. Similar character counts, ~5x the time - and yet chunk-5 has **no
images** (verified). The cost is the per-page Document Intelligence re-render the
image-text pipeline forces, not image content. With image-text OFF, chunk-5
collapses to 39 s and the whole run finishes in about a minute.

## Phase timing (image-text ON run)

| Phase | Time | What happens |
|---|---|---|
| read + split | 0.14 s | load PDF, split into 8x 3-page chunks (pdf-lib) |
| A: submit | 8.0 s | parallel upload to blob + POST /batches per chunk |
| B: poll | 8m54s | centralized 4 s poll loop until all chunks done |
| C: download + merge | 7.0 s | parallel blob download + ordered merge |
| **wall clock** | **9m16s** | |

The download tasks all cluster at the end because `finishPdfBatchJob` downloads
only after the entire poll loop completes (every chunk done). Pipelining
downloads per-chunk would overlap them, but would not move the chunk-5-bound
wall-clock.

## Reproduce

Run from the repo root. Requires `az login` and the storage account reachable
(public network access enabled). Each run hits live Azure and incurs real
Document Translation character charges.

```powershell
# image-text ON (production default) -> results/image-on/
node optimization/perf-test-translation.mjs

# image-text OFF (text layer only) -> results/image-off/
node optimization/perf-test-translation.mjs --image off
```

Options: `--file <path>` `--pages <n>` `--image on|off` `--to <lang>` `--from <lang>`.
Each mode writes into its own `results/image-{on|off}/` folder, so ON and OFF
runs are kept side by side instead of overwriting each other.

## Takeaways

- **Concurrency is not the bottleneck.** The pipeline already fans out one batch
  job per 3-page chunk; wall-clock is set by the slowest single chunk.
- **`translateTextWithinImage` is the expensive pass.** For this born-digital
  PDF, turning it OFF was ~8.7x faster, cheaper, produced a smaller file, and -
  surprisingly - left *half* as much untranslated Japanese, because the image-
  text re-render degrades the clean digital text layer
  ([coverage check](conditional-image-text.md)).
- **Conditional image-text (ON only where images exist) is not worth it here** -
  the image-presence proxy anti-correlates with where ON actually helps, and
  plain all-OFF beats it. Keep image-text ON only for genuinely scanned /
  raster-chart documents.
- **Levers that actually reduce wall-clock:** turn image-text OFF; isolate dense
  pages into smaller chunks; or use Text view (full-page OCR + text translate,
  no re-render) when the goal is reading the content.

Measured 2026-07-02. The `output.pdf` files are validation artifacts and are
git-ignored (17-25 MB each); `report.html` and `trace.json` are kept as the
findings of record.
