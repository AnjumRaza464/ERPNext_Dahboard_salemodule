"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, pkr } from "@/lib/format";
import type { WaterfallStep } from "@/lib/types";
import ChartTooltip from "./ChartTooltip";

interface Row {
  label: string;
  amount: number;
  kind: "total" | "delta";
  range: [number, number];
}

/**
 * Waterfall: totals are anchored at zero (grey), deltas float from the running
 * value - increases in the positive pole (blue), decreases in the negative pole (red).
 */
function buildRows(steps: WaterfallStep[]): Row[] {
  const rows: Row[] = [];
  let running = 0;
  for (const s of steps) {
    if (s.kind === "total") {
      running = s.amount;
      rows.push({ ...s, range: s.amount >= 0 ? [0, s.amount] : [s.amount, 0] });
      continue;
    }
    const from = running;
    running += s.amount;
    rows.push({ ...s, range: s.amount >= 0 ? [from, running] : [running, from] });
  }
  return rows;
}

export default function WaterfallChart({ steps, height = 260 }: { steps: WaterfallStep[]; height?: number }) {
  const rows = buildRows(steps);
  const fill = (r: Row) => (r.kind === "total" ? "var(--ink-3)" : r.amount >= 0 ? "var(--series-1)" : "var(--neg)");
  const hasNegative = rows.some((r) => r.range[0] < 0);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid vertical={false} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} interval={0} tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} width={52} />
        {hasNegative && <ReferenceLine y={0} stroke="var(--axis)" />}
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={<ChartTooltip noSwatch format={(_, e) => pkr(Number(e.payload?.amount), { sign: e.payload?.kind === "delta" })} />}
        />
        <Bar dataKey="range" name="Amount" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={fill(r)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
