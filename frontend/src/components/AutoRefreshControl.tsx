"use client";

import { useEffect, useState } from "react";

export interface IntervalOption {
  /** seconds; 0 = off */
  value: number;
  label: string;
}

/** Choices for the live comparison board (a handful of cheap POS queries). */
export const LIVE_INTERVALS: IntervalOption[] = [
  { value: 0, label: "Off" },
  { value: 15, label: "15 s" },
  { value: 30, label: "30 s" },
  { value: 60, label: "1 min" },
  { value: 120, label: "2 min" },
  { value: 300, label: "5 min" },
];

/** Choices for the whole dashboard (every panel reloads, bypassing the backend cache). */
export const DASHBOARD_INTERVALS: IntervalOption[] = [
  { value: 0, label: "Off" },
  { value: 30, label: "30 s" },
  { value: 60, label: "1 min" },
  { value: 120, label: "2 min" },
  { value: 300, label: "5 min" },
  { value: 600, label: "10 min" },
];

/** NEXT_PUBLIC_* value (seconds) -> a usable interval, else the fallback. */
export function parseIntervalEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/** Makes sure the configured default is one of the offered choices. */
export function withDefault(options: IntervalOption[], seconds: number): IntervalOption[] {
  if (options.some((o) => o.value === seconds)) return options;
  const label = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
  return [...options, { value: seconds, label }].sort((a, b) => a.value - b.value);
}

/** "next refresh in 42s", ticking once a second; isolated so the parent does not re-render every second. */
export function RefreshCountdown({
  nextAt, intervalSec, prefix = "Live · next refresh in ", offText = "Auto-refresh off",
}: { nextAt: number | null; intervalSec: number; prefix?: string; offText?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [nextAt]);
  if (!intervalSec || nextAt === null) return offText ? <span>{offText}</span> : null;
  const left = Math.max(0, Math.round((nextAt - now) / 1000));
  return (
    <span className="tnum">
      {prefix}
      {left}s
    </span>
  );
}

interface ControlProps {
  value: number;
  options: IntervalOption[];
  onChange: (seconds: number) => void;
  label?: string;
  /** pulsing dot in front of the label while auto-refresh is on */
  showDot?: boolean;
  title?: string;
}

/** "Auto-refresh [1 min]" select. */
export function AutoRefreshControl({ value, options, onChange, label = "Auto-refresh", showDot, title }: ControlProps) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-3" title={title}>
      {showDot && <span className={`live-dot ${value ? "live-dot-on" : ""}`} aria-hidden="true" />}
      {label}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
        aria-label={`${label} interval`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
