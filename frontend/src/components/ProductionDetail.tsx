"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import ExportButtons from "./ExportButtons";
import { fmtDate, fmtPeriod, fmtRange, num, pkr } from "@/lib/format";
import type { CostingProduction, DepartmentSummary, DepartmentWeekdayRow, ProductionDayRow, ProductionEntryRow, ProductRow, Range } from "@/lib/types";
import Card from "./Card";
import DeltaText from "./DeltaText";
import StackedColumns from "./charts/StackedColumns";
import TableFilter from "./TableFilter";
import ViewToggle from "./ViewToggle";
import WeekdayFilter from "./WeekdayFilter";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

type View = "daily" | "weekday" | "products" | "entries";
const ALL = "__all__";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

/** Rows whose item name or code contains `query` (case-insensitive). */
function matches(query: string) {
  const q = query.trim().toLowerCase();
  return (r: { item_name: string; item_code: string }) => !q || r.item_name.toLowerCase().includes(q) || r.item_code.toLowerCase().includes(q);
}

function short(dept: string): string {
  return dept.replace(/\s+Department$/i, "");
}

function yieldTone(v: number | null): string {
  if (v === null) return "text-ink-3";
  if (v < 100) return "text-bad";
  if (v < 150) return "text-warn";
  return "text-ink-2";
}

/**
 * Finished goods produced in detail: the per-department summary strip, then one of four views: day by day
 * (stacked columns + matrix), weekday averages, top products (all or one department), or every production entry.
 */
export default function ProductionDetail({ range, refreshKey, onRetry }: Props) {
  const [days, setDays] = useState<string[]>([]);
  const q = useApi<CostingProduction>("/api/costing/production", range, refreshKey, { limit: 0, ...(days.length ? { weekdays: days.join(",") } : {}) });
  const [view, setView] = useState<View>("daily");
  const [dept, setDept] = useState<string>(ALL);
  const [productQuery, setProductQuery] = useState("");
  const d = q.data;
  const depts = d?.departments.map((x) => x.department) ?? [];
  const activeDept = dept !== ALL && depts.includes(dept) ? dept : ALL;
  const gran = d?.granularity ?? "day";
  const keys = depts.map(short);

  const dayRows = d ? d.daily.map((r) => ({ label: fmtPeriod(r.period, gran), weekday: r.weekday, entries: r.entries, total: r.total, qty: r.qty, ...Object.fromEntries(depts.map((k) => [short(k), r.by_department[k] ?? 0])) })) : [];
  const weekdayRows = d ? d.weekday.map((r) => ({ label: r.weekday, days: r.days, total: r.avg_total, ...Object.fromEntries(depts.map((k) => [short(k), r.by_department[k] ?? 0])) })) : [];
  const tickEvery = dayRows.length > 40 ? 4 : dayRows.length > 20 ? 2 : 1;
  const products = d ? (activeDept === ALL ? d.items : d.items_by_department[activeDept] ?? []) : [];
  const shownProducts = products.filter(matches(productQuery));
  const productsTotal = d ? (activeDept === ALL ? d.total : d.departments.find((x) => x.department === activeDept)?.amount ?? 0) : 0;

  const dailyCols: CsvColumn<ProductionDayRow>[] = [
    { key: "period", header: gran === "month" ? "Month" : "Date", value: (r) => r.period },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    ...depts.map((k) => ({ key: k, header: `${k} (PKR)`, value: (r: ProductionDayRow) => r.by_department[k] ?? 0 })),
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "total", header: "Total value (PKR)", value: (r) => r.total },
    { key: "entries", header: "Entries", value: (r) => r.entries },
  ];
  const weekdayCols: CsvColumn<DepartmentWeekdayRow>[] = [
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "days", header: "Din with production", value: (r) => r.days },
    ...depts.map((k) => ({ key: k, header: `${k} avg (PKR)`, value: (r: DepartmentWeekdayRow) => r.by_department[k] ?? 0 })),
    { key: "avg_total", header: "Avg total (PKR)", value: (r) => r.avg_total },
  ];
  const summaryCols: CsvColumn<DepartmentSummary>[] = [
    { key: "department", header: "Department", value: (r) => r.department },
    { key: "amount", header: "Produced (PKR)", value: (r) => r.amount },
    { key: "share", header: "Share %", value: (r) => r.share_pct },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "entries", header: "Entries", value: (r) => r.entries },
    { key: "items", header: "Products", value: (r) => r.items },
    { key: "active_days", header: "Active din", value: (r) => r.active_days },
    { key: "avg", header: "Avg per active din (PKR)", value: (r) => r.avg_per_active_day },
    { key: "used", header: "Material used (PKR)", value: (r) => r.used ?? 0 },
    { key: "cost_pct", header: "Material cost %", value: (r) => r.cost_pct ?? null },
    { key: "prev", header: "Previous (PKR)", value: (r) => r.prev_amount },
    { key: "delta", header: "Change %", value: (r) => r.delta_pct },
  ];
  const productCols: CsvColumn<ProductRow>[] = [
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Product", value: (r) => r.item_name },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "rate", header: "Rate", value: (r) => r.rate },
    { key: "amount", header: "Value (PKR)", value: (r) => r.amount },
    { key: "share", header: "Share %", value: (r) => r.share_pct },
    { key: "prev_qty", header: "Previous qty", value: (r) => r.prev_qty },
    { key: "qty_delta", header: "Qty change %", value: (r) => r.qty_delta_pct },
    { key: "prev_amount", header: "Previous value (PKR)", value: (r) => r.prev_amount },
    { key: "delta", header: "Value change %", value: (r) => r.delta_pct },
    { key: "entries", header: "Entries", value: (r) => r.entries },
  ];
  const deptProductCols: CsvColumn<ProductRow & { department: string }>[] = [{ key: "department", header: "Department", value: (r) => r.department }, ...productCols];
  const entryCols: CsvColumn<ProductionEntryRow>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "name", header: "Entry", value: (r) => r.name },
    { key: "department", header: "Department", value: (r) => r.department },
    { key: "amount", header: "Produced value (PKR)", value: (r) => r.amount },
    { key: "qty", header: "Produced qty", value: (r) => r.qty },
    { key: "items", header: "Products", value: (r) => r.items },
    { key: "used", header: "Material used (PKR)", value: (r) => r.used },
    { key: "materials", header: "Materials", value: (r) => r.materials },
    { key: "yield", header: "Output per 100", value: (r) => r.yield_pct },
    { key: "top", header: "Top products", value: (r) => r.top_products.join("; ") },
  ];
  const stem = `${range.start}-${range.end}`;
  const scope = `${fmtRange(range.start, range.end)}${days.length ? ` · ${days.join(", ")} only` : ""}`;

  /** CSV of the view on screen. */
  const exportView = () => {
    if (!d) return;
    if (view === "daily") exportTable("csv", `finished-goods-daily-${stem}`, d.daily, dailyCols);
    else if (view === "weekday") exportTable("csv", `finished-goods-weekday-${stem}`, d.weekday, weekdayCols);
    else if (view === "products") exportTable("csv", `finished-goods-${activeDept === ALL ? "all" : short(activeDept).toLowerCase()}-${stem}`, shownProducts, productCols);
    else exportTable("csv", `finished-goods-entries-${stem}`, d.entries, entryCols);
  };
  /** One Excel workbook with every view of this card on its own tab. */
  const exportWorkbook = () => {
    if (!d) return;
    const byDept = depts.flatMap((k) => (d.items_by_department[k] ?? []).map((r) => ({ ...r, department: k })));
    void downloadWorkbook(`finished-goods-produced-${stem}.xlsx`, [
      { name: "Summary", title: "Finished Goods Produced · Summary", subtitle: `${scope} · ${pkr(d.total)} · ${num(d.total_qty)} qty · ${num(d.distinct_items)} products in ${num(d.entries_total)} entries · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}`, columns: summaryCols, rows: d.departments, totals: true, noTotal: ["active_days"] },
      { name: gran === "month" ? "Month-wise" : "Day-wise", title: `Finished Goods Produced · ${gran === "month" ? "Month" : "Day"}-wise`, subtitle: `${scope} · value booked per ${gran === "month" ? "month" : "day"} by producing department, PKR`, columns: dailyCols, rows: d.daily, totals: true },
      { name: "Weekday", title: "Finished Goods Produced · Weekday averages", subtitle: `${scope} · average per day of that weekday, production days only, PKR`, columns: weekdayCols, rows: d.weekday },
      { name: "Products", title: "Products produced", subtitle: `${scope} · every product with qty and value vs the previous period`, columns: productCols, rows: d.items, totals: true },
      { name: "By department", title: "Products produced by department", subtitle: scope, columns: deptProductCols, rows: byDept, totals: true },
      { name: "Entries", title: "Production entries", subtitle: `${scope} · ${num(d.entries.length)} of ${num(d.entries_total)} entries`, columns: entryCols, rows: d.entries, totals: true },
    ]);
  };
  const onExport = (fmt: ExportFormat) => (fmt === "xlsx" ? exportWorkbook() : exportView());

  return (
    <Card
      title="Finished Goods Produced · Detail"
      subtitle={d ? `${pkr(d.total)} · ${num(d.total_qty)} qty · ${num(d.distinct_items)} products in ${num(d.entries_total)} production entries · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}` : undefined}
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && d.departments.length === 0}
      emptyHint="No production (Repack) entries in this range."
      onRetry={onRetry}
      height={240}
      action={
        <div className="flex items-center gap-2">
          <ViewToggle value={view} options={[{ id: "daily", label: gran === "month" ? "Month-wise" : "Day-wise" }, { id: "weekday", label: "Weekday" }, { id: "products", label: "Products" }, { id: "entries", label: "Entries" }]} onChange={setView} />
          {d && <ExportButtons onExport={onExport} />}
        </div>
      }
    >
      {d && (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr className={thead}>
                  <th className={th}>Department</th>
                  <th className={`${th} text-right`}>Produced</th>
                  <th className={`${th} text-right`}>Share</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Entries</th>
                  <th className={`${th} text-right`}>Products</th>
                  <th className={`${th} text-right`}>Active din</th>
                  <th className={`${th} text-right`}>Avg / active din</th>
                  <th className={`${th} text-right`}>Material used</th>
                  <th className={`${th} text-right`} title="material used as a share of the finished goods value the department produced">Material cost</th>
                  <th className={`${th} text-right`}>Previous</th>
                  <th className={`${th} text-right`}>vs prev</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {d.departments.map((r, i) => (
                  <tr key={r.department} className="border-b border-line/60">
                    <td className="py-1.5 text-ink">
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: SERIES[i % SERIES.length] }} />
                      {r.department}
                    </td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                    <td className={tdNum}>{r.share_pct}%</td>
                    <td className={tdNum}>{num(r.qty)}</td>
                    <td className={tdNum}>{num(r.entries)}</td>
                    <td className={tdNum}>{num(r.items)}</td>
                    <td className={tdNum}>{num(r.active_days)}</td>
                    <td className={tdNum}>{pkr(r.avg_per_active_day)}</td>
                    <td className={tdNum}>{r.used ? pkr(r.used) : <span className="text-ink-3">—</span>}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{r.cost_pct != null ? `${num(r.cost_pct, 1)}%` : <span className="font-normal text-ink-3">—</span>}</td>
                    <td className={tdNum}>{pkr(r.prev_amount)}</td>
                    <td className="py-1.5 text-right"><DeltaText value={r.delta_pct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <WeekdayFilter value={days} onChange={setDays} />

          {view === "daily" && (
            <div className="flex flex-col gap-3">
              <div className="w-full">
                <StackedColumns
                  rows={dayRows}
                  keys={keys}
                  height={260}
                  tickEvery={tickEvery}
                  labelFormat={(label, e) => `${label}${e?.payload?.weekday ? ` (${e.payload.weekday})` : ""} · ${pkr(Number(e?.payload?.total ?? 0))} · ${num(Number(e?.payload?.qty ?? 0))} qty · ${num(Number(e?.payload?.entries ?? 0))} entries`}
                />
              </div>
              <div className="max-h-[360px] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface">
                    <tr className={thead}>
                      <th className={th}>{gran === "month" ? "Month" : "Date"}</th>
                      {keys.map((k) => (
                        <th key={k} className={`${th} text-right`}>{k}</th>
                      ))}
                      <th className={`${th} text-right`}>Qty</th>
                      <th className={`${th} text-right`}>Total PKR</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {d.daily.map((r) => (
                      <tr key={r.period} className={`border-b border-line/60 ${r.total === 0 ? "text-ink-3" : ""}`}>
                        <td className="whitespace-nowrap py-1 text-ink">
                          {fmtPeriod(r.period, gran)} <span className="text-[10px] text-ink-3">{gran === "day" ? r.weekday : ""}</span>
                        </td>
                        {depts.map((k) => (
                          <td key={k} className={tdNum}>{r.by_department[k] ? num(r.by_department[k]) : <span className="text-ink-3">—</span>}</td>
                        ))}
                        <td className={tdNum}>{r.qty ? num(r.qty) : "—"}</td>
                        <td className={`py-1 text-right font-medium ${r.total ? "text-ink" : "text-ink-3"}`} title={`${num(r.entries)} entries`}>{r.total ? num(r.total) : "no production"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {view === "weekday" && (
            <div className="flex flex-col gap-3">
              <div className="w-full">
                <StackedColumns rows={weekdayRows} keys={keys} height={240} labelFormat={(label, e) => `${label} · avg ${pkr(Number(e?.payload?.total ?? 0))} over ${num(Number(e?.payload?.days ?? 0))} din`} />
                <p className="mt-1 text-[11px] text-ink-3">Average finished goods value produced per day of that weekday, counting only days that had production.</p>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Weekday</th>
                    <th className={`${th} text-right`}>Din</th>
                    {keys.map((k) => (
                      <th key={k} className={`${th} text-right`}>{k}</th>
                    ))}
                    <th className={`${th} text-right`}>Avg total PKR</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.weekday.map((r) => (
                    <tr key={r.weekday} className={`border-b border-line/60 ${r.days === 0 ? "text-ink-3" : ""}`}>
                      <td className="py-1.5 text-ink">{r.weekday}</td>
                      <td className={tdNum}>{num(r.days)}</td>
                      {depts.map((k) => (
                        <td key={k} className={tdNum}>{r.by_department[k] ? num(r.by_department[k]) : "—"}</td>
                      ))}
                      <td className="py-1.5 text-right font-medium text-ink">{r.days ? num(r.avg_total) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {view === "products" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <ViewToggle value={activeDept} options={[{ id: ALL, label: "All" }, ...depts.map((k) => ({ id: k, label: short(k) }))]} onChange={setDept} />
                <span className="text-xs text-ink-3">
                  All {num(products.length)} products{activeDept === ALL ? "" : ` from ${activeDept}`} · {pkr(productsTotal)} · qty and value vs the previous period
                </span>
              </div>
              <TableFilter query={productQuery} onQuery={setProductQuery} shown={shownProducts.length} total={products.length} placeholder="Search product or code…" />
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>Product</th>
                      <th className={`${th} text-right`}>Qty</th>
                      <th className={`${th} text-right`}>Prev qty</th>
                      <th className={`${th} text-right`}>Qty chg</th>
                      <th className={`${th} text-right`}>Rate</th>
                      <th className={`${th} text-right`}>Value</th>
                      <th className={`${th} text-right`}>Share</th>
                      <th className={`${th} text-right`}>Value chg</th>
                      <th className={`${th} text-right`}>Entries</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {shownProducts.map((r) => (
                      <tr key={r.item_code} className="border-b border-line/60">
                        <td className="py-1.5 text-ink" title={`${r.item_code} · ${r.item_group}`}>{r.item_name}</td>
                        <td className="py-1.5 text-right font-medium text-ink">{num(r.qty, 1)} <span className="font-normal text-ink-3">{r.uom}</span></td>
                        <td className={tdNum}>{r.prev_qty ? num(r.prev_qty, 1) : <span className="text-ink-3">—</span>}</td>
                        <td className="py-1.5 text-right"><DeltaText value={r.qty_delta_pct} /></td>
                        <td className={tdNum}>{pkr(r.rate)}</td>
                        <td className={tdNum}>{pkr(r.amount)}</td>
                        <td className={tdNum}>{r.share_pct}%</td>
                        <td className="py-1.5 text-right"><DeltaText value={r.delta_pct} /></td>
                        <td className={tdNum}>{num(r.entries)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {view === "entries" && (
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full min-w-[900px] text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className={thead}>
                    <th className={th}>Date</th>
                    <th className={th}>Entry</th>
                    <th className={th}>Dept</th>
                    <th className={`${th} text-right`}>Produced</th>
                    <th className={`${th} text-right`}>Qty</th>
                    <th className={`${th} text-right`}>Products</th>
                    <th className={`${th} text-right`}>Material used</th>
                    <th className={`${th} text-right`}>Output / 100</th>
                    <th className={th}>Top products</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.entries.map((r) => (
                    <tr key={r.name} className="border-b border-line/60">
                      <td className="py-1.5 text-ink">
                        {fmtDate(r.date)} <span className="text-[10px] text-ink-3">{r.weekday}</span>
                      </td>
                      <td className="py-1.5 text-ink-2" title={r.purpose}>{r.name}</td>
                      <td className="py-1.5 text-ink">{short(r.department)}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                      <td className={tdNum}>{num(r.qty, 1)}</td>
                      <td className={tdNum}>{num(r.items)}</td>
                      <td className={tdNum}>{r.used ? pkr(r.used) : <span className="text-ink-3">—</span>}</td>
                      <td className={`py-1.5 text-right font-medium ${yieldTone(r.yield_pct)}`} title="finished goods value booked per PKR 100 of material used">{r.yield_pct === null ? "—" : `PKR ${num(r.yield_pct, 0)}`}</td>
                      <td className="max-w-[320px] truncate py-1.5 text-ink-3" title={r.top_products.join(" · ")}>{r.top_products.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.entries_total > d.entries.length && <p className="mt-2 text-[11px] text-ink-3">Showing the latest {num(d.entries.length)} of {num(d.entries_total)} entries. Narrow the date range to see the rest.</p>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
