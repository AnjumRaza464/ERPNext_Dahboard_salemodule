"use client";

import { pct } from "@/lib/format";
import { Skeleton } from "./States";

interface Props {
  label: string;
  value: string;
  sub?: string;
  /** percentage change vs previous period; null hides the delta */
  delta?: number | null;
  /** when true a positive delta is bad (e.g. expenses, outstanding) */
  invert?: boolean;
  loading?: boolean;
  refreshing?: boolean;
  error?: boolean;
}

function DeltaArrow({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      {up ? <path d="M12 19V5m0 0l-6 6m6-6l6 6" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M12 5v14m0 0l6-6m-6 6l-6-6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

export default function KpiCard({ label, value, sub, delta, invert, loading, refreshing, error }: Props) {
  const hasDelta = delta !== null && delta !== undefined && Number.isFinite(delta);
  const positive = hasDelta && (invert ? delta! < 0 : delta! > 0);
  const negative = hasDelta && (invert ? delta! > 0 : delta! < 0);
  const tone = positive ? "text-good" : negative ? "text-bad" : "text-ink-3";

  return (
    <div className={`card flex flex-col gap-1 p-4 transition-opacity ${refreshing ? "opacity-60" : ""}`}>
      <span className="text-xs font-medium uppercase tracking-wide text-ink-3">{label}</span>
      {loading ? (
        <>
          <Skeleton className="mt-1 h-7 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </>
      ) : error ? (
        <span className="text-lg font-semibold text-ink-3">—</span>
      ) : (
        <>
          <span className="truncate text-2xl font-semibold leading-tight text-ink" title={value}>
            {value}
          </span>
          <div className="flex items-center gap-2 text-xs">
            {hasDelta && (
              <span className={`inline-flex items-center gap-0.5 font-medium ${tone}`} title="vs previous period of the same length">
                {delta !== 0 && <DeltaArrow up={delta! > 0} />}
                {pct(delta)}
              </span>
            )}
            {sub && <span className="truncate text-ink-3">{sub}</span>}
          </div>
        </>
      )}
    </div>
  );
}
