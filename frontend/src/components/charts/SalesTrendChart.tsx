"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, fmtDate, fmtPeriod, pkr } from "@/lib/format";
import type { SalesTrend } from "@/lib/types";
import ChartTooltip from "./ChartTooltip";

export default function SalesTrendChart({ data, height = 260 }: { data: SalesTrend; height?: number }) {
  const points = data.points.map((p) => ({ ...p, label: fmtPeriod(p.period, data.granularity) }));
  const tickEvery = Math.max(1, Math.ceil(points.length / 8));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval={tickEvery - 1} dy={6} />
        <YAxis tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} width={48} />
        <Tooltip
          cursor={{ strokeWidth: 1 }}
          content={
            <ChartTooltip
              noSwatch
              labelFormat={(_, e) => (data.granularity === "day" ? fmtDate(String(e?.payload?.period)) : String(e?.payload?.label))}
              format={(v, e) => (e.dataKey === "invoice_count" ? String(v) : pkr(v))}
            />
          }
        />
        <Area isAnimationActive={false} type="monotone" dataKey="total" name="Sales" stroke="var(--series-1)" strokeWidth={2} fill="url(#salesFill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
        <Area type="monotone" dataKey="invoice_count" name="Invoices" stroke="none" fill="none" hide />
      </AreaChart>
    </ResponsiveContainer>
  );
}
