"use client";

interface DocumentPreviewProps {
  title: string;
  badge?: string;
  accent: "slate" | "blue";
  /** Object URL for the file to preview, or null when empty. */
  src: string | null;
  /** Lower-case file extension, e.g. "pdf", "png", "docx". */
  ext: string;
  /** File name to use when downloading. */
  downloadName: string;
  emptyHint?: string;
}

const accents: Record<
  DocumentPreviewProps["accent"],
  { ring: string; dot: string; badge: string }
> = {
  slate: {
    ring: "ring-slate-700/60",
    dot: "bg-slate-400",
    badge: "bg-slate-700/50 text-slate-200",
  },
  blue: {
    ring: "ring-blue-500/40",
    dot: "bg-blue-400",
    badge: "bg-blue-500/20 text-blue-200",
  },
};

const IFRAME_EXT = ["pdf", "html", "htm", "txt", "csv", "tsv", "md"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "bmp", "webp", "gif"];

export default function DocumentPreview({
  title,
  badge,
  accent,
  src,
  ext,
  downloadName,
  emptyHint,
}: DocumentPreviewProps) {
  const a = accents[accent];
  const canIframe = IFRAME_EXT.includes(ext);
  const canImage = IMAGE_EXT.includes(ext);

  return (
    <div
      className={`flex h-full flex-col rounded-2xl bg-slate-900/60 ring-1 ${a.ring} backdrop-blur`}
    >
      <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${a.dot}`} />
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          {badge ? (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${a.badge}`}
            >
              {badge}
            </span>
          ) : null}
          {src ? (
            <a
              href={src}
              download={downloadName}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-white/10"
            >
              Download
            </a>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-[380px] flex-1 overflow-hidden rounded-b-2xl">
        {!src ? (
          <div className="flex h-full items-center justify-center px-5">
            <p className="text-sm text-slate-500">{emptyHint}</p>
          </div>
        ) : canImage ? (
          <div className="doc-scroll flex h-full items-center justify-center overflow-auto bg-white/5 p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={title}
              className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
            />
          </div>
        ) : canIframe ? (
          <iframe
            src={src}
            title={title}
            className="h-full w-full bg-white"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            <svg
              className="h-14 w-14 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
              />
            </svg>
            <div>
              <p className="text-sm font-medium text-slate-200">
                Translated {ext.toUpperCase()} ready
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Inline preview isn&apos;t available for this format. Download to
                open it with full formatting preserved.
              </p>
            </div>
            <a
              href={src}
              download={downloadName}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              Download {ext.toUpperCase()}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
