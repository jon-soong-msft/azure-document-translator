# Translation Accuracy & Cost Evaluation

**Date:** 2026-06-22
**Resource:** Azure AI multi-service (`cog-<token>`), region `southeastasia`
**Direction tested:** Japanese → English (`ja` → `en`)
**Sample set:** four publicly-published Japanese government PDFs (MLIT / METI).
The source files are **not redistributed in this repo** — see
[Reproduce this evaluation](#reproduce-this-evaluation) to run it against your own documents.
**How it was produced:** [`scripts/evaluate.mjs`](../scripts/evaluate.mjs) → raw data in [`evaluation-results.json`](evaluation-results.json)

---

## TL;DR

| Mode | What it does | Translation coverage | Verdict |
| ---- | ------------ | -------------------- | ------- |
| **Text view** (OCR + Translator Text) | Re-reads every pixel with OCR, then translates the text | **~99.99 %** | Best for *reading* a document end-to-end |
| **Preserve layout** (Document Translation, API `2026-03-01`, **image text translation ON**) | Translates the digital text layer **and** text baked into embedded images, keeps tables/formatting | **100 %** | Best for a *formatted copy* — now also translates charts/screenshots |

> **Update (2026-06-22): the untranslated-image gap is fixed.** Earlier, Preserve-layout
> mode left Japanese text inside embedded images (charts, screenshots, agency stamps)
> untranslated (~90 % coverage on image-heavy PDFs). Upgrading the batch path to Document
> Translation API **`2026-03-01`** with the **`translateTextWithinImage`** option now OCRs and
> re-renders that text too, taking all four documents to **100 % coverage**. The trade-off is
> higher character cost and a larger output file (see [Cost](#cost-of-processing-these-documents)).

---

## Methodology

For every PDF we ran **both** production code paths against the live Azure resources and measured how much Japanese script survived in the output:

1. **Source OCR** — `prebuilt-read` (Document Intelligence) extracts all text (including text inside images) and reports page count. This gives the baseline count of Japanese characters in the document.
2. **Text view** — the OCR text is translated with Translator Text v3.0. We count residual Japanese characters in the translated text.
3. **Preserve layout** — the PDF goes through the Translator **Document Translation batch** API (the same path the deployed app uses: API `2026-03-01`, `translateTextWithinImage: true`). We then **re-OCR the translated PDF** and count residual Japanese characters, and record the **actual characters billed** (`totalCharacterCharged`).

**Coverage** is defined as:

$$\text{coverage} = 1 - \frac{\text{Japanese characters remaining in output}}{\text{Japanese characters in source}}$$

Japanese = Hiragana, Katakana, Kanji (CJK Unified Ideographs) and half-width Katakana. A coverage of 100 % means no Japanese script remained.

---

## Results (current behavior)

| Document | Pages | Source JP chars | Text-view coverage | **Layout coverage** | Layout JP left |
| -------- | ----: | --------------: | -----------------: | ------------------: | -------------: |
| `016_05_00.pdf` | 14 | 5,747 | 100.00 % | **100.00 %** | 0 |
| `2023_01benchmark.pdf` | 19 | 9,309 | 99.96 % | **100.00 %** | 0 |
| `maizou_kijun.pdf` | 13 | 9,649 | 100.00 % | **100.00 %** | 0 |
| `sankou1-1.pdf` | 2 | 1,542 | 100.00 % | **100.00 %** | 0 |
| **Total / avg** | **48** | **26,247** | **~99.99 %** | **100 %** | **0** |

### Before → after (Preserve layout)

Enabling image-text translation closed the gap entirely on the two image-heavy PDFs:

| Document | Coverage **before** (`2024-05-01`, no image option) | Coverage **after** (`2026-03-01`, `translateTextWithinImage`) | Δ |
| -------- | ----: | ----: | ----: |
| `016_05_00.pdf` | 89.52 % (602 JP left) | **100.00 %** (0 left) | **+10.48 pts** |
| `2023_01benchmark.pdf` | 93.64 % (592 JP left) | **100.00 %** (0 left) | **+6.36 pts** |
| `maizou_kijun.pdf` | 100 % | 100 % | — |
| `sankou1-1.pdf` | 100 % | 100 % | — |

### What used to leak (now translated)

Examples of text that was **previously left in Japanese** because it was baked into raster images — and is now translated:

- From `016_05_00.pdf` (chart legend / axis labels / agency stamp): `国土交通省` (MLIT), `事務所(n=567)`, `病院(n=896)`, `百貨店(n=529)`, `累積相対度数[%]` (Cumulative relative frequency [%]).
- From `2023_01benchmark.pdf` (embedded website screenshot): `経済産業省` (METI), `日本データセンター協会` (Japan Data Center Council), `ニュース` / `イベント` / `トピックス` (News / Events / Topics).

### Why it works now

- API `2026-03-01` introduced **PDF translation backed by Azure Document Intelligence** plus a **`translateTextWithinImage`** option ([overview](https://learn.microsoft.com/azure/ai-services/translator/document-translation/latest/overview), [how-to](https://learn.microsoft.com/azure/ai-services/translator/document-translation/how-to-guides/use-rest-api-programmatically#translate-images-in-word-documents-docx-and-powerpoint-files-pptx)).
- With it enabled, the service OCRs text inside images and renders the translation back in place, instead of only swapping the digital text layer.
- The previously born-digital, text-only PDFs (`maizou_kijun.pdf`, `sankou1-1.pdf`) were already at 100 %; the image-heavy ones (`016_05_00.pdf`, `2023_01benchmark.pdf`) are the ones that improved.

---

## Recommendations

1. **Preserve layout is now the high-fidelity default** — it keeps tables/formatting *and* translates image text, reaching 100 % coverage on these documents.
2. **Use Text view when you want the cheapest, smallest output** or just need to read the content; it reaches ~100 % coverage without re-rendering images, so its files stay small.
3. **Mind the output size.** Image translation re-renders pages, so translated PDFs grow substantially (see below). If file size matters more than translating chart text, the older text-layer-only behavior can be restored by removing the `translateTextWithinImage` option in [`src/lib/batch.ts`](../src/lib/batch.ts).
4. **Automated regression check:** re-run `scripts/evaluate.mjs` any time to re-measure coverage and billed characters; it writes `docs/evaluation-results.json`.

---

## Cost of processing these documents

### Unit prices

Region `southeastasia`, pay-as-you-go (S0 / S1) retail prices in USD, fetched from the **Azure Retail Prices API** on 2026-06-22. Prices vary by region, currency and commitment tier.

| Service & meter | Unit | Price |
| --------------- | ---- | ----: |
| Document Intelligence — Read (S0) | per 1,000 pages | $1.50 |
| Translator — Text translation (S1) | per 1,000,000 characters | $10.00 |
| Translator — Document Translation (S1) | per 1,000,000 characters | $15.00 |
| Translator — Image translation (S1) | per 1,000 images | $8.00 |

> **Billing basis:** Translator Text bills by **source characters submitted**; Document Intelligence by **pages analyzed**. Document Translation bills by **characters charged** (`totalCharacterCharged`, reported per job) — with image translation on, this includes text recovered from images.

### Per-document cost (ja → en, one run)

**Text view** = Document Intelligence Read (pages) + Translator Text (source chars):

| Document | Pages | Source chars | OCR cost | Translate cost | **Text-view total** |
| -------- | ----: | -----------: | -------: | -------------: | ------------------: |
| `016_05_00.pdf` | 14 | 13,690 | $0.0210 | $0.1369 | **$0.158** |
| `2023_01benchmark.pdf` | 19 | 12,187 | $0.0285 | $0.1219 | **$0.150** |
| `maizou_kijun.pdf` | 13 | 11,132 | $0.0195 | $0.1113 | **$0.131** |
| `sankou1-1.pdf` | 2 | 1,886 | $0.0030 | $0.0189 | **$0.022** |
| **Total** | **48** | **38,895** | **$0.072** | **$0.389** | **$0.461** |

**Preserve layout** = Document Translation, **actual characters charged** (image translation on) × $15/1M:

| Document | Chars charged | **Layout total** | Output size (vs source) |
| -------- | ------------: | ---------------: | ----------------------- |
| `016_05_00.pdf` | 15,941 | **$0.239** | 6.2 MB (was 1.3 MB) |
| `2023_01benchmark.pdf` | 19,722 | **$0.296** | 4.8 MB (was 1.1 MB) |
| `maizou_kijun.pdf` | 18,411 | **$0.276** | 1.4 MB (was 0.6 MB) |
| `sankou1-1.pdf` | 3,485 | **$0.052** | 1.0 MB (was 0.5 MB) |
| **Total** | **57,559** | **$0.863** | — |

> For comparison, the **text-layer-only** layout path (no image translation) charged on ~38,895 source characters ≈ **$0.583**. Translating image text adds **~$0.28 (~+48 %)** across these four documents and noticeably enlarges the output files.

### Bottom line

- Processing **all four documents (48 pages)** costs **≈ $0.46 in Text view** or **≈ $0.86 in Preserve layout with image translation** — still under one US dollar.
- Rule-of-thumb at this corpus's density (~810 chars/page):
  - **Text view:** **~$9.60 per 1,000 pages**
  - **Preserve layout (image text on):** **~$18 per 1,000 pages** (varies with how much image text each page contains)
- Re-translating to additional target languages multiplies only the **translation** characters (OCR is paid once if you cache the extracted text).

> These are **variable, per-use** AI costs only. The fixed monthly cost of the hosting infrastructure is covered in [INFRASTRUCTURE.md](INFRASTRUCTURE.md).

---

## Reproduce this evaluation

This repo ships no sample documents. Put your own PDFs in a local `documents/`
folder (it is git-ignored), then:

```powershell
# 1. Sign in (keyless auth) and load the deployed resource's endpoints
az login
azd env get-values | ForEach-Object {
  if ($_ -match '^([A-Z0-9_]+)="?(.*?)"?$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2])
  }
}

# 2. Run the evaluation (OCR + text + layout-with-image-translation)
node scripts/evaluate.mjs
```

The script prints a per-document summary and writes the full report to `docs/evaluation-results.json`.
