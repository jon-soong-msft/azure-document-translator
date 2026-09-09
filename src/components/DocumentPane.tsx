"use client";

interface DocumentPaneProps {
  title: string;
  badge?: string;
  text: string;
  accent: "slate" | "blue";
  emptyHint?: string;
}

const accents: Record<
  DocumentPaneProps["accent"],
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

export default function DocumentPane({
  title,
  badge,
  text,
  accent,
  emptyHint,
}: DocumentPaneProps) {
  const a = accents[accent];

  return (
    <div
      className={`flex h-full flex-col rounded-2xl bg-slate-900/60 ring-1 ${a.ring} backdrop-blur`}
    >
      <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${a.dot}`} />
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        </div>
        {badge ? (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${a.badge}`}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div className="doc-scroll min-h-[260px] flex-1 overflow-auto px-5 py-4">
        {text ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-200">
            {text}
          </pre>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-slate-500">{emptyHint}</p>
          </div>
        )}
      </div>
    </div>
  );
}
