"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, pkr } from "@/lib/format";
import ChartTooltip, { type TooltipEntry } from "./ChartTooltip";

export interface LineSeries {
  key: string;
  name: string;
  color: string;
  dashed?: boolean;
}

interface Props {
  /** each row needs a `label` (x tick) plus one field per series */
  data: Record<string, unknown>[];
  series: LineSeries[];
  height?: number;
  /** tooltip header */
  labelFormat?: (label: string | number, entry?: TooltipEntry) => string;
  format?: (value: number, entry: TooltipEntry) => string;
  zeroLine?: boolean;
}

/** Several series on one PKR axis. Categorical colours are assigned by the caller in fixed order. */
export default function MultiLineChart({ data, series, height = 260, labelFormat, format = (v) => pkr(v), zeroLine }: Props) {
  const tickEvery = Math.max(1, Math.ceil(data.length / 8));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval={tickEvery - 1} dy={6} />
        <YAxis tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} width={52} />
        {zeroLine && <ReferenceLine y={0} stroke="var(--axis)" />}
        <Tooltip cursor={{ strokeWidth: 1 }} content={<ChartTooltip labelFormat={labelFormat} format={format} />} />
        {series.length > 1 && <Legend iconType="plainline" iconSize={14} wrapperStyle={{ paddingTop: 8 }} />}
        {series.map((s) => (
          <Line
            key={s.key}
            isAnimationActive={false}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? "5 4" : undefined}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
