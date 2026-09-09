"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface FileRef {
  url: string;
  name: string;
  ext: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  original: FileRef;
  translated: FileRef;
  originalLabel?: string;
  translatedLabel?: string;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "bmp", "webp", "gif"];

/**
 * Renders a single document (PDF or image) into a scroll container. PDFs are
 * drawn page-by-page to canvases with pdf.js so we fully control the layout
 * (no native viewer chrome) and can synchronize scrolling between panes.
 */
async function renderInto(
  container: HTMLDivElement | null,
  file: FileRef,
  zoom: number,
  isCancelled: () => boolean
): Promise<void> {
  if (!container) return;
  container.replaceChildren();
  const ext = file.ext.toLowerCase();

  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement("img");
    img.src = file.url;
    img.alt = file.name;
    img.className = "mx-auto block rounded shadow-lg";
    img.style.width = `${Math.round(zoom * 100)}%`;
    img.style.maxWidth = zoom <= 1 ? "100%" : "none";
    container.appendChild(img);
    return;
  }

  if (ext !== "pdf") {
    const note = document.createElement("p");
    note.className = "px-6 py-10 text-center text-sm text-slate-400";
    note.textContent = "Inline comparison isn't available for this format.";
    container.appendChild(note);
    return;
  }

  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const task = pdfjs.getDocument({ url: file.url });
  const pdf = await task.promise;
  if (isCancelled()) {
    void task.destroy();
    return;
  }

  const available = Math.max(container.clientWidth - 24, 240); // minus padding
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    if (isCancelled()) break;
    const page = await pdf.getPage(pageNum);
    const unscaled = page.getViewport({ scale: 1 });
    const fitScale = available / unscaled.width;
    const viewport = page.getViewport({ scale: fitScale * zoom * dpr });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    canvas.className = "mx-auto mb-3 block rounded bg-white shadow-lg";

    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    container.appendChild(canvas);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  }

  if (isCancelled()) void task.destroy();
}

export default function PdfCompareOverlay({
  open,
  onClose,
  original,
  translated,
  originalLabel = "Original",
  translatedLabel = "Translated",
}: Props) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncLock = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape and lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // (Re)render both documents when opened, sources change, or zoom changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cancel = () => cancelled;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        await Promise.all([
          renderInto(leftRef.current, original, zoom, cancel),
          renderInto(rightRef.current, translated, zoom, cancel),
        ]);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not render the documents.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, original, translated, zoom]);

  // Mirror scrolling (both axes) from whichever pane the user is scrolling.
  const handleScroll = useCallback((source: "left" | "right") => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right || syncLock.current) return;
    syncLock.current = true;
    const from = source === "left" ? left : right;
    const to = source === "left" ? right : left;

    // Vertical: match by ratio (page heights can differ slightly).
    const vDenom = from.scrollHeight - from.clientHeight;
    if (vDenom > 0) {
      const ratio = from.scrollTop / vDenom;
      to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    }

    // Horizontal: panes share width and zoom, so mirror the absolute offset
    // (clamped) to keep the same region visible when zoomed in.
    const hMax = to.scrollWidth - to.clientWidth;
    if (hMax > 0) {
      to.scrollLeft = Math.min(from.scrollLeft, hMax);
    }

    requestAnimationFrame(() => {
      syncLock.current = false;
    });
  }, []);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <svg className="h-4 w-4 text-blue-300" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v16.5h16.5V3.75H3.75ZM12 3.75v16.5" />
          </svg>
          Side-by-side comparison · synced scroll
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-1 text-slate-200">
            <button
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
              className="rounded px-2 py-1 text-sm font-semibold hover:bg-white/10"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              onClick={() => setZoom(1)}
              className="rounded px-2 py-1 text-xs font-medium hover:bg-white/10"
            >
              Fit
            </button>
            <button
              onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
              className="rounded px-2 py-1 text-sm font-semibold hover:bg-white/10"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>

          <a
            href={translated.url}
            download={translated.name}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10"
          >
            Download translated
          </a>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-slate-100 transition hover:bg-white/20"
            aria-label="Close comparison"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
            Close
          </button>
        </div>
      </div>

      {/* Panes */}
      <div className="relative grid min-h-0 flex-1 grid-cols-2 gap-px bg-white/10">
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-white/10 bg-slate-900/80 px-4 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-slate-400" />
            <span className="text-xs font-semibold text-slate-200">{originalLabel}</span>
          </div>
          <div
            ref={leftRef}
            onScroll={() => handleScroll("left")}
            className="doc-scroll min-h-0 flex-1 overflow-auto bg-slate-800/30 p-3"
          />
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-white/10 bg-slate-900/80 px-4 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-400" />
            <span className="text-xs font-semibold text-slate-200">{translatedLabel}</span>
          </div>
          <div
            ref={rightRef}
            onScroll={() => handleScroll("right")}
            className="doc-scroll min-h-0 flex-1 overflow-auto bg-slate-800/30 p-3"
          />
        </div>

        {loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-lg bg-slate-900/90 px-4 py-2 text-sm text-slate-200 shadow-lg">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-blue-400" />
              Rendering…
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="absolute inset-x-0 top-3 mx-auto w-fit rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
