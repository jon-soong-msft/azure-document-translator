"use client";

import type { EvaluationReport } from "@/lib/evaluation";
import {
  formatCount,
  formatDuration,
  formatUnitPrice,
  formatUSD,
} from "@/lib/evaluation";

/**
 * Renders an {@link EvaluationReport}: headline metrics (characters, estimated
 * cost, processing time) plus a per-service cost breakdown. Reused for the live
 * result and for stored history entries.
 */
export default function EvaluationReportCard({
  report,
  className = "",
  compact = false,
}: {
  report: EvaluationReport;
  className?: string;
  compact?: boolean;
}) {
  const { characters, cost } = report;

  const charValue =
    characters.charged != null
      ? formatCount(characters.charged)
      : characters.source != null
        ? formatCount(characters.source)
        : report.images != null
          ? `${report.images} image${report.images === 1 ? "" : "s"}`
          : "—";

  const charSub =
    characters.charged != null
      ? "billed characters"
      : characters.source != null
        ? characters.translated != null
          ? `source · ${formatCount(characters.translated)} translated`
          : "source characters"
        : report.images != null
          ? "billed per image"
          : "";

  return (
    <div
      className={`rounded-2xl border border-white/10 bg-slate-900/60 p-5 backdrop-blur ${className}`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <svg
            className="h-4 w-4 text-emerald-300"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.8}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
            />
          </svg>
          <h3 className="text-sm font-semibold text-slate-100">
            Evaluation report
          </h3>
        </div>
        <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
          {report.mode === "text" ? "Text view" : "Preserve layout"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Metric label="Characters" value={charValue} sub={charSub} />
        <Metric
          label="Est. cost"
          value={formatUSD(cost.totalUSD)}
          sub={`${cost.currency} · ${cost.region}`}
        />
        <Metric label="Processing" value={formatDuration(report.processingMs)} />
      </div>

      {!compact && cost.items.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-white/5">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-white/5 text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Service &amp; meter</th>
                <th className="px-3 py-2 text-right font-medium">Units</th>
                <th className="px-3 py-2 text-right font-medium">Unit price</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {cost.items.map((item, i) => (
                <tr key={i} className="text-slate-300">
                  <td className="px-3 py-2">{item.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCount(item.units)}
                    <span className="ml-1 text-slate-500">{item.unit}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                    {formatUnitPrice(item)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-100">
                    {formatUSD(item.costUSD)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/10 bg-white/5 font-semibold text-slate-100">
                <td className="px-3 py-2" colSpan={3}>
                  Total
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatUSD(cost.totalUSD)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      {cost.estimated ? (
        <p className="mt-3 text-xs text-amber-300/80">
          Cost marked as an estimate: exact billed characters aren&apos;t
          reported for this file type, so character count is derived from OCR /
          source text.
        </p>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          Estimated from public Azure retail prices ({cost.region}); actual
          billing depends on your tier and region.
        </p>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl bg-white/5 px-3 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 truncate text-lg font-semibold text-slate-100">
        {value}
      </p>
      {sub ? <p className="mt-0.5 truncate text-[11px] text-slate-500">{sub}</p> : null}
    </div>
  );
}
