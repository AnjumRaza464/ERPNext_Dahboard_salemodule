"use client";

import { pct } from "@/lib/format";

/** "+8.2%" in green / "-3.1%" in red; a dash when there is nothing to compare against. */
export default function DeltaText({ value, invert, className = "" }: { value: number | null | undefined; invert?: boolean; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={`text-ink-3 ${className}`}>—</span>;
  const positive = invert ? value < 0 : value > 0;
  const negative = invert ? value > 0 : value < 0;
  return <span className={`tnum font-medium ${positive ? "text-good" : negative ? "text-bad" : "text-ink-3"} ${className}`}>{pct(value)}</span>;
}
