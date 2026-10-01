"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, pkr } from "@/lib/format";
import ChartTooltip, { type TooltipEntry } from "./ChartTooltip";

export interface StackRow {
  label: string;
  [k: string]: unknown;
}

interface Props {
  rows: StackRow[];
  /** series keys in stacking order (bottom first) */
  keys: string[];
  height?: number;
  format?: (value: number, entry: TooltipEntry) => string;
  labelFormat?: (label: string | number, entry?: TooltipEntry) => string;
  /** show every Nth x tick */
  tickEvery?: number;
  /** false = bars side by side instead of stacked */
  stacked?: boolean;
  colors?: string[];
}

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

/** Several categories stacked per period: one column per day (or weekday), one colour per department. */
export default function StackedColumns({ rows, keys, height = 240, format = (v) => pkr(v), labelFormat, tickEvery = 1, stacked = true, colors = SERIES }: Props) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%" barGap={2}>
        <CartesianGrid vertical={false} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} interval={tickEvery - 1} tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} width={48} />
        <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip format={format} labelFormat={labelFormat} />} />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ paddingTop: 6 }} />
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} name={k} stackId={stacked ? "stack" : undefined} fill={colors[i % colors.length]} radius={!stacked || i === keys.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={40} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
