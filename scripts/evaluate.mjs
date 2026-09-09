/**
 * Translation-accuracy & cost evaluation for the sample documents.
 *
 * For every PDF in ./documents this script runs BOTH production code paths
 * against the live Azure resources and measures how much Japanese text remains
 * untranslated in each mode:
 *
 *   1. Text view      — Document Intelligence (prebuilt-read OCR) + Translator
 *                       Text v3.0. OCR reads text inside raster images too, so
 *                       this path should translate (almost) everything.
 *   2. Preserve layout — Translator Document Translation batch API (2026-03-01)
 *                       with `translateTextWithinImage` enabled, so text baked
 *                       into embedded images (charts/screenshots/stamps) is also
 *                       OCR'd and translated back in place.
 *
 * Accuracy here = "translation coverage": the share of source Japanese script
 * that no longer appears in the output. We measure it by re-OCRing each output
 * and counting residual Japanese characters. The script also records the billing
 * units (OCR pages, translated characters) used to build the cost report.
 *
 * Auth: keyless (DefaultAzureCredential / `az login`). Endpoints come from env
 * vars (load them from the azd environment before running — see README of run).
 *
 * Output: docs/evaluation-results.json (+ a console summary).
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const documentsDir = path.join(repoRoot, "documents");
const docsDir = path.join(repoRoot, "docs");

const DI_API_VERSION = "2024-11-30";
const TRANSLATOR_API_VERSION = "3.0";
// 2026-03-01 (GA) adds PDF translation via Document Intelligence + image text
// translation. This matches what src/lib/batch.ts uses in production.
const BATCH_API_VERSION = "2026-03-01";
const SCOPE = "https://cognitiveservices.azure.com/.default";
const SOURCE_LANG = "ja";
const TARGET_LANG = "en";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimSlash = (u) => u.replace(/\/+$/, "");

function env(name) {
  const v = process.env[name];
  if (!v || v.startsWith("<")) throw new Error(`Missing env var ${name}`);
  return v;
}

// Japanese script: Hiragana, Katakana, CJK ideographs, halfwidth Katakana.
const JP_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F]/g;
const countJapanese = (s) => (s.match(JP_RE) || []).length;

const credential = new DefaultAzureCredential();
let token;
async function bearer() {
  const now = Date.now();
  if (!token || token.expiresOnTimestamp - now < 5 * 60 * 1000) {
    token = await credential.getToken(SCOPE);
  }
  return token.token;
}

// --- 1. OCR via Document Intelligence prebuilt-read -------------------------
async function ocr(bytes) {
  const endpoint = trimSlash(env("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT"));
  const url = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${DI_API_VERSION}`;
  const submit = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (submit.status !== 202) throw new Error(`OCR submit ${submit.status}: ${await submit.text()}`);
  const op = submit.headers.get("operation-location");
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    const poll = await fetch(op, { headers: { Authorization: `Bearer ${await bearer()}` } });
    if (!poll.ok) throw new Error(`OCR poll ${poll.status}`);
    const body = await poll.json();
    if (body.status === "succeeded") {
      return {
        content: body.analyzeResult?.content ?? "",
        pages: body.analyzeResult?.pages?.length ?? 0,
      };
    }
    if (body.status === "failed") throw new Error(`OCR failed: ${JSON.stringify(body.error)}`);
  }
  throw new Error("OCR timed out");
}

// --- 2. Translator Text v3.0 ------------------------------------------------
function chunk(text, max = 45000, maxEls = 900) {
  const lines = text.split("\n");
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const line of lines) {
    if (chars + line.length > max || cur.length >= maxEls) {
      if (cur.length) batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(line);
    chars += line.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function translateText(content) {
  const region = env("AZURE_TRANSLATOR_REGION");
  const resourceId = env("AZURE_TRANSLATOR_RESOURCE_ID");
  const endpoint =
    process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  const params = new URLSearchParams({
    "api-version": TRANSLATOR_API_VERSION,
    to: TARGET_LANG,
    from: SOURCE_LANG,
  });
  const out = [];
  for (const batch of chunk(content)) {
    const res = await fetch(`${trimSlash(endpoint)}/translate?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await bearer()}`,
        "Ocp-Apim-ResourceId": resourceId,
        "Ocp-Apim-Subscription-Region": region,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch.map((Text) => ({ Text }))),
    });
    if (!res.ok) throw new Error(`Translate ${res.status}: ${await res.text()}`);
    const items = await res.json();
    items.forEach((it, i) => out.push(it.translations?.[0]?.text ?? batch[i]));
  }
  return out.join("\n");
}

// --- 3. Translator Document Translation batch (layout-preserving PDF) --------
async function translatePdfBatch(bytes) {
  const blobEndpoint = env("AZURE_STORAGE_BLOB_ENDPOINT");
  const sourceContainer = env("AZURE_STORAGE_SOURCE_CONTAINER");
  const targetContainer = env("AZURE_STORAGE_TARGET_CONTAINER");
  const docEndpoint = trimSlash(
    process.env.AZURE_DOCUMENT_TRANSLATION_ENDPOINT || env("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
  );

  const blobService = new BlobServiceClient(blobEndpoint, credential);
  const srcClient = blobService.getContainerClient(sourceContainer);
  const tgtClient = blobService.getContainerClient(targetContainer);
  const name = `${randomUUID()}.pdf`;
  const srcBlob = srcClient.getBlockBlobClient(name);
  const tgtBlob = tgtClient.getBlockBlobClient(name);

  try {
    await srcBlob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: "application/pdf" } });
    const start = await fetch(
      `${docEndpoint}/translator/document/batches?api-version=${BATCH_API_VERSION}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: [
            {
              storageType: "File",
              source: { sourceUrl: srcBlob.url, language: SOURCE_LANG },
              targets: [{ targetUrl: tgtBlob.url, language: TARGET_LANG }],
            },
          ],
          // Translate text inside embedded images too (matches production).
          options: { translateTextWithinImage: true },
        }),
      }
    );
    if (start.status !== 202) throw new Error(`Batch start ${start.status}: ${await start.text()}`);
    const op = start.headers.get("operation-location");
    let ok = false;
    let summary;
    for (let i = 0; i < 120; i++) {
      await sleep(2000);
      const poll = await fetch(op, { headers: { Authorization: `Bearer ${await bearer()}` } });
      if (!poll.ok) throw new Error(`Batch poll ${poll.status}`);
      const body = await poll.json();
      summary = body.summary;
      const s = body.status?.toLowerCase();
      if (s === "succeeded") {
        ok = true;
        break;
      }
      if (s === "failed" || s === "validationfailed")
        throw new Error(`Batch failed: ${JSON.stringify(body.error)}`);
    }
    if (!ok) throw new Error("Batch timed out");
    const out = await tgtBlob.downloadToBuffer();
    return { out, charactersCharged: summary?.totalCharacterCharged ?? null };
  } finally {
    await Promise.allSettled([srcBlob.deleteIfExists(), tgtBlob.deleteIfExists()]);
  }
}

// --- Driver -----------------------------------------------------------------
async function evaluateDoc(file) {
  const bytes = await readFile(path.join(documentsDir, file));
  console.log(`\n=== ${file} (${(bytes.length / 1024).toFixed(0)} KB) ===`);

  // Source OCR
  const src = await ocr(bytes);
  const srcJa = countJapanese(src.content);
  console.log(`  OCR: ${src.pages} pages, ${src.content.length} chars, ${srcJa} JP chars`);

  // Text-view translation + residual measurement
  const textTranslated = await translateText(src.content);
  const textResidualJa = countJapanese(textTranslated);
  const textCoverage = srcJa ? 1 - textResidualJa / srcJa : 1;
  console.log(
    `  Text view : residual JP=${textResidualJa}  coverage=${(textCoverage * 100).toFixed(2)}%`
  );

  // Layout (batch) translation + re-OCR of the output
  let layout = { ok: false };
  try {
    const { out: translatedPdf, charactersCharged } = await translatePdfBatch(bytes);
    const reocr = await ocr(translatedPdf);
    const layoutResidualJa = countJapanese(reocr.content);
    const layoutCoverage = srcJa ? 1 - layoutResidualJa / srcJa : 1;
    const sample = (reocr.content.match(JP_RE) ? reocr.content : "")
      .split(/\s+/)
      .filter((w) => JP_RE.test(w))
      .slice(0, 12);
    JP_RE.lastIndex = 0;
    layout = {
      ok: true,
      outBytes: translatedPdf.length,
      charactersCharged,
      residualJa: layoutResidualJa,
      coverage: layoutCoverage,
      sampleResidual: sample,
    };
    console.log(
      `  Layout    : residual JP=${layoutResidualJa}  coverage=${(layoutCoverage * 100).toFixed(2)}%` +
        `  charged=${charactersCharged}`
    );
  } catch (err) {
    layout = { ok: false, error: String(err.message || err) };
    console.log(`  Layout    : ERROR ${layout.error}`);
  }

  return {
    file,
    sizeBytes: bytes.length,
    pages: src.pages,
    sourceChars: src.content.length,
    sourceJapaneseChars: srcJa,
    textView: {
      residualJapaneseChars: textResidualJa,
      coverage: textCoverage,
      translatedChars: textTranslated.length,
    },
    layout,
  };
}

async function main() {
  const files = (await readdir(documentsDir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  files.sort();
  const results = [];
  for (const f of files) {
    try {
      results.push(await evaluateDoc(f));
    } catch (err) {
      console.error(`  FAILED ${f}: ${err.message || err}`);
      results.push({ file: f, error: String(err.message || err) });
    }
  }

  await mkdir(docsDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    sourceLanguage: SOURCE_LANG,
    targetLanguage: TARGET_LANG,
    layoutApiVersion: BATCH_API_VERSION,
    translateTextWithinImage: true,
    resource: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
    documents: results,
  };
  await writeFile(
    path.join(docsDir, "evaluation-results.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(`\nWrote docs/evaluation-results.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
