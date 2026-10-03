"use client";

import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import { fmtRange, num, pkr } from "@/lib/format";
import type { ChainDepartment, CostingSummaryData, Range } from "@/lib/types";
import Card from "./Card";
import DeltaText from "./DeltaText";
import ExportButtons from "./ExportButtons";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

interface Step {
  n: number;
  label: string;
  value: number;
  prev: number;
  delta: number | null | undefined;
  /** a rise is bad for cost steps, good for output and sales */
  invert: boolean;
  lines: string[];
  color: string;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

function pts(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "";
  return ` (${v > 0 ? "+" : ""}${v.toFixed(1)} pts)`;
}

function Ratio({ label, value, note, tone = "text-ink" }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-0.5 rounded-lg border border-line px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-3">{label}</span>
      <span className={`tnum text-base font-semibold leading-tight ${tone}`}>{value}</span>
      {note && <span className="tnum text-[11px] text-ink-3">{note}</span>}
    </div>
  );
}

/**
 * The whole Costing tab on one card: the chain bought -> issued by Stores -> consumed -> produced -> sent to the
 * outlet -> sold (each step against the previous period), the ratios that matter, and one line per department.
 */
export default function CostingSummary({ range, refreshKey, onRetry }: Props) {
  const q = useApi<CostingSummaryData>("/api/costing/summary", range, refreshKey);
  const d = q.data;
  const c = d?.current;
  const p = d?.previous;
  const dl = d?.delta_pct;
  const dp = d?.delta_points;

  const steps: Step[] =
    c && p
      ? [
          { n: 1, label: "Purchased (raw material)", value: c.purchased_raw, prev: p.purchased_raw, delta: dl?.purchased_raw, invert: true, color: "var(--series-1)",
            lines: [`all groups ${pkr(c.purchased_all)}`, `${num(c.purchase_invoices)} invoices · ${num(c.purchased_raw_items)} raw items`] },
          { n: 2, label: "Issued by Stores", value: c.issued, prev: p.issued, delta: dl?.issued, invert: true, color: "var(--series-4)",
            lines: [`to departments ${pkr(c.issued_to_departments)}`, `${c.issued_to_other ? `to outlet ${pkr(c.issued_to_other)} · ` : ""}${num(c.issue_entries)} entries`] },
          { n: 3, label: "Consumed in production", value: c.consumed, prev: p.consumed, delta: dl?.consumed, invert: true, color: "var(--series-2)",
            lines: [`raw ${pkr(c.consumed_raw)} · packaging ${pkr(c.consumed_packaging)}`, `${num(c.production_entries)} entries · ${num(c.materials_used)} materials${c.consumed_pct_of_issued != null ? ` · ${num(c.consumed_pct_of_issued, 1)}% of issued` : ""}`] },
          { n: 4, label: "Finished goods produced", value: c.produced, prev: p.produced, delta: dl?.produced, invert: false, color: "var(--series-3)",
            lines: [`${num(c.produced_qty)} qty · ${num(c.products)} products`, c.output_per_100 != null ? `PKR ${num(c.output_per_100, 0)} per PKR 100 of material` : "no production"] },
          { n: 5, label: "Sent to outlet", value: c.dispatched, prev: p.dispatched, delta: dl?.dispatched, invert: false, color: "var(--series-5)",
            lines: [`${num(c.dispatched_qty)} qty · ${num(c.dispatch_entries)} transfers`, c.bought_in_qty ? `plus ${num(c.bought_in_qty)} qty bought in ready-made` : "all from own production"] },
          { n: 6, label: "Sold at the outlet", value: c.sold, prev: p.sold, delta: dl?.sold, invert: false, color: "var(--series-6)",
            lines: [`${num(c.sold_qty)} qty · ${num(c.bills)} bills`, c.sell_through_pct != null ? `sell-through ${num(c.sell_through_pct, 1)}% · ${num(c.not_sold_qty)} qty not sold` : "nothing produced to compare"] },
        ]
      : [];

  const stepCols: CsvColumn<Step>[] = [
    { key: "n", header: "Step", value: (r) => r.n },
    { key: "label", header: "Stage", value: (r) => r.label },
    { key: "value", header: "This period (PKR)", value: (r) => r.value },
    { key: "prev", header: "Previous period (PKR)", value: (r) => r.prev },
    { key: "delta", header: "Change %", value: (r) => r.delta ?? null },
    { key: "detail", header: "Detail", value: (r) => r.lines.join(" · ") },
  ];
  const deptCols: CsvColumn<ChainDepartment>[] = [
    { key: "department", header: "Department", value: (r) => r.department },
    { key: "issued", header: "Issued by Stores (PKR)", value: (r) => r.issued },
    { key: "consumed", header: "Consumed (PKR)", value: (r) => r.consumed },
    { key: "produced", header: "Produced (PKR)", value: (r) => r.produced },
    { key: "cost_pct", header: "Material cost %", value: (r) => r.cost_pct },
    { key: "share", header: "Share of consumption %", value: (r) => r.share_pct },
  ];
  const onExport = (fmt: ExportFormat) => {
    if (!d || !c) return;
    const stem = `costing-summary-${range.start}-${range.end}`;
    if (fmt === "csv") return exportTable("csv", stem, steps, stepCols);
    const scope = `${fmtRange(range.start, range.end)} · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}`;
    void downloadWorkbook(`${stem}.xlsx`, [
      { name: "Chain", title: "Costing Summary · bought to sold", subtitle: `${scope} · material cost ${c.material_cost_pct != null ? `${num(c.material_cost_pct, 1)}%` : "—"} of net sales · sell-through ${c.sell_through_pct != null ? `${num(c.sell_through_pct, 1)}%` : "—"}`, columns: stepCols, rows: steps },
      { name: "Departments", title: "Costing Summary · by department", subtitle: scope, columns: deptCols, rows: c.departments, totals: true },
    ]);
  };

  const empty = !!c && c.purchased_all === 0 && c.issued === 0 && c.consumed === 0 && c.produced === 0 && c.sold === 0;

  return (
    <Card
      title="Costing Summary"
      subtitle={d ? `${fmtRange(range.start, range.end)} · from purchase to sale in one view · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}` : undefined}
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={empty}
      emptyHint="No purchases, stock entries or sales in this range."
      onRetry={onRetry}
      height={260}
      action={d && !empty ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {d && c && (
        <div className="flex flex-col gap-4">
          {/* the chain, one tile per step */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            {steps.map((s) => (
              <div key={s.n} className="flex flex-col gap-1 rounded-lg border border-line p-3" style={{ borderTop: `3px solid ${s.color}` }}>
                <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: s.color }}>
                    {s.n}
                  </span>
                  <span className="truncate" title={s.label}>{s.label}</span>
                </span>
                <span className="tnum truncate text-lg font-semibold leading-tight text-ink" title={pkr(s.value)}>{pkr(s.value)}</span>
                <span className="text-[11px]">
                  <DeltaText value={s.delta} invert={s.invert} /> <span className="tnum text-ink-3">vs {pkr(s.prev)}</span>
                </span>
                {s.lines.map((l) => (
                  <span key={l} className="tnum text-[11px] leading-snug text-ink-2">{l}</span>
                ))}
              </div>
            ))}
          </div>

          {/* the ratios that matter */}
          <div className="flex flex-wrap gap-2">
            <Ratio
              label="Material cost % of sales"
              value={c.material_cost_pct != null ? `${num(c.material_cost_pct, 1)}%` : "—"}
              note={`material consumed ÷ net sales${pts(dp?.material_cost_pct)}`}
              tone={dp?.material_cost_pct != null && dp.material_cost_pct > 0 ? "text-bad" : "text-ink"}
            />
            <Ratio label="Left after material" value={pkr(c.material_margin)} note="net sales − material consumed" />
            <Ratio
              label="Sell-through"
              value={c.sell_through_pct != null ? `${num(c.sell_through_pct, 1)}%` : "—"}
              note={`${num(c.not_sold_qty)} qty made or bought, not sold${pts(dp?.sell_through_pct)}`}
              tone={c.sell_through_pct != null && c.sell_through_pct < 85 ? "text-warn" : "text-ink"}
            />
            <Ratio label="Raw material stock" value={pkr(d.stock.raw_value)} note={`${num(d.stock.raw_items)} items · ${d.stock.raw_days_cover != null ? `${num(d.stock.raw_days_cover, 0)} din cover` : "no usage in range"}`} />
            <Ratio
              label="Stock adjustments"
              value={d.adjustments.vouchers ? pkr(d.adjustments.net_value, { sign: true }) : "none"}
              note={d.adjustments.vouchers ? `${num(d.adjustments.vouchers)} reconciliation${d.adjustments.vouchers === 1 ? "" : "s"} in range` : "no stock count posted"}
            />
          </div>

          {/* one line per department */}
          {c.departments.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Department</th>
                    <th className={`${th} text-right`}>Issued by Stores</th>
                    <th className={`${th} text-right`}>Consumed</th>
                    <th className={`${th} text-right`}>Produced</th>
                    <th className={`${th} text-right`} title="material consumed as a share of the finished goods value the department produced">Material cost</th>
                    <th className={`${th} text-right`}>Share of consumption</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {c.departments.map((r) => (
                    <tr key={r.department} className="border-b border-line/60">
                      <td className="py-1.5 text-ink">{r.department}</td>
                      <td className={tdNum}>{r.issued ? pkr(r.issued) : <span className="text-ink-3">—</span>}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(r.consumed)}</td>
                      <td className={tdNum}>{r.produced ? pkr(r.produced) : <span className="text-ink-3">—</span>}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{r.cost_pct != null ? `${num(r.cost_pct, 1)}%` : <span className="font-normal text-ink-3">—</span>}</td>
                      <td className={tdNum}>{r.share_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-ink-3">
            Stores issued {pkr(c.issued_to_departments)} of material to the departments, production consumed {pkr(c.consumed)} of it and booked {pkr(c.produced)} of finished goods
            ({num(c.produced_qty)} qty). {pkr(c.dispatched)} of stock went to the outlet, which sold {pkr(c.sold)} on {num(c.bills)} bills.
            {c.material_cost_pct != null ? ` Material came to ${num(c.material_cost_pct, 1)}% of sales.` : ""} Finished goods are valued at their standard rate, not at material cost. Details are in the cards below.
          </p>
        </div>
      )}
    </Card>
  );
}
