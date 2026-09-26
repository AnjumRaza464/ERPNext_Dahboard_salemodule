"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { compact, num, pkr } from "@/lib/format";
import ChartTooltip from "./ChartTooltip";

export interface DonutRow {
  label: string;
  value: number;
  /** optional secondary figure shown in the legend (e.g. "121 inv", "75 items") */
  note?: string;
  /** an explicit remainder ("all other items"): always drawn last, in grey, never folded */
  other?: boolean;
}

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];
const OTHER = "var(--ink-3)";
const MAX_SEGMENTS = 5;

interface Props {
  rows: DonutRow[];
  total?: number;
  /** text under the centre figure */
  centerLabel?: string;
  size?: number;
  format?: (v: number) => string;
}

/**
 * Part-to-whole donut with a legend list. Categorical hues are assigned in fixed
 * order; anything past the 5th segment folds into "Other" so the ring stays readable.
 */
export default function DonutChart({ rows, total, centerLabel = "Total", size = 190, format = (v) => pkr(v) }: Props) {
  const sum = total ?? rows.reduce((s, r) => s + Math.max(0, r.value), 0);
  const explicitOther = rows.filter((r) => r.other && r.value > 0);
  const sorted = rows.filter((r) => !r.other && r.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, MAX_SEGMENTS);
  const tail = sorted.slice(MAX_SEGMENTS);
  const otherValue = tail.reduce((s, r) => s + r.value, 0) + explicitOther.reduce((s, r) => s + r.value, 0);
  const otherRow: DonutRow | null =
    otherValue > 0
      ? { label: explicitOther[0]?.label ?? "Other", value: otherValue, note: explicitOther[0]?.note ?? `${tail.length} more`, other: true }
      : null;
  const segments: DonutRow[] = otherRow ? [...head, otherRow] : head;
  const colorAt = (i: number) => (segments[i].other ? OTHER : SERIES[i]);

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Pie
              data={segments}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="62%"
              outerRadius="94%"
              paddingAngle={1.5}
              startAngle={90}
              endAngle={-270}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {segments.map((s, i) => (
                <Cell key={s.label} fill={colorAt(i)} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip noSwatch labelFormat={() => ""} format={(v) => `${format(v)} · ${sum ? num((v / sum) * 100, 1) : 0}%`} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-[10px] uppercase tracking-wide text-ink-3">{centerLabel}</span>
          <span className="tnum text-base font-semibold text-ink">{compact(sum)}</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5 self-stretch text-xs sm:justify-center">
        {segments.map((s, i) => (
          <li key={s.label} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorAt(i) }} />
              <span className="truncate text-ink">{s.label}</span>
              {s.note && <span className="hidden shrink-0 text-ink-3 xl:inline">· {s.note}</span>}
            </span>
            <span className="tnum shrink-0 text-ink-2">
              <span className="font-medium text-ink">{format(s.value)}</span> · {sum ? num((s.value / sum) * 100, 1) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
