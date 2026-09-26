"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, pkr } from "@/lib/format";
import ChartTooltip, { type TooltipEntry } from "./ChartTooltip";

export interface PairRow {
  label: string;
  current: number;
  previous: number;
  [k: string]: unknown;
}

interface Props {
  rows: PairRow[];
  /** legend names for [current, previous] */
  names: [string, string];
  /** "horizontal" = vertical columns per category; "vertical" = horizontal bars (long labels) */
  layout?: "horizontal" | "vertical";
  height?: number;
  format?: (value: number, entry: TooltipEntry) => string;
  labelFormat?: (label: string | number, entry?: TooltipEntry) => string;
  labelWidth?: number;
}

/** Two series side by side per category: this period (blue) against the comparison period (grey). */
export default function GroupedColumns({ rows, names, layout = "horizontal", height, format = (v) => pkr(v), labelFormat, labelWidth = 140 }: Props) {
  const vertical = layout === "vertical";
  const h = height ?? (vertical ? Math.max(180, rows.length * 40 + 40) : 240);
  const tooltip = <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip format={format} labelFormat={labelFormat} />} />;
  const bars = (
    <>
      <Bar dataKey="current" name={names[0]} fill="var(--series-1)" radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={vertical ? 14 : 36} isAnimationActive={false} />
      <Bar dataKey="previous" name={names[1]} fill="var(--ink-3)" fillOpacity={0.55} radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={vertical ? 14 : 36} isAnimationActive={false} />
    </>
  );
  return (
    <ResponsiveContainer width="100%" height={h}>
      {vertical ? (
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 0 }} barCategoryGap="30%" barGap={2}>
          <XAxis type="number" tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} height={22} />
          <YAxis type="category" dataKey="label" width={labelWidth} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} />
          {tooltip}
          <Legend iconType="square" iconSize={10} wrapperStyle={{ paddingTop: 6 }} />
          {bars}
        </BarChart>
      ) : (
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%" barGap={2}>
          <CartesianGrid vertical={false} strokeWidth={1} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} width={48} />
          {tooltip}
          <Legend iconType="square" iconSize={10} wrapperStyle={{ paddingTop: 6 }} />
          {bars}
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}
