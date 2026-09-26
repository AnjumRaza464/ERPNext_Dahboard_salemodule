"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact } from "@/lib/format";
import ChartTooltip, { type TooltipEntry } from "./ChartTooltip";

export interface ColumnRow {
  label: string;
  value: number;
  [k: string]: unknown;
}

interface Props {
  rows: ColumnRow[];
  format: (value: number, entry: TooltipEntry) => string;
  seriesName?: string;
  height?: number;
  /** one colour for all bars (nominal) */
  color?: string;
  /** ordered buckets → ordinal blue ramp */
  ordinal?: boolean;
  /** explicit colour per bar (distinct entities, e.g. Assets / Liabilities / Equity) */
  colors?: string[];
  /** emphasis: the matching bar keeps the series colour, the rest go grey */
  highlight?: (row: ColumnRow, index: number) => boolean;
  /** show every Nth x tick */
  tickEvery?: number;
  yFormat?: (v: number) => string;
}

const ORDINAL = ["var(--ord-1)", "var(--ord-2)", "var(--ord-3)", "var(--ord-4)", "var(--ord-5)"];

/** Single-series vertical bars. */
export default function ColumnChart({
  rows, format, seriesName = "Amount", height = 240, color = "var(--series-1)", ordinal, colors, highlight, tickEvery = 1, yFormat = compact,
}: Props) {
  const hasNegative = rows.some((r) => r.value < 0);
  const anyHighlight = highlight ? rows.some((r, i) => highlight(r, i)) : false;
  const fillFor = (row: ColumnRow, i: number) => {
    if (colors) return colors[i % colors.length];
    if (ordinal) return ORDINAL[Math.min(Math.floor((i / Math.max(1, rows.length - 1)) * (ORDINAL.length - 1)), ORDINAL.length - 1)];
    if (highlight && anyHighlight) return highlight(row, i) ? color : "var(--ink-3)";
    return color;
  };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
        <CartesianGrid vertical={false} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} interval={tickEvery - 1} tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={(v: number) => yFormat(v)} tickLine={false} axisLine={false} width={48} />
        {hasNegative && <ReferenceLine y={0} stroke="var(--axis)" />}
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip noSwatch format={format} />} />
        <Bar dataKey="value" name={seriesName} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={fillFor(r, i)} fillOpacity={highlight && anyHighlight && !highlight(r, i) ? 0.55 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
