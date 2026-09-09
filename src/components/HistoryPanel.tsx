"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { HistoryEntry } from "@/lib/history";
import { languageName } from "@/lib/languages";
import { formatDuration, formatUSD } from "@/lib/evaluation";
import EvaluationReportCard from "./EvaluationReportCard";

/**
 * Slide-over drawer listing past translations with re-download links and, when
 * available, the evaluation report. Rendered through a portal to document.body
 * so the fixed overlay isn't trapped by any transformed ancestor.
 */
export default function HistoryPanel({
  open,
  onClose,
  entries,
  onDelete,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  entries: HistoryEntry[];
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-slate-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Processing history
            </h2>
            <p className="text-xs text-slate-500">
              {entries.length
                ? `${entries.length} translation${entries.length === 1 ? "" : "s"} · stored in this browser`
                : "Stored in this browser"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {entries.length > 0 ? (
              <button
                onClick={onClear}
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10"
              >
                Clear all
              </button>
            ) : null}
            <button
              onClick={onClose}
              aria-label="Close history"
              className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10"
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
                  d="M6 18 18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </header>

        <div className="doc-scroll flex-1 overflow-auto px-4 py-4">
          {entries.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="text-sm text-slate-500">
                No translations yet. Translated documents will appear here, ready
                to download.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {entries.map((entry) => (
                <HistoryItem key={entry.id} entry={entry} onDelete={onDelete} />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>,
    document.body
  );
}

function HistoryItem({
  entry,
  onDelete,
}: {
  entry: HistoryEntry;
  onDelete: (id: string) => void;
}) {
  const when = new Date(entry.createdAt);
  const translatedTextName = textDownloadName(entry);

  return (
    <li className="rounded-xl border border-white/10 bg-slate-800/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-100">
            {entry.fileName}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {when.toLocaleString()}
          </p>
        </div>
        <button
          onClick={() => onDelete(entry.id)}
          aria-label="Delete entry"
          className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-400 transition hover:bg-red-500/15 hover:text-red-300"
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
              d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
            />
          </svg>
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Tag>
          {entry.mode === "text" ? "Text view" : "Preserve layout"}
        </Tag>
        {entry.detectedLanguage ? (
          <Tag>{languageName(entry.detectedLanguage)} →</Tag>
        ) : null}
        <Tag accent>{languageName(entry.targetLanguage)}</Tag>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {entry.originalBlob ? (
          <DownloadButton
            blob={entry.originalBlob}
            name={entry.fileName}
            label="Original"
          />
        ) : null}
        {entry.translatedBlob ? (
          <DownloadButton
            blob={entry.translatedBlob}
            name={entry.translatedName ?? entry.fileName}
            label="Translated"
            primary
          />
        ) : entry.translatedText != null ? (
          <DownloadButton
            blob={
              new Blob([entry.translatedText], {
                type: "text/plain;charset=utf-8",
              })
            }
            name={translatedTextName}
            label="Translated text (.txt)"
            primary
          />
        ) : null}
      </div>

      {entry.evaluation ? (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-emerald-300/90">
            <span className="inline-flex h-4 w-4 items-center justify-center rounded border border-emerald-400/30 text-[10px] transition group-open:rotate-90">
              ›
            </span>
            Evaluation · {formatUSD(entry.evaluation.cost.totalUSD)} ·{" "}
            {formatDuration(entry.evaluation.processingMs)}
          </summary>
          <EvaluationReportCard
            report={entry.evaluation}
            className="mt-2 !bg-slate-900/80"
          />
        </details>
      ) : null}
    </li>
  );
}

function Tag({
  children,
  accent = false,
}: {
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        accent
          ? "bg-blue-500/20 text-blue-200"
          : "bg-slate-700/50 text-slate-300"
      }`}
    >
      {children}
    </span>
  );
}

function DownloadButton({
  blob,
  name,
  label,
  primary = false,
}: {
  blob: Blob;
  name: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={() => downloadBlob(blob, name)}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        primary
          ? "bg-blue-600 text-white hover:bg-blue-500"
          : "border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
      }`}
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
          d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
        />
      </svg>
      {label}
    </button>
  );
}

function textDownloadName(entry: HistoryEntry): string {
  const dot = entry.fileName.lastIndexOf(".");
  const base = dot > 0 ? entry.fileName.slice(0, dot) : entry.fileName;
  return `${base}.${entry.targetLanguage}.txt`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
