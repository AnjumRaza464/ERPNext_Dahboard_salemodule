"use client";

import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { num, pkr } from "@/lib/format";
import type { ItemPareto } from "@/lib/types";
import ChartTooltip from "./ChartTooltip";

const CLASS_COLOR: Record<"A" | "B" | "C", string> = { A: "var(--series-1)", B: "var(--ord-2)", C: "var(--ink-3)" };
const CLASS_HINT: Record<"A" | "B" | "C", string> = { A: "first 80% of sales", B: "next 15%", C: "last 5%" };

/**
 * Pareto / ABC: each item's share of sales as a bar (coloured by class) and the
 * running cumulative share as a line, both on one 0–100% axis. The dashed line is the 80% mark.
 */
export default function ParetoChart({ data, height = 240 }: { data: ItemPareto; height?: number }) {
  const rows = data.items.map((i) => ({ ...i, label: `#${i.rank}` }));
  const tickEvery = Math.max(1, Math.ceil(rows.length / 10));
  return (
    <div className="flex flex-col gap-2">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 8, right: 30, left: 0, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} strokeWidth={1} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} interval={tickEvery - 1} tick={{ fontSize: 10 }} />
          <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} width={40} />
          <ReferenceLine y={80} stroke="var(--axis)" strokeDasharray="4 4" label={{ value: "80%", position: "right", fill: "var(--ink-3)", fontSize: 10 }} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={
              <ChartTooltip
                labelFormat={(_, e) => `${e?.payload?.rank}. ${String(e?.payload?.item_name ?? "")} (class ${String(e?.payload?.cls ?? "")})`}
                format={(v, e) => (e.dataKey === "share_pct" ? `${num(v, 1)}% · ${pkr(Number(e.payload?.amount))}` : `${num(v, 1)}%`)}
              />
            }
          />
          <Bar dataKey="share_pct" name="Item share" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.item_code} fill={CLASS_COLOR[r.cls]} />
            ))}
          </Bar>
          <Line type="monotone" dataKey="cum_share_pct" name="Cumulative" stroke="var(--series-2)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2">
        {data.classes.map((c) => (
          <li key={c.cls} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CLASS_COLOR[c.cls] }} />
            <span className="font-medium text-ink">Class {c.cls}</span>
            <span className="tnum">
              {num(c.items)} items ({c.items_pct}%) · {c.share_pct}% of sales
            </span>
            <span className="text-ink-3">· {CLASS_HINT[c.cls]}</span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: "var(--series-2)" }} />
          Cumulative share
        </li>
      </ul>
    </div>
  );
}
