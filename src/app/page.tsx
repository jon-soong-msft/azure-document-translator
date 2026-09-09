"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LANGUAGES, languageName } from "@/lib/languages";
import DocumentPane from "@/components/DocumentPane";
import DocumentPreview from "@/components/DocumentPreview";
import PdfCompareOverlay from "@/components/PdfCompareOverlay";
import EvaluationReportCard from "@/components/EvaluationReportCard";
import HistoryPanel from "@/components/HistoryPanel";
import type { EvaluationReport } from "@/lib/evaluation";
import {
  addHistoryEntry,
  clearHistory,
  deleteHistoryEntry,
  getAllHistory,
  type HistoryEntry,
} from "@/lib/history";

type Mode = "text" | "layout";

interface TextResult {
  fileName: string;
  original: string;
  translated: string;
  detectedLanguage?: string;
  targetLanguage: string;
}

interface LayoutResult {
  fileName: string;
  ext: string;
  originalUrl: string;
  translatedUrl: string;
  translatedName: string;
  targetLanguage: string;
  isImage: boolean;
}

const TEXT_ACCEPTED =
  ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.heif,.docx,.xlsx,.pptx,.html,.htm";
const LAYOUT_ACCEPTED =
  ".pdf,.docx,.pptx,.xlsx,.html,.htm,.txt,.csv,.tsv,.xlf,.png,.jpg,.jpeg,.bmp,.webp";

/**
 * Drives an async layout-PDF job: polls /status until it finishes, then fetches
 * the merged file from /result. Returns the result Response so the caller can
 * read it exactly like the synchronous response.
 */
async function pollLayoutJob(
  token: string,
  onProgress: (done: number, total: number) => void
): Promise<Response> {
  // ~30 min ceiling (450 x 4s) as a safety net against a stuck job.
  for (let i = 0; i < 450; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const sres = await fetch("/api/translate-document/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!sres.ok) {
      const d = await sres.json().catch(() => null);
      throw new Error(d?.error || "Lost track of the translation job.");
    }
    const s = await sres.json();
    if (typeof s.done === "number" && typeof s.total === "number") {
      onProgress(s.done, s.total);
    }
    if (s.status === "failed") {
      throw new Error(s.error || "The document failed to translate.");
    }
    if (s.status === "succeeded") {
      return fetch("/api/translate-document/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    }
  }
  throw new Error("Translation timed out. Please try a smaller document.");
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("text");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [loading, setLoading] = useState(false);
  // Progress for the async split-PDF job (done/total chunks), shown while loading.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [textResult, setTextResult] = useState<TextResult | null>(null);
  const [layoutResult, setLayoutResult] = useState<LayoutResult | null>(null);
  // When true, the backend has blob storage wired for batch PDF (layout) translation.
  const [batchPdf, setBatchPdf] = useState(false);
  // Full-screen side-by-side compare overlay (layout PDF/image results).
  const [compareOpen, setCompareOpen] = useState(false);
  // Optional evaluation report (characters / cost / time). Off by default so it
  // never adds overhead unless the user opts in.
  const [evaluate, setEvaluate] = useState(false);
  const [evaluationEnabled, setEvaluationEnabled] = useState(true);
  // Preserve-layout only: translate text baked into images (charts/stamps).
  // On by default; can be turned off for cleaner, faster digital-only output.
  const [translateImageText, setTranslateImageText] = useState(true);
  const [lastEvaluation, setLastEvaluation] = useState<EvaluationReport | null>(
    null
  );
  // Processing history, persisted in the browser via IndexedDB.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

  // Discover backend capabilities (e.g. whether layout-preserving PDF is available).
  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg && typeof cfg.batchPdf === "boolean") setBatchPdf(cfg.batchPdf);
        if (cfg && typeof cfg.evaluationEnabled === "boolean")
          setEvaluationEnabled(cfg.evaluationEnabled);
      })
      .catch(() => {});
  }, []);

  // Load the persisted evaluation-toggle preference and the saved history.
  useEffect(() => {
    try {
      setEvaluate(localStorage.getItem("dt_evaluate") === "1");
      setTranslateImageText(localStorage.getItem("dt_image_text") !== "0");
    } catch {
      // ignore storage access errors
    }
    getAllHistory()
      .then(setHistory)
      .catch(() => {});
  }, []);

  const toggleEvaluate = useCallback((next: boolean) => {
    setEvaluate(next);
    try {
      localStorage.setItem("dt_evaluate", next ? "1" : "0");
    } catch {
      // ignore storage access errors
    }
  }, []);

  const toggleImageText = useCallback((next: boolean) => {
    setTranslateImageText(next);
    try {
      localStorage.setItem("dt_image_text", next ? "1" : "0");
    } catch {
      // ignore storage access errors
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await getAllHistory());
    } catch {
      // ignore — history is best-effort
    }
  }, []);

  const saveToHistory = useCallback(
    async (entry: Omit<HistoryEntry, "id" | "createdAt">) => {
      try {
        await addHistoryEntry({
          ...entry,
          id:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : String(Date.now() + Math.random()),
          createdAt: new Date().toISOString(),
        });
        await refreshHistory();
      } catch {
        // Saving history must never break the translation flow.
      }
    },
    [refreshHistory]
  );

  const revokeUrls = useCallback(() => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
  }, []);

  // Clean up any object URLs when the component unmounts.
  useEffect(() => revokeUrls, [revokeUrls]);

  const clearResults = useCallback(() => {
    setTextResult(null);
    setLayoutResult(null);
    setLastEvaluation(null);
    setCompareOpen(false);
    revokeUrls();
  }, [revokeUrls]);

  const onSelectFile = useCallback(
    (f: File | null) => {
      setError(null);
      clearResults();
      setFile(f);
    },
    [clearResults]
  );

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      setMode(next);
      setError(null);
      clearResults();
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    },
    [mode, clearResults]
  );

  // Switch to Text view but KEEP the selected file (used for PDFs in layout mode).
  const switchToTextKeepingFile = useCallback(() => {
    setMode("text");
    setError(null);
    clearResults();
  }, [clearResults]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) onSelectFile(dropped);
    },
    [onSelectFile]
  );

  const handleSubmit = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    clearResults();

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("targetLanguage", targetLanguage);
      form.append("sourceLanguage", "auto");
      form.append("evaluate", evaluate ? "1" : "0");
      form.append("translateImageText", translateImageText ? "1" : "0");

      if (mode === "text") {
        const res = await fetch("/api/translate", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Something went wrong while translating.");
        }
        setTextResult(data as TextResult);
        const evaluation =
          (data.evaluation as EvaluationReport | undefined) ?? null;
        setLastEvaluation(evaluation);
        await saveToHistory({
          mode: "text",
          fileName: file.name,
          targetLanguage,
          detectedLanguage: data.detectedLanguage,
          originalText: data.original,
          translatedText: data.translated,
          originalBlob: file,
          evaluation: evaluation ?? undefined,
        });
      } else {
        let res = await fetch("/api/translate-document", {
          method: "POST",
          body: form,
        });
        // Large PDFs run as an async split job: poll, then fetch the merged file.
        if (res.status === 202) {
          const job = await res.json();
          res = await pollLayoutJob(job.token, (done, total) =>
            setProgress({ done, total })
          );
        }
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || "Something went wrong while translating.");
        }
        setProgress(null);
        const blob = await res.blob();
        const translatedName = decodeURIComponent(
          res.headers.get("X-Translated-Filename") || file.name
        );
        const isImage = res.headers.get("X-Is-Image") === "1";
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

        let evaluation: EvaluationReport | null = null;
        const evalHeader = res.headers.get("X-Evaluation");
        if (evalHeader) {
          try {
            evaluation = JSON.parse(
              decodeURIComponent(evalHeader)
            ) as EvaluationReport;
          } catch {
            evaluation = null;
          }
        }
        setLastEvaluation(evaluation);

        const originalUrl = URL.createObjectURL(file);
        const translatedUrl = URL.createObjectURL(blob);
        urlsRef.current.push(originalUrl, translatedUrl);

        setLayoutResult({
          fileName: file.name,
          ext,
          originalUrl,
          translatedUrl,
          translatedName,
          targetLanguage,
          isImage,
        });

        await saveToHistory({
          mode: "layout",
          fileName: file.name,
          ext,
          isImage,
          translatedName,
          targetLanguage,
          originalBlob: file,
          translatedBlob: blob,
          evaluation: evaluation ?? undefined,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [file, targetLanguage, mode, evaluate, translateImageText, clearResults, saveToHistory]);

  const reset = useCallback(() => {
    setFile(null);
    setError(null);
    clearResults();
    if (inputRef.current) inputRef.current.value = "";
  }, [clearResults]);

  const hasResult = Boolean(textResult || layoutResult);
  // PDFs only need the "use Text view" nudge when batch (layout) PDF isn't available.
  const pdfInLayout =
    mode === "layout" &&
    !batchPdf &&
    !!file &&
    file.name.toLowerCase().endsWith(".pdf");

  // Which layout results can open in the full-screen synced compare view.
  const layoutCanCompare =
    !!layoutResult &&
    ["pdf", "png", "jpg", "jpeg", "bmp", "webp", "gif"].includes(layoutResult.ext);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-10 sm:px-8">
      <div className="mb-2 flex items-center justify-end gap-2">
        <button
          onClick={() => setHistoryOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.8}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          History
          {history.length > 0 ? (
            <span className="ml-0.5 rounded-full bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-blue-200">
              {history.length}
            </span>
          ) : null}
        </button>
        <SignOutButton />
      </div>
      {/* Header */}
      <header className="mb-7 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Powered by Azure AI Document Intelligence + Translator
        </div>
        <h1 className="bg-gradient-to-r from-white via-blue-100 to-purple-200 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
          Document Translator
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm text-slate-400">
          Upload a PDF, Word document or image, translate it with Azure AI, and
          compare the result side by side.
        </p>
      </header>

      {/* Controls card */}
      <section className="mx-auto w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-900/50 p-5 shadow-2xl backdrop-blur sm:p-6">
        {/* Mode toggle */}
        <div className="mb-5">
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-slate-800/60 p-1">
            <ModeButton
              active={mode === "text"}
              onClick={() => switchMode("text")}
              title="Text view"
              subtitle="OCR + side-by-side text"
            />
            <ModeButton
              active={mode === "layout"}
              onClick={() => switchMode("layout")}
              title="Preserve layout"
              subtitle="Keep tables, format & images"
            />
          </div>
        </div>

        {/* Dropzone */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`group flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-9 text-center transition ${
            dragging
              ? "border-blue-400 bg-blue-500/10"
              : "border-white/15 hover:border-blue-400/60 hover:bg-white/5"
          }`}
        >
          <svg
            className="mb-3 h-9 w-9 text-slate-400 transition group-hover:text-blue-300"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          {file ? (
            <div className="text-sm">
              <p className="font-semibold text-slate-100">{file.name}</p>
              <p className="mt-0.5 text-slate-400">
                {(file.size / 1024).toFixed(0)} KB · click to replace
              </p>
            </div>
          ) : (
            <div className="text-sm">
              <p className="font-medium text-slate-200">
                Drop a document here, or{" "}
                <span className="text-blue-300">browse</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {mode === "text"
                  ? "PDF, DOCX, XLSX, PPTX, PNG, JPG, TIFF · up to 40 MB"
                  : batchPdf
                    ? "PDF, DOCX, PPTX, XLSX, HTML, PNG, JPG keep layout · PDF up to 30 MB, others 10 MB"
                    : "DOCX, PPTX, XLSX, HTML, PNG, JPG keep layout · PDF → use Text view"}
              </p>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={
              mode === "text"
                ? TEXT_ACCEPTED
                : batchPdf
                  ? `.pdf,${LAYOUT_ACCEPTED}`
                  : LAYOUT_ACCEPTED
            }
            className="hidden"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onSelectFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {/* Language + action row */}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm">
            <span className="mb-1.5 block font-medium text-slate-300">
              Translate to
            </span>
            <select
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-slate-800/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={!file || loading || pdfInLayout}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Spinner />{" "}
                  {progress
                    ? `Translating ${progress.done}/${progress.total} pages…`
                    : "Processing…"}
                </>
              ) : (
                <>Translate document</>
              )}
            </button>
            {(file || hasResult) && !loading ? (
              <button
                onClick={reset}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10"
              >
                Reset
              </button>
            ) : null}
          </div>
        </div>

        {/* Image-text toggle — Preserve layout only. Translates text baked into
            charts/figures/stamps; off = cleaner, faster, digital text only. */}
        {mode === "layout" ? (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-white/10 bg-slate-800/40 px-4 py-3">
            <Switch
              checked={translateImageText}
              onChange={toggleImageText}
              label="Translate text inside images"
            />
            <div className="text-sm">
              <p className="font-medium text-slate-200">
                Translate text inside images
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Also translates text baked into charts, figures, screenshots and
                stamps, re-rendered in place. On by default. Turn off for cleaner,
                faster output when only the digital text needs translating.
              </p>
            </div>
          </div>
        ) : null}

        {/* Evaluation toggle — opt-in & modular, so it never slows a normal run. */}
        {evaluationEnabled ? (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-white/10 bg-slate-800/40 px-4 py-3">
            <Switch
              checked={evaluate}
              onChange={toggleEvaluate}
              label="Generate evaluation report"
            />
            <div className="text-sm">
              <p className="font-medium text-slate-200">
                Generate evaluation report
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Adds characters, estimated cost and processing time for each
                translation. Off by default — runs only when enabled. Non-PDF
                layout files add a short OCR step to count characters.
              </p>
            </div>
          </div>
        ) : null}

        {/* PDF-in-layout helper: PDFs aren't supported by the sync layout API. */}
        {pdfInLayout && !loading ? (
          <div className="mt-4 flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between">
            <span>
              PDFs can&apos;t be translated in <strong>Preserve layout</strong>{" "}
              mode. Use <strong>Text view</strong> to translate this PDF.
            </span>
            <button
              onClick={switchToTextKeepingFile}
              className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-amber-950 transition hover:bg-amber-400"
            >
              Switch to Text view
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}
      </section>

      {/* Loading skeleton */}
      {loading ? (
        <section className="mt-8 grid flex-1 gap-5 lg:grid-cols-2">
          <SkeletonPane tall={mode === "layout"} />
          <SkeletonPane tall={mode === "layout"} />
        </section>
      ) : null}

      {/* Text results */}
      {textResult && !loading ? (
        <section className="mt-8 flex flex-1 animate-fade-in flex-col">
          <ResultHeader
            fileName={textResult.fileName}
            detected={languageName(textResult.detectedLanguage)}
            target={languageName(textResult.targetLanguage)}
          />
          <div className="grid flex-1 gap-5 lg:grid-cols-2">
            <DocumentPane
              title="Original (OCR)"
              badge={languageName(textResult.detectedLanguage)}
              text={textResult.original}
              accent="slate"
            />
            <DocumentPane
              title="Translated"
              badge={languageName(textResult.targetLanguage)}
              text={textResult.translated}
              accent="blue"
            />
          </div>
          {lastEvaluation ? (
            <EvaluationReportCard report={lastEvaluation} className="mt-5" />
          ) : null}
        </section>
      ) : null}

      {/* Layout (document) results */}
      {layoutResult && !loading ? (
        <section className="mt-8 flex flex-1 animate-fade-in flex-col">
          <ResultHeader
            fileName={layoutResult.fileName}
            target={languageName(layoutResult.targetLanguage)}
            note={
              layoutResult.isImage
                ? "Text rendered back onto the image"
                : "Layout & formatting preserved"
            }
          />
          {layoutCanCompare ? (
            <div className="mb-4 flex justify-end">
              <button
                onClick={() => setCompareOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-400/30 bg-blue-500/10 px-3.5 py-2 text-sm font-semibold text-blue-100 transition hover:bg-blue-500/20"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.8}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 3.75h6v6m10.5 10.5h-6v-6m6-10.5-7.5 7.5m-3 3L3.75 20.25"
                  />
                </svg>
                Full-screen compare
              </button>
            </div>
          ) : null}
          <div className="grid flex-1 gap-5 lg:grid-cols-2">
            <DocumentPreview
              title="Original"
              accent="slate"
              src={layoutResult.originalUrl}
              ext={layoutResult.ext}
              downloadName={layoutResult.fileName}
            />
            <DocumentPreview
              title="Translated"
              badge={languageName(layoutResult.targetLanguage)}
              accent="blue"
              src={layoutResult.translatedUrl}
              ext={layoutResult.ext}
              downloadName={layoutResult.translatedName}
            />
          </div>
          {lastEvaluation ? (
            <EvaluationReportCard report={lastEvaluation} className="mt-5" />
          ) : null}
          <PdfCompareOverlay
            open={compareOpen}
            onClose={() => setCompareOpen(false)}
            original={{
              url: layoutResult.originalUrl,
              name: layoutResult.fileName,
              ext: layoutResult.ext,
            }}
            translated={{
              url: layoutResult.translatedUrl,
              name: layoutResult.translatedName,
              ext: layoutResult.ext,
            }}
            originalLabel="Original"
            translatedLabel={`Translated · ${languageName(layoutResult.targetLanguage)}`}
          />
        </section>
      ) : null}

      {/* Empty state */}
      {!hasResult && !loading ? (
        <section className="mt-8 grid flex-1 gap-5 lg:grid-cols-2">
          {mode === "text" ? (
            <>
              <DocumentPane
                title="Original (OCR)"
                text=""
                accent="slate"
                emptyHint="Extracted text will appear here."
              />
              <DocumentPane
                title="Translated"
                text=""
                accent="blue"
                emptyHint="The translation will appear here."
              />
            </>
          ) : (
            <>
              <DocumentPreview
                title="Original"
                accent="slate"
                src={null}
                ext=""
                downloadName=""
                emptyHint="A preview of your document will appear here."
              />
              <DocumentPreview
                title="Translated"
                accent="blue"
                src={null}
                ext=""
                downloadName=""
                emptyHint="The translated document will appear here."
              />
            </>
          )}
        </section>
      ) : null}

      <footer className="mt-10 text-center text-xs text-slate-600">
        Built with Next.js · Azure AI Document Intelligence &amp; Azure AI
        Translator
      </footer>

      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        entries={history}
        onDelete={async (id) => {
          try {
            await deleteHistoryEntry(id);
            await refreshHistory();
          } catch {
            // ignore — best-effort
          }
        }}
        onClear={async () => {
          try {
            await clearHistory();
            setHistory([]);
          } catch {
            // ignore — best-effort
          }
        }}
      />
    </main>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-4 py-2.5 text-left transition ${
        active
          ? "bg-blue-600 text-white shadow"
          : "text-slate-300 hover:bg-white/5"
      }`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span
        className={`block text-xs ${active ? "text-blue-100" : "text-slate-500"}`}
      >
        {subtitle}
      </span>
    </button>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${
        checked ? "bg-blue-600" : "bg-slate-600"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/login", { method: "DELETE" });
        } catch {
          // ignore — navigate to login regardless
        }
        window.location.href = "/login";
      }}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 disabled:opacity-50"
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.8}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75"
        />
      </svg>
      Sign out
    </button>
  );
}

function ResultHeader({
  fileName,
  detected,
  target,
  note,
}: {
  fileName: string;
  detected?: string;
  target: string;
  note?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">{fileName}</h2>
        {note ? <p className="text-xs text-slate-500">{note}</p> : null}
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-400">
        {detected ? (
          <span className="rounded-full bg-slate-700/50 px-2.5 py-1">
            Detected: {detected}
          </span>
        ) : null}
        <svg
          className="h-4 w-4 text-slate-500"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.5 12h15m0 0-6-6m6 6-6 6"
          />
        </svg>
        <span className="rounded-full bg-blue-500/20 px-2.5 py-1 text-blue-200">
          {target}
        </span>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function SkeletonPane({ tall }: { tall?: boolean }) {
  return (
    <div
      className={`flex flex-col rounded-2xl bg-slate-900/60 ring-1 ring-slate-700/60 ${
        tall ? "min-h-[380px]" : "min-h-[260px]"
      }`}
    >
      <div className="border-b border-white/5 px-5 py-3">
        <div className="h-4 w-32 animate-pulse rounded bg-slate-700/60" />
      </div>
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded bg-slate-700/40"
            style={{ width: `${70 + ((i * 7) % 30)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
