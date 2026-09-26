"use client";

import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact } from "@/lib/format";
import ChartTooltip, { type TooltipEntry } from "./ChartTooltip";

export interface BarRow {
  label: string;
  value: number;
  [k: string]: unknown;
}

interface Props {
  rows: BarRow[];
  color?: string;
  /** rows are ordered categories → use the ordinal ramp */
  ordinal?: boolean;
  format: (value: number, entry: TooltipEntry) => string;
  height?: number;
  seriesName?: string;
  /** explicit colour per row (e.g. diverging: gains vs drops) */
  colorFor?: (row: BarRow, index: number) => string;
  /** width of the category axis */
  labelWidth?: number;
}

const ORDINAL = ["var(--ord-1)", "var(--ord-2)", "var(--ord-3)", "var(--ord-4)", "var(--ord-5)"];

/** Single-series horizontal bar list: one colour for nominal categories, ordinal ramp when ordered. */
export default function HorizontalBars({ rows, color = "var(--series-1)", ordinal, format, height, seriesName = "Amount", colorFor, labelWidth = 150 }: Props) {
  const h = height ?? Math.max(180, rows.length * 30 + 24);
  const hasNegative = rows.some((r) => r.value < 0);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 40, left: 4, bottom: 0 }} barCategoryGap={6}>
        <XAxis type="number" tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} height={22} />
        <YAxis type="category" dataKey="label" width={labelWidth} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip noSwatch format={format} />} />
        {hasNegative && <ReferenceLine x={0} stroke="var(--axis)" />}
        <Bar dataKey="value" name={seriesName} radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={colorFor ? colorFor(r, i) : ordinal ? ORDINAL[Math.min(i, ORDINAL.length - 1)] : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
