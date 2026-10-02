"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import ExportButtons from "./ExportButtons";
import { fmtDate, fmtPeriod, fmtRange, num, pkr } from "@/lib/format";
import type { CostingFlow, FlowDayRow, FlowMetric, FlowWeekdayRow, PurchaseInvoiceRow, Range } from "@/lib/types";
import Card from "./Card";
import DeltaText from "./DeltaText";
import MultiLineChart from "./charts/MultiLineChart";
import StackedColumns from "./charts/StackedColumns";
import ViewToggle from "./ViewToggle";
import WeekdayFilter from "./WeekdayFilter";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

type View = "daily" | "cumulative" | "weekday" | "invoices";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";
const KEYS = ["Purchased", "Consumed", "Produced"];
const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const METRIC_COLOR: Record<string, string> = { purchased: COLORS[0], purchased_all: "var(--ord-2)", consumed: COLORS[1], produced: COLORS[2] };

function yieldTone(v: number | null): string {
  if (v === null) return "text-ink-3";
  if (v < 100) return "text-bad";
  if (v < 150) return "text-warn";
  return "text-ink-2";
}

function gapTone(v: number): string {
  return v > 0 ? "text-ink-2" : v < 0 ? "text-warn" : "text-ink-3";
}

/**
 * Purchases, consumption and output in detail: per-metric summary strip, then day by day (or month) with
 * running totals, the cumulative curve, weekday averages, or every purchase invoice in the range.
 */
export default function FlowDetail({ range, refreshKey, onRetry }: Props) {
  const [days, setDays] = useState<string[]>([]);
  const q = useApi<CostingFlow>("/api/costing/flow", range, refreshKey, days.length ? { weekdays: days.join(",") } : {});
  const [view, setView] = useState<View>("daily");
  const d = q.data;
  const gran = d?.granularity ?? "day";
  const dayRows = d ? d.daily.map((r) => ({ label: fmtPeriod(r.period, gran), weekday: r.weekday, Purchased: r.purchased, Consumed: r.consumed, Produced: r.produced, invoices: r.invoices, entries: r.entries })) : [];
  const cumRows = d ? d.daily.map((r) => ({ label: fmtPeriod(r.period, gran), weekday: r.weekday, purchased: r.cum_purchased, consumed: r.cum_consumed, produced: r.cum_produced, gap: r.cum_gap })) : [];
  const weekdayRows = d ? d.weekday.map((r) => ({ label: r.weekday, days: r.days, Purchased: r.purchased, Consumed: r.consumed, Produced: r.produced })) : [];
  const tickEvery = dayRows.length > 40 ? 4 : dayRows.length > 20 ? 2 : 1;
  const empty = !!d && d.summary.every((m) => m.total === 0);

  const summaryCols: CsvColumn<FlowMetric>[] = [
    { key: "label", header: "Metric", value: (r) => r.label },
    { key: "total", header: "Total (PKR)", value: (r) => r.total },
    { key: "documents", header: "Documents", value: (r) => r.documents },
    { key: "active_days", header: "Active din", value: (r) => r.active_days },
    { key: "avg_active", header: "Avg per active din (PKR)", value: (r) => r.avg_per_active_day },
    { key: "avg_day", header: "Avg per calendar din (PKR)", value: (r) => r.avg_per_day },
    { key: "prev", header: "Previous (PKR)", value: (r) => r.prev_total },
    { key: "delta", header: "Change %", value: (r) => r.delta_pct },
  ];
  const dailyCols: CsvColumn<FlowDayRow>[] = [
    { key: "period", header: gran === "month" ? "Month" : "Date", value: (r) => r.period },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "purchased", header: "Raw material purchased (PKR)", value: (r) => r.purchased },
    { key: "purchased_all", header: "All purchases (PKR)", value: (r) => r.purchased_all },
    { key: "consumed", header: "Material consumed (PKR)", value: (r) => r.consumed },
    { key: "produced", header: "Finished goods produced (PKR)", value: (r) => r.produced },
    { key: "gap", header: "Bought minus used (PKR)", value: (r) => r.gap },
    { key: "yield", header: "Output per 100", value: (r) => r.yield_pct },
    { key: "invoices", header: "Invoices", value: (r) => r.invoices },
    { key: "entries", header: "Production entries", value: (r) => r.entries },
    { key: "cum_purchased", header: "Running purchased (PKR)", value: (r) => r.cum_purchased },
    { key: "cum_consumed", header: "Running consumed (PKR)", value: (r) => r.cum_consumed },
    { key: "cum_produced", header: "Running produced (PKR)", value: (r) => r.cum_produced },
  ];
  const weekdayCols: CsvColumn<FlowWeekdayRow>[] = [
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "days", header: "Din in range", value: (r) => r.days },
    { key: "purchased", header: "Avg purchased raw (PKR)", value: (r) => r.purchased },
    { key: "consumed", header: "Avg consumed (PKR)", value: (r) => r.consumed },
    { key: "produced", header: "Avg produced (PKR)", value: (r) => r.produced },
    { key: "purchase_days", header: "Din with purchases", value: (r) => r.purchase_days },
    { key: "production_days", header: "Din with production", value: (r) => r.production_days },
  ];
  const invoiceCols: CsvColumn<PurchaseInvoiceRow>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "name", header: "Invoice", value: (r) => r.name },
    { key: "supplier", header: "Supplier", value: (r) => r.supplier },
    { key: "raw", header: "Raw material (PKR)", value: (r) => r.raw },
    { key: "other", header: "Other groups (PKR)", value: (r) => r.other },
    { key: "total", header: "Total (PKR)", value: (r) => r.total },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "groups", header: "Item groups", value: (r) => r.groups },
  ];
  const stem = `${range.start}-${range.end}`;
  const scope = `${fmtRange(range.start, range.end)}${days.length ? ` · ${days.join(", ")} only` : ""}`;

  /** CSV of the view on screen. */
  const exportView = () => {
    if (!d) return;
    if (view === "weekday") exportTable("csv", `purchases-consumption-output-weekday-${stem}`, d.weekday, weekdayCols);
    else if (view === "invoices") exportTable("csv", `purchase-invoices-${stem}`, d.invoices, invoiceCols);
    else exportTable("csv", `purchases-consumption-output-${stem}`, d.daily, dailyCols);
  };
  /** One Excel workbook with every view of this card on its own tab. */
  const exportWorkbook = () => {
    if (!d) return;
    const ratios = `bought minus used ${pkr(d.ratios.gap, { sign: true })} (raw) · ${d.ratios.consumed_pct_of_purchased != null ? `${num(d.ratios.consumed_pct_of_purchased, 1)}% of raw purchases used` : "no raw purchases"} · output PKR ${d.ratios.yield_pct != null ? num(d.ratios.yield_pct, 0) : "—"} per PKR 100 material`;
    void downloadWorkbook(`purchases-consumption-output-${stem}.xlsx`, [
      { name: "Summary", title: "Purchases, Consumption & Output · Summary", subtitle: `${scope} · ${ratios} · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}`, columns: summaryCols, rows: d.summary },
      { name: gran === "month" ? "Month-wise" : "Day-wise", title: `Purchases, Consumption & Output · ${gran === "month" ? "Month" : "Day"}-wise`, subtitle: `${scope} · PKR, with running totals from the first day of the range`, columns: dailyCols, rows: d.daily, totals: true, noTotal: ["cum_purchased", "cum_consumed", "cum_produced"] },
      { name: "Weekday", title: "Purchases, Consumption & Output · Weekday averages", subtitle: `${scope} · average per calendar day of that weekday, PKR`, columns: weekdayCols, rows: d.weekday },
      { name: "Invoices", title: "Purchase invoices", subtitle: `${scope} · ${num(d.invoices.length)} of ${num(d.invoices_total)} invoices`, columns: invoiceCols, rows: d.invoices, totals: true },
    ]);
  };
  const onExport = (fmt: ExportFormat) => (fmt === "xlsx" ? exportWorkbook() : exportView());

  return (
    <Card
      title="Purchases, Consumption & Output · Detail"
      subtitle={
        d
          ? `Purchased − consumed ${pkr(d.ratios.gap, { sign: true })} (raw) · ${d.ratios.consumed_pct_of_purchased != null ? `${num(d.ratios.consumed_pct_of_purchased, 1)}% of raw purchases used` : "no raw purchases"} · output PKR ${d.ratios.yield_pct != null ? num(d.ratios.yield_pct, 0) : "—"} per PKR 100 material · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}`
          : undefined
      }
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={empty}
      emptyHint="No purchase invoices or production entries in this range."
      onRetry={onRetry}
      height={240}
      action={
        <div className="flex items-center gap-2">
          <ViewToggle value={view} options={[{ id: "daily", label: gran === "month" ? "Month-wise" : "Day-wise" }, { id: "cumulative", label: "Running total" }, { id: "weekday", label: "Weekday" }, { id: "invoices", label: "Invoices" }]} onChange={setView} />
          {d && <ExportButtons onExport={onExport} />}
        </div>
      }
    >
      {d && (
        <div className="flex flex-col gap-4">
          {/* summary strip: one row per metric */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className={thead}>
                  <th className={th}>Metric</th>
                  <th className={`${th} text-right`}>Total</th>
                  <th className={`${th} text-right`}>Documents</th>
                  <th className={`${th} text-right`}>Active din</th>
                  <th className={`${th} text-right`}>Avg / active din</th>
                  <th className={`${th} text-right`}>Avg / calendar din</th>
                  <th className={`${th} text-right`}>Previous</th>
                  <th className={`${th} text-right`}>vs prev</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {d.summary.map((m) => (
                  <tr key={m.key} className="border-b border-line/60">
                    <td className="py-1.5 text-ink">
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: METRIC_COLOR[m.key] }} />
                      {m.label}
                    </td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(m.total)}</td>
                    <td className={tdNum}>{num(m.documents)} {m.key.startsWith("purchased") ? "inv" : "entries"}</td>
                    <td className={tdNum}>{num(m.active_days)}</td>
                    <td className={tdNum}>{pkr(m.avg_per_active_day)}</td>
                    <td className={tdNum}>{pkr(m.avg_per_day)}</td>
                    <td className={tdNum}>{pkr(m.prev_total)}</td>
                    <td className="py-1.5 text-right"><DeltaText value={m.delta_pct} invert={m.key !== "produced"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <WeekdayFilter value={days} onChange={setDays} />

          {view === "daily" && (
            <div className="flex flex-col gap-3">
              <StackedColumns
                rows={dayRows}
                keys={KEYS}
                colors={COLORS}
                stacked={false}
                height={260}
                tickEvery={tickEvery}
                labelFormat={(label, e) => `${label}${e?.payload?.weekday ? ` (${e.payload.weekday})` : ""} · ${num(Number(e?.payload?.invoices ?? 0))} invoices · ${num(Number(e?.payload?.entries ?? 0))} production entries`}
              />
              <div className="max-h-[360px] overflow-auto">
                <table className="w-full min-w-[820px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>{gran === "month" ? "Month" : "Date"}</th>
                      <th className={`${th} text-right`}>Purchased (raw)</th>
                      <th className={`${th} text-right`}>All purchases</th>
                      <th className={`${th} text-right`}>Consumed</th>
                      <th className={`${th} text-right`}>Produced</th>
                      <th className={`${th} text-right`}>Bought − used</th>
                      <th className={`${th} text-right`}>Output / 100</th>
                      <th className={`${th} text-right`}>Inv</th>
                      <th className={`${th} text-right`}>Entries</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {d.daily.map((r) => {
                      const quiet = r.purchased_all === 0 && r.consumed === 0 && r.produced === 0;
                      return (
                        <tr key={r.period} className={`border-b border-line/60 ${quiet ? "text-ink-3" : ""}`}>
                          <td className="whitespace-nowrap py-1 text-ink">
                            {fmtPeriod(r.period, gran)} <span className="text-[10px] text-ink-3">{gran === "day" ? r.weekday : ""}</span>
                          </td>
                          <td className={tdNum}>{r.purchased ? num(r.purchased) : "—"}</td>
                          <td className={tdNum}>{r.purchased_all ? num(r.purchased_all) : "—"}</td>
                          <td className={tdNum}>{r.consumed ? num(r.consumed) : "—"}</td>
                          <td className={tdNum}>{r.produced ? num(r.produced) : "—"}</td>
                          <td className={`py-1 text-right ${gapTone(r.gap)}`}>{quiet ? "—" : pkr(r.gap, { sign: true }).replace("PKR ", "")}</td>
                          <td className={`py-1 text-right font-medium ${yieldTone(r.yield_pct)}`}>{r.yield_pct === null ? "—" : num(r.yield_pct, 0)}</td>
                          <td className={tdNum}>{r.invoices || "—"}</td>
                          <td className={tdNum}>{r.entries || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Figures in PKR. Bought − used compares raw material purchased with material consumed that day; Output / 100 is finished goods value per PKR 100 of material consumed.</p>
            </div>
          )}

          {view === "cumulative" && (
            <div className="flex flex-col gap-3">
              <MultiLineChart
                data={cumRows}
                series={[
                  { key: "purchased", name: "Purchased (raw), running", color: COLORS[0] },
                  { key: "consumed", name: "Consumed, running", color: COLORS[1] },
                  { key: "produced", name: "Produced, running", color: COLORS[2] },
                ]}
                height={280}
                labelFormat={(label, e) => `${label}${e?.payload?.weekday ? ` (${e.payload.weekday})` : ""} · bought − used so far ${pkr(Number(e?.payload?.gap ?? 0), { sign: true })}`}
              />
              <p className="text-[11px] text-ink-3">Running totals from the first day of the range. When the purchased line pulls away from the consumed line, raw material stock is building up; when they converge, stock is being drawn down.</p>
            </div>
          )}

          {view === "weekday" && (
            <div className="flex flex-col gap-3">
              <StackedColumns rows={weekdayRows} keys={KEYS} colors={COLORS} stacked={false} height={240} labelFormat={(label, e) => `${label} · average over ${num(Number(e?.payload?.days ?? 0))} din in range`} />
              <table className="w-full text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Weekday</th>
                    <th className={`${th} text-right`}>Din in range</th>
                    <th className={`${th} text-right`}>Avg purchased (raw)</th>
                    <th className={`${th} text-right`}>Avg consumed</th>
                    <th className={`${th} text-right`}>Avg produced</th>
                    <th className={`${th} text-right`}>Din with purchases</th>
                    <th className={`${th} text-right`}>Din with production</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.weekday.map((r) => (
                    <tr key={r.weekday} className={`border-b border-line/60 ${r.days === 0 ? "text-ink-3" : ""}`}>
                      <td className="py-1.5 text-ink">{r.weekday}</td>
                      <td className={tdNum}>{num(r.days)}</td>
                      <td className={tdNum}>{r.purchased ? num(r.purchased) : "—"}</td>
                      <td className={tdNum}>{r.consumed ? num(r.consumed) : "—"}</td>
                      <td className={tdNum}>{r.produced ? num(r.produced) : "—"}</td>
                      <td className={tdNum}>{num(r.purchase_days)} of {num(r.days)}</td>
                      <td className={tdNum}>{num(r.production_days)} of {num(r.days)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-ink-3">Average per calendar day of that weekday, in PKR. Days without activity count as zero, so a weekday the bakery does not produce on shows a lower average.</p>
            </div>
          )}

          {view === "invoices" && (
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="sticky top-0 z-10 bg-surface">
                  <tr className={thead}>
                    <th className={th}>Date</th>
                    <th className={th}>Invoice</th>
                    <th className={th}>Supplier</th>
                    <th className={`${th} text-right`}>Raw material</th>
                    <th className={`${th} text-right`}>Other</th>
                    <th className={`${th} text-right`}>Total</th>
                    <th className={`${th} text-right`}>Items</th>
                    <th className={th}>Groups</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.invoices.map((r) => (
                    <tr key={r.name} className="border-b border-line/60">
                      <td className="whitespace-nowrap py-1.5 text-ink">
                        {fmtDate(r.date)} <span className="text-[10px] text-ink-3">{r.weekday}</span>
                      </td>
                      <td className="py-1.5 text-ink-2">{r.name}</td>
                      <td className="py-1.5 text-ink">{r.supplier}</td>
                      <td className={tdNum}>{r.raw ? pkr(r.raw) : <span className="text-ink-3">—</span>}</td>
                      <td className={tdNum}>{r.other ? pkr(r.other) : <span className="text-ink-3">—</span>}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(r.total)}</td>
                      <td className={tdNum}>{num(r.items)}</td>
                      <td className="max-w-[260px] truncate py-1.5 text-ink-3" title={r.groups}>{r.groups}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.invoices_total > d.invoices.length && <p className="mt-2 text-[11px] text-ink-3">Showing the latest {num(d.invoices.length)} of {num(d.invoices_total)} invoices. Narrow the date range to see the rest.</p>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
