"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import { fmtDate, fmtPeriod, fmtRange, num, pkr } from "@/lib/format";
import type {
  PurchaseAnalysis as Payload, PurchaseDayRow, PurchaseInvoiceRow, PurchaseItemRow, PurchaseLineRow, PurchaseSupplierItemRow, PurchaseSupplierRow, PurchaseWeekdayRow, Range,
} from "@/lib/types";
import Card from "./Card";
import HorizontalBars from "./charts/HorizontalBars";
import StackedColumns from "./charts/StackedColumns";
import DeltaText from "./DeltaText";
import ExportButtons from "./ExportButtons";
import TableFilter from "./TableFilter";
import ViewToggle from "./ViewToggle";
import WeekdayFilter from "./WeekdayFilter";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

type View = "suppliers" | "daily" | "weekday" | "items" | "pairs" | "invoices" | "lines";
type ItemSort = "amount" | "qty" | "rate" | "change" | "days";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 pl-3 text-right text-ink-2";
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const select = "rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink";

/** "B&B Raw Material" -> "Raw Material"; keeps short supplier names readable in chart legends and column heads. */
function short(s: string): string {
  return s.replace(/^B&B\s+/i, "").trim() || s;
}

function matches(q: string) {
  const needle = q.trim().toLowerCase();
  return (r: { item_name: string; item_code: string }) => !needle || r.item_name.toLowerCase().includes(needle) || r.item_code.toLowerCase().includes(needle);
}

function Tile({ label, value, sub, delta, children }: { label: string; value: string; sub?: string; delta?: number | null; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="tnum text-base font-semibold text-ink">{value}</span>
        {delta !== undefined && <DeltaText value={delta} invert className="text-[11px]" />}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-ink-3" title={sub}>{sub}</div>}
      {children}
    </div>
  );
}

/**
 * Purchase analysis: who the bakery bought from, how much, on which days, which items, at what rate.
 * Supplier-wise, day-wise (with the per-supplier split), weekday pattern, item-wise with rate watch, supplier x item,
 * every invoice and every invoice line (which supplier delivered which item on which day).
 */
export default function PurchaseAnalysis({ range, refreshKey, onRetry }: Props) {
  const [days, setDays] = useState<string[]>([]);
  const q = useApi<Payload>("/api/stock/purchases", range, refreshKey, days.length ? { weekdays: days.join(",") } : {});
  const [view, setView] = useState<View>("suppliers");
  const [supplier, setSupplier] = useState("");
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const [itemSort, setItemSort] = useState<ItemSort>("amount");
  const [pairSupplier, setPairSupplier] = useState<string | null>(null);
  const d = q.data;
  const s = d?.summary;
  const gran = d?.granularity ?? "day";
  const suppliers = d?.suppliers ?? [];
  const keys = suppliers.map(short);
  const groups = Array.from(new Set((d?.items ?? []).map((r) => r.item_group))).sort();
  const activePair = pairSupplier && suppliers.includes(pairSupplier) ? pairSupplier : suppliers[0];
  const activePairInfo = d?.by_supplier.find((r) => r.supplier === activePair);
  const stem = `${range.start}-${range.end}`;
  const scope = `${fmtRange(range.start, range.end)}${days.length ? ` · ${days.join(", ")} only` : ""}`;

  // --- filtered rows per view
  const items = (d?.items ?? [])
    .filter((r) => (!group || r.item_group === group) && (!supplier || r.supplier_names.split(", ").includes(supplier)) && matches(query)(r))
    .sort((a, b) => {
      if (itemSort === "qty") return b.qty - a.qty;
      if (itemSort === "rate") return b.avg_rate - a.avg_rate;
      if (itemSort === "change") return Math.abs(b.rate_change_pct ?? 0) - Math.abs(a.rate_change_pct ?? 0);
      if (itemSort === "days") return b.active_days - a.active_days;
      return b.amount - a.amount;
    });
  const pairs = (d?.supplier_items ?? []).filter((r) => r.supplier === activePair && (!group || r.item_group === group) && matches(query)(r));
  const invoices = (d?.invoices ?? []).filter((r) => (!supplier || r.supplier === supplier) && (!query.trim() || r.name.toLowerCase().includes(query.trim().toLowerCase()) || r.groups.toLowerCase().includes(query.trim().toLowerCase())));
  const lines = (d?.lines ?? []).filter((r) => (!supplier || r.supplier === supplier) && (!group || r.item_group === group) && (matches(query)(r) || r.invoice.toLowerCase().includes(query.trim().toLowerCase())));
  const dayRows = (d?.daily ?? []).map((r) => ({ label: fmtPeriod(r.period, gran), weekday: r.weekday, total: r.total, invoices: r.invoices, ...Object.fromEntries(suppliers.map((k) => [short(k), r.by_supplier[k] ?? 0])) }));
  const tickEvery = dayRows.length > 40 ? 4 : dayRows.length > 20 ? 2 : 1;
  const weekdayBars = (d?.by_weekday ?? []).map((r) => ({ label: r.weekday, value: r.amount, invoices: r.invoices, avg: r.avg_per_active_day }));

  // --- export columns
  const supplierCols: CsvColumn<PurchaseSupplierRow>[] = [
    { key: "supplier", header: "Supplier", value: (r) => r.supplier },
    { key: "amount", header: "Purchased (PKR)", value: (r) => r.amount },
    { key: "share", header: "Share %", value: (r) => r.share_pct },
    { key: "invoices", header: "Invoices", value: (r) => r.invoices },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "active_days", header: "Active days", value: (r) => r.active_days },
    { key: "avg_inv", header: "Avg per invoice", value: (r) => r.avg_per_invoice },
    { key: "avg_day", header: "Avg per active day", value: (r) => r.avg_per_active_day },
    { key: "first", header: "First purchase", value: (r) => r.first_date },
    { key: "last", header: "Last purchase", value: (r) => r.last_date },
    { key: "weekdays", header: "Buying days", value: (r) => r.weekdays },
    { key: "groups", header: "Item groups", value: (r) => r.groups },
    { key: "warehouses", header: "Delivered to", value: (r) => r.warehouses },
    { key: "top", header: "Top item", value: (r) => (r.top_item ? `${r.top_item.item_name} (${r.top_item.amount})` : "") },
    ...WEEKDAYS.map((w) => ({ key: `wd_${w}`, header: `${w} (PKR)`, value: (r: PurchaseSupplierRow) => r.by_weekday[w] ?? 0 })),
    { key: "prev", header: "Previous (PKR)", value: (r) => r.prev_amount },
    { key: "delta", header: "Change %", value: (r) => r.delta_pct },
  ];
  const dailyCols: CsvColumn<PurchaseDayRow>[] = [
    { key: "period", header: gran === "month" ? "Month" : "Date", value: (r) => r.period },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    ...suppliers.map((k) => ({ key: k, header: `${k} (PKR)`, value: (r: PurchaseDayRow) => r.by_supplier[k] ?? 0 })),
    { key: "total", header: "Total (PKR)", value: (r) => r.total },
    { key: "cum", header: "Running total (PKR)", value: (r) => r.cum_total },
    { key: "invoices", header: "Invoices", value: (r) => r.invoices },
    { key: "suppliers", header: "Suppliers", value: (r) => r.suppliers },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "top", header: "Top item", value: (r) => (r.top_item ? `${r.top_item.item_name} (${r.top_item.amount})` : "") },
  ];
  const weekdayCols: CsvColumn<PurchaseWeekdayRow>[] = [
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "amount", header: "Purchased (PKR)", value: (r) => r.amount },
    { key: "share", header: "Share %", value: (r) => r.share_pct },
    { key: "days", header: "Days in range", value: (r) => r.days },
    { key: "active", header: "Buying days", value: (r) => r.active_days },
    { key: "avg_active", header: "Avg per buying day", value: (r) => r.avg_per_active_day },
    { key: "avg", header: "Avg per day", value: (r) => r.avg_per_day },
    { key: "invoices", header: "Invoices", value: (r) => r.invoices },
    { key: "suppliers", header: "Suppliers", value: (r) => r.suppliers },
    { key: "items", header: "Items", value: (r) => r.items },
    ...suppliers.map((k) => ({ key: k, header: `${k} (PKR)`, value: (r: PurchaseWeekdayRow) => r.by_supplier[k] ?? 0 })),
    { key: "top", header: "Top item", value: (r) => (r.top_item ? `${r.top_item.item_name} (${r.top_item.amount})` : "") },
  ];
  const itemCols: CsvColumn<PurchaseItemRow>[] = [
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "amount", header: "Purchased (PKR)", value: (r) => r.amount },
    { key: "share", header: "Share %", value: (r) => r.share_pct },
    { key: "avg_rate", header: "Avg rate", value: (r) => r.avg_rate },
    { key: "min_rate", header: "Lowest rate", value: (r) => r.min_rate },
    { key: "max_rate", header: "Highest rate", value: (r) => r.max_rate },
    { key: "last_rate", header: "Last rate", value: (r) => r.last_rate },
    { key: "last_date", header: "Last bought", value: (r) => r.last_date },
    { key: "prev_rate", header: "Previous avg rate", value: (r) => r.prev_rate },
    { key: "rate_chg", header: "Rate change %", value: (r) => r.rate_change_pct },
    { key: "invoices", header: "Invoices", value: (r) => r.invoices },
    { key: "active_days", header: "Buying days", value: (r) => r.active_days },
    { key: "weekdays", header: "Weekdays", value: (r) => r.weekdays },
    { key: "suppliers", header: "Suppliers", value: (r) => r.supplier_names },
    { key: "main", header: "Main supplier", value: (r) => r.main_supplier },
    { key: "main_share", header: "Main supplier share %", value: (r) => r.main_supplier_share_pct },
    { key: "warehouses", header: "Delivered to", value: (r) => r.warehouses },
    { key: "prev", header: "Previous (PKR)", value: (r) => r.prev_amount },
    { key: "delta", header: "Change %", value: (r) => r.delta_pct },
  ];
  const pairCols: CsvColumn<PurchaseSupplierItemRow>[] = [
    { key: "supplier", header: "Supplier", value: (r) => r.supplier },
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "amount", header: "Purchased (PKR)", value: (r) => r.amount },
    { key: "share_sup", header: "Share of supplier %", value: (r) => r.share_of_supplier_pct },
    { key: "share_all", header: "Share of total %", value: (r) => r.share_of_total_pct },
    { key: "avg_rate", header: "Avg rate", value: (r) => r.avg_rate },
    { key: "min_rate", header: "Lowest rate", value: (r) => r.min_rate },
    { key: "max_rate", header: "Highest rate", value: (r) => r.max_rate },
    { key: "last_rate", header: "Last rate", value: (r) => r.last_rate },
    { key: "invoices", header: "Invoices", value: (r) => r.invoices },
    { key: "active_days", header: "Buying days", value: (r) => r.active_days },
    { key: "weekdays", header: "Weekdays", value: (r) => r.weekdays },
    { key: "dates", header: "Dates", value: (r) => r.dates.join(", ") },
  ];
  const invoiceCols: CsvColumn<PurchaseInvoiceRow>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "name", header: "Invoice", value: (r) => r.name },
    { key: "supplier", header: "Supplier", value: (r) => r.supplier },
    { key: "warehouse", header: "Delivered to", value: (r) => r.warehouse },
    { key: "amount", header: "Amount (PKR)", value: (r) => r.amount },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "groups", header: "Item groups", value: (r) => r.groups },
    { key: "top", header: "Top item", value: (r) => (r.top_item ? `${r.top_item.item_name} (${r.top_item.amount})` : "") },
    { key: "return", header: "Return", value: (r) => (r.is_return ? "yes" : "") },
  ];
  const lineCols: CsvColumn<PurchaseLineRow>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "invoice", header: "Invoice", value: (r) => r.invoice },
    { key: "supplier", header: "Supplier", value: (r) => r.supplier },
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "warehouse", header: "Delivered to", value: (r) => r.warehouse },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "rate", header: "Rate", value: (r) => r.rate },
    { key: "amount", header: "Amount (PKR)", value: (r) => r.amount },
    { key: "return", header: "Return", value: (r) => (r.is_return ? "yes" : "") },
  ];

  const exportView = () => {
    if (!d) return;
    if (view === "suppliers") exportTable("csv", `purchases-by-supplier-${stem}`, d.by_supplier, supplierCols);
    else if (view === "daily") exportTable("csv", `purchases-${gran === "month" ? "monthly" : "daily"}-${stem}`, d.daily, dailyCols);
    else if (view === "weekday") exportTable("csv", `purchases-by-weekday-${stem}`, d.by_weekday, weekdayCols);
    else if (view === "items") exportTable("csv", `purchases-by-item-${stem}`, items, itemCols);
    else if (view === "pairs") exportTable("csv", `purchases-${short(activePair ?? "").toLowerCase().replace(/\s+/g, "-")}-items-${stem}`, pairs, pairCols);
    else if (view === "invoices") exportTable("csv", `purchase-invoices-${stem}`, invoices, invoiceCols);
    else exportTable("csv", `purchase-lines-${stem}`, lines, lineCols);
  };
  const exportWorkbook = () => {
    if (!d) return;
    void downloadWorkbook(`purchase-analysis-${stem}.xlsx`, [
      { name: "Suppliers", title: "Purchase Analysis · Suppliers", subtitle: `${scope} · ${pkr(d.summary.total)} in ${num(d.summary.invoices)} invoices from ${num(d.summary.suppliers)} suppliers · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}`, columns: supplierCols, rows: d.by_supplier, totals: true, noTotal: ["share", "avg_inv", "avg_day", "active_days", "items", "delta"] },
      { name: gran === "month" ? "Month-wise" : "Day-wise", title: `Purchase Analysis · ${gran === "month" ? "Month" : "Day"}-wise`, subtitle: `${scope} · purchased per ${gran === "month" ? "month" : "day"} split by supplier, PKR`, columns: dailyCols, rows: d.daily, totals: true, noTotal: ["cum", "suppliers", "items"] },
      { name: "Weekday", title: "Purchase Analysis · Weekday pattern", subtitle: `${scope} · which day of the week the buying happens`, columns: weekdayCols, rows: d.by_weekday, totals: true, noTotal: ["share", "avg_active", "avg", "suppliers", "items"] },
      { name: "Items", title: "Purchase Analysis · Items", subtitle: `${scope} · every item bought, with rate watch and the supplier it came from`, columns: itemCols, rows: d.items, totals: true, noTotal: ["share", "avg_rate", "min_rate", "max_rate", "last_rate", "prev_rate", "rate_chg", "active_days", "main_share", "delta"] },
      { name: "Supplier x Item", title: "Purchase Analysis · Supplier × Item", subtitle: `${scope} · which supplier delivered which item, on which dates, at what rate`, columns: pairCols, rows: d.supplier_items, totals: true, noTotal: ["share_sup", "share_all", "avg_rate", "min_rate", "max_rate", "last_rate", "active_days"] },
      { name: "Invoices", title: "Purchase Analysis · Invoices", subtitle: `${scope} · ${num(d.invoices.length)} purchase invoices`, columns: invoiceCols, rows: d.invoices, totals: true, noTotal: ["items"] },
      { name: "Lines", title: "Purchase Analysis · Invoice lines", subtitle: `${scope} · ${num(d.lines.length)} lines: supplier, day, item, qty, rate`, columns: lineCols, rows: d.lines, totals: true, noTotal: ["rate"] },
    ]);
  };
  const onExport = (fmt: ExportFormat) => (fmt === "xlsx" ? exportWorkbook() : exportView());

  const supplierSelect = (
    <select value={supplier} onChange={(e) => setSupplier(e.target.value)} aria-label="Supplier" className={select}>
      <option value="">All suppliers</option>
      {suppliers.map((k) => (
        <option key={k} value={k}>{k}</option>
      ))}
    </select>
  );
  const rateCell = (r: { avg_rate: number; min_rate: number | null; max_rate: number | null }) => (
    <td className={tdNum} title={r.min_rate !== null && r.max_rate !== null && r.min_rate !== r.max_rate ? `paid between ${pkr(r.min_rate, { decimals: true })} and ${pkr(r.max_rate, { decimals: true })}` : undefined}>
      {pkr(r.avg_rate, { decimals: true })}
      {r.min_rate !== null && r.max_rate !== null && r.min_rate !== r.max_rate && <span className="ml-1 text-[10px] text-warn">±</span>}
    </td>
  );

  return (
    <Card
      id="purchase-analysis"
      title="Purchase Analysis"
      subtitle={
        s
          ? `${scope} · ${pkr(s.total)} in ${num(s.invoices)} invoices from ${num(s.suppliers)} suppliers · ${num(s.items)} items on ${num(s.active_days)} of ${num(s.days)} days · change vs ${fmtRange(d!.previous_range.start, d!.previous_range.end)}`
          : undefined
      }
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && d.by_supplier.length === 0}
      emptyHint="No purchase invoices in this range."
      onRetry={onRetry}
      height={260}
      action={d ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {d && s && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Purchased" value={pkr(s.total)} delta={s.delta_pct} sub={`previous ${pkr(s.prev_total)}${s.returns ? ` · ${num(s.returns)} returns ${pkr(s.return_amount)}` : ""}`} />
            <Tile label="Invoices" value={num(s.invoices)} sub={`avg ${pkr(s.avg_per_invoice)} per invoice · ${num(s.lines)} lines`} />
            <Tile label="Buying days" value={`${num(s.active_days)} / ${num(s.days)}`} sub={`avg ${pkr(s.avg_per_active_day)} per buying day · ${pkr(s.avg_per_day)} per day`} />
            <Tile label="Top supplier" value={s.top_supplier ? short(s.top_supplier.supplier) : "—"} sub={s.top_supplier ? `${pkr(s.top_supplier.amount)} · ${s.top_supplier.share_pct}% of purchases · ${num(s.suppliers)} suppliers in all` : undefined} />
            <Tile label="Top item" value={s.top_item?.item_name ?? "—"} sub={s.top_item ? `${pkr(s.top_item.amount)} · ${s.top_item.share_pct}% · from ${s.top_item.main_supplier ?? "—"}` : undefined} />
            <Tile label="Largest invoice" value={s.largest_invoice ? pkr(s.largest_invoice.amount) : "—"} sub={s.largest_invoice ? `${s.largest_invoice.name} · ${short(s.largest_invoice.supplier)} · ${fmtDate(s.largest_invoice.date)}` : undefined} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <ViewToggle
              value={view}
              options={[
                { id: "suppliers", label: "Suppliers" },
                { id: "daily", label: gran === "month" ? "Month-wise" : "Day-wise" },
                { id: "weekday", label: "Weekday" },
                { id: "items", label: "Items" },
                { id: "pairs", label: "Supplier × Item" },
                { id: "invoices", label: "Invoices" },
                { id: "lines", label: "Lines" },
              ]}
              onChange={setView}
            />
            <WeekdayFilter value={days} onChange={setDays} />
          </div>

          {view === "suppliers" && (
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 xl:grid-cols-5">
                <div className="xl:col-span-2">
                  <HorizontalBars rows={d.by_supplier.map((r) => ({ label: short(r.supplier), value: r.amount, share: r.share_pct, invoices: r.invoices }))} ordinal format={(v, e) => `${pkr(v)} · ${e.payload?.share}% · ${num(Number(e.payload?.invoices ?? 0))} invoices`} labelWidth={120} />
                </div>
                <div className="overflow-x-auto xl:col-span-3">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-3">Purchases by item group and warehouse</div>
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className={`${thead} whitespace-nowrap`}>
                        <th className={th}>Group / warehouse</th>
                        <th className={`${th} pl-3 text-right`}>Purchased</th>
                        <th className={`${th} pl-3 text-right`}>Share</th>
                        <th className={`${th} pl-3 text-right`}>Items</th>
                        <th className={`${th} pl-3 text-right`}>Invoices</th>
                        <th className={`${th} pl-3`}>Suppliers</th>
                      </tr>
                    </thead>
                    <tbody className="tnum">
                      {d.by_group.map((r) => (
                        <tr key={`g-${r.item_group}`} className="border-b border-line/60">
                          <td className="py-1 text-ink">{r.item_group}</td>
                          <td className="py-1 pl-3 text-right font-medium text-ink">{pkr(r.amount)}</td>
                          <td className={tdNum}>{r.share_pct}%</td>
                          <td className={tdNum}>{num(r.items)}</td>
                          <td className={tdNum}>{num(r.invoices)}</td>
                          <td className="max-w-[260px] truncate py-1 pl-3 text-ink-3" title={r.supplier_names}>{r.supplier_names}</td>
                        </tr>
                      ))}
                      {d.by_warehouse.map((r) => (
                        <tr key={`w-${r.warehouse}`} className="border-b border-line/60 bg-surface-2/40">
                          <td className="py-1 text-ink-2">→ {r.warehouse}</td>
                          <td className="py-1 pl-3 text-right text-ink-2">{pkr(r.amount)}</td>
                          <td className={tdNum}>{r.share_pct}%</td>
                          <td className={tdNum}>{num(r.items)}</td>
                          <td className={tdNum}>{num(r.invoices)}</td>
                          <td className="max-w-[260px] truncate py-1 pl-3 text-ink-3" title={r.supplier_names}>{r.supplier_names}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1400px] text-xs">
                  <thead>
                    <tr className={`${thead} whitespace-nowrap`}>
                      <th className={th}>Supplier</th>
                      <th className={`${th} pl-3 text-right`}>Purchased</th>
                      <th className={`${th} pl-3 text-right`}>Share</th>
                      <th className={`${th} pl-3 text-right`}>Invoices</th>
                      <th className={`${th} pl-3 text-right`}>Items</th>
                      <th className={`${th} pl-3 text-right`}>Buying days</th>
                      <th className={`${th} pl-3 text-right`}>Avg / invoice</th>
                      <th className={`${th} pl-3 text-right`}>Avg / day</th>
                      <th className={th}>First → last</th>
                      <th className={th}>Days of week</th>
                      <th className={th}>Supplies</th>
                      <th className={th}>Top item</th>
                      <th className={`${th} pl-3 text-right`}>Previous</th>
                      <th className={`${th} pl-3 text-right`}>vs prev</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {d.by_supplier.map((r, i) => (
                      <tr key={r.supplier} className="border-b border-line/60">
                        <td className="whitespace-nowrap py-1.5 text-ink">
                          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: SERIES[i % SERIES.length] }} />
                          {r.supplier}
                          {r.returns > 0 && <span className="ml-1 text-[10px] text-warn">{num(r.returns)} returns</span>}
                        </td>
                        <td className="py-1.5 pl-3 text-right font-medium text-ink">{pkr(r.amount)}</td>
                        <td className={tdNum}>{r.share_pct}%</td>
                        <td className={tdNum}>{num(r.invoices)}</td>
                        <td className={tdNum}>{num(r.items)}</td>
                        <td className={tdNum}>{num(r.active_days)}</td>
                        <td className={tdNum}>{pkr(r.avg_per_invoice)}</td>
                        <td className={tdNum} title="per day on which this supplier delivered">{pkr(r.avg_per_active_day)}</td>
                        <td className="whitespace-nowrap py-1.5 text-ink-2">{fmtDate(r.first_date)} → {fmtDate(r.last_date)}</td>
                        <td className="whitespace-nowrap py-1.5 text-ink-3" title={WEEKDAYS.map((w) => `${w}: ${pkr(r.by_weekday[w] ?? 0)}`).join(" · ")}>{r.weekdays}</td>
                        <td className="max-w-[200px] truncate py-1.5 text-ink-3" title={`${r.groups} → ${r.warehouses}`}>{r.groups}</td>
                        <td className="max-w-[220px] truncate py-1.5 text-ink-2" title={r.top_item ? `${r.top_item.item_name} · ${pkr(r.top_item.amount)}` : undefined}>
                          {r.top_item ? `${r.top_item.item_name} · ${pkr(r.top_item.amount)}` : "—"}
                        </td>
                        <td className={tdNum}>{pkr(r.prev_amount)}</td>
                        <td className="py-1.5 pl-3 text-right"><DeltaText value={r.delta_pct} invert /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Change is against the same-length window before this range. Hover a supplier&apos;s days of week to see how much was bought on each weekday.</p>
            </div>
          )}

          {view === "daily" && (
            <div className="flex flex-col gap-3">
              <StackedColumns
                rows={dayRows}
                keys={keys}
                height={260}
                tickEvery={tickEvery}
                labelFormat={(label, e) => `${label}${e?.payload?.weekday ? ` (${e.payload.weekday})` : ""} · ${pkr(Number(e?.payload?.total ?? 0))} · ${num(Number(e?.payload?.invoices ?? 0))} invoices`}
              />
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full min-w-[900px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>{gran === "month" ? "Month" : "Date"}</th>
                      {keys.map((k) => (
                        <th key={k} className={`${th} pl-3 text-right`}>{k}</th>
                      ))}
                      <th className={`${th} pl-3 text-right`}>Total</th>
                      <th className={`${th} pl-3 text-right`}>Running</th>
                      <th className={`${th} pl-3 text-right`}>Invoices</th>
                      <th className={`${th} pl-3 text-right`}>Items</th>
                      <th className={th}>Top item</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {d.daily.map((r) => (
                      <tr key={r.period} className={`border-b border-line/60 ${r.total === 0 ? "text-ink-3" : ""}`}>
                        <td className="whitespace-nowrap py-1 text-ink">
                          {fmtPeriod(r.period, gran)} <span className="text-[10px] text-ink-3">{r.weekday}</span>
                        </td>
                        {suppliers.map((k) => (
                          <td key={k} className={tdNum}>{r.by_supplier[k] ? num(r.by_supplier[k]) : <span className="text-ink-3">—</span>}</td>
                        ))}
                        <td className={`py-1 pl-3 text-right font-medium ${r.total ? "text-ink" : "text-ink-3"}`}>{r.total ? num(r.total) : "no purchase"}</td>
                        <td className={tdNum}>{num(r.cum_total)}</td>
                        <td className={tdNum}>{r.invoices ? num(r.invoices) : "—"}</td>
                        <td className={tdNum}>{r.items ? num(r.items) : "—"}</td>
                        <td className="max-w-[220px] truncate py-1 pl-3 text-ink-3" title={r.top_item ? `${r.top_item.item_name} · ${pkr(r.top_item.amount)}` : undefined}>
                          {r.top_item ? `${r.top_item.item_name} · ${num(r.top_item.amount)}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Figures in PKR. One column per supplier; &quot;Running&quot; is the cumulative purchase value through that {gran === "month" ? "month" : "day"}.</p>
            </div>
          )}

          {view === "weekday" && (
            <div className="grid gap-4 xl:grid-cols-5">
              <div className="xl:col-span-2">
                <HorizontalBars rows={weekdayBars} format={(v, e) => `${pkr(v)} · ${num(Number(e.payload?.invoices ?? 0))} invoices · avg ${pkr(Number(e.payload?.avg ?? 0))} per buying day`} labelWidth={48} height={240} />
              </div>
              <div className="overflow-x-auto xl:col-span-3">
                <table className="w-full min-w-[760px] text-xs">
                  <thead>
                    <tr className={thead}>
                      <th className={th}>Day</th>
                      <th className={`${th} pl-3 text-right`}>Purchased</th>
                      <th className={`${th} pl-3 text-right`}>Share</th>
                      <th className={`${th} pl-3 text-right`}>Buying days</th>
                      <th className={`${th} pl-3 text-right`}>Avg / buying day</th>
                      <th className={`${th} pl-3 text-right`}>Invoices</th>
                      <th className={`${th} pl-3 text-right`}>Suppliers</th>
                      <th className={th}>Biggest supplier that day</th>
                      <th className={th}>Top item</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {d.by_weekday.map((r) => {
                      const top = Object.entries(r.by_supplier).sort((a, b) => b[1] - a[1])[0];
                      return (
                        <tr key={r.weekday} className={`border-b border-line/60 ${r.amount === 0 ? "text-ink-3" : ""}`}>
                          <td className="py-1.5 font-medium text-ink">{r.weekday}</td>
                          <td className="py-1.5 pl-3 text-right font-medium text-ink">{pkr(r.amount)}</td>
                          <td className={tdNum}>{r.share_pct}%</td>
                          <td className={tdNum}>{num(r.active_days)} / {num(r.days)}</td>
                          <td className={tdNum}>{pkr(r.avg_per_active_day)}</td>
                          <td className={tdNum}>{num(r.invoices)}</td>
                          <td className={tdNum}>{num(r.suppliers)}</td>
                          <td className="py-1.5 pl-3 text-ink-2" title={Object.entries(r.by_supplier).map(([k, v]) => `${k}: ${pkr(v)}`).join(" · ")}>{top ? `${short(top[0])} · ${pkr(top[1])}` : "—"}</td>
                          <td className="max-w-[200px] truncate py-1.5 pl-3 text-ink-3">{r.top_item ? `${r.top_item.item_name} · ${num(r.top_item.amount)}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] text-ink-3">Which day of the week the buying happens. Hover &quot;Biggest supplier&quot; for every supplier&apos;s amount on that weekday.</p>
              </div>
            </div>
          )}

          {view === "items" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <TableFilter query={query} onQuery={setQuery} group={group} onGroup={setGroup} groups={groups} shown={items.length} total={d.items.length} />
                {supplierSelect}
                <select value={itemSort} onChange={(e) => setItemSort(e.target.value as ItemSort)} aria-label="Sort" className={select}>
                  <option value="amount">Sort: amount</option>
                  <option value="qty">Sort: quantity</option>
                  <option value="rate">Sort: highest rate</option>
                  <option value="change">Sort: biggest rate change</option>
                  <option value="days">Sort: most buying days</option>
                </select>
              </div>
              <div className="max-h-[560px] overflow-auto">
                <table className="w-full min-w-[1200px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>Item</th>
                      <th className={th}>Group</th>
                      <th className={`${th} pl-3 text-right`}>Qty</th>
                      <th className={`${th} pl-3 text-right`}>Purchased</th>
                      <th className={`${th} pl-3 text-right`}>Share</th>
                      <th className={`${th} pl-3 text-right`}>Avg rate</th>
                      <th className={`${th} pl-3 text-right`}>Last rate</th>
                      <th className={`${th} pl-3 text-right`}>vs prev rate</th>
                      <th className={`${th} pl-3 text-right`}>Invoices</th>
                      <th className={`${th} pl-3 text-right`}>Days</th>
                      <th className={th}>Weekdays</th>
                      <th className={th}>Supplier</th>
                      <th className={th}>Last bought</th>
                      <th className={`${th} pl-3 text-right`}>vs prev</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {items.map((r) => (
                      <tr key={r.item_code} className="border-b border-line/60">
                        <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name}</td>
                        <td className="py-1.5 text-ink-3">{r.item_group}</td>
                        <td className={tdNum}>{num(r.qty, 2)} <span className="text-ink-3">{r.uom}</span></td>
                        <td className="py-1.5 pl-3 text-right font-medium text-ink">{pkr(r.amount)}</td>
                        <td className={tdNum}>{r.share_pct}%</td>
                        {rateCell(r)}
                        <td className={tdNum}>{r.last_rate === null ? "—" : pkr(r.last_rate, { decimals: true })}</td>
                        <td className="py-1.5 pl-3 text-right" title={r.prev_rate !== null ? `previous window avg rate ${pkr(r.prev_rate, { decimals: true })}` : "not bought in the previous window"}><DeltaText value={r.rate_change_pct} invert /></td>
                        <td className={tdNum}>{num(r.invoices)}</td>
                        <td className={tdNum}>{num(r.active_days)}</td>
                        <td className="whitespace-nowrap py-1.5 text-ink-3">{r.weekdays}</td>
                        <td className="max-w-[200px] truncate py-1.5 text-ink-2" title={r.supplier_names}>
                          {r.main_supplier ?? "—"}
                          {r.suppliers > 1 && <span className="ml-1 text-[10px] text-ink-3">+{r.suppliers - 1} more · {r.main_supplier_share_pct}%</span>}
                        </td>
                        <td className="whitespace-nowrap py-1.5 text-ink-2">{fmtDate(r.last_date)}</td>
                        <td className="py-1.5 pl-3 text-right"><DeltaText value={r.delta_pct} invert /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Avg rate = amount ÷ quantity over the non-return lines; ± marks items bought at more than one rate (hover for the lowest and highest). &quot;vs prev rate&quot; compares the average rate with the previous window.</p>
            </div>
          )}

          {view === "pairs" && activePair && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <ViewToggle value={activePair} options={suppliers.map((k) => ({ id: k, label: short(k) }))} onChange={setPairSupplier} />
                {activePairInfo && (
                  <span className="text-xs text-ink-3">
                    {num(activePairInfo.items)} items · {pkr(activePairInfo.amount)} in {num(activePairInfo.invoices)} invoices on {num(activePairInfo.active_days)} days ({activePairInfo.weekdays}) · {fmtDate(activePairInfo.first_date)} → {fmtDate(activePairInfo.last_date)}
                  </span>
                )}
              </div>
              <TableFilter query={query} onQuery={setQuery} group={group} onGroup={setGroup} groups={groups} shown={pairs.length} total={d.supplier_items.filter((r) => r.supplier === activePair).length} />
              <div className="max-h-[560px] overflow-auto">
                <table className="w-full min-w-[1100px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>Item</th>
                      <th className={th}>Group</th>
                      <th className={`${th} pl-3 text-right`}>Qty</th>
                      <th className={`${th} pl-3 text-right`}>Purchased</th>
                      <th className={`${th} pl-3 text-right`}>Of supplier</th>
                      <th className={`${th} pl-3 text-right`}>Of total</th>
                      <th className={`${th} pl-3 text-right`}>Avg rate</th>
                      <th className={`${th} pl-3 text-right`}>Last rate</th>
                      <th className={`${th} pl-3 text-right`}>Invoices</th>
                      <th className={`${th} pl-3 text-right`}>Days</th>
                      <th className={th}>Weekdays</th>
                      <th className={th}>Dates delivered</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {pairs.map((r) => (
                      <tr key={`${r.supplier}|${r.item_code}`} className="border-b border-line/60">
                        <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name}</td>
                        <td className="py-1.5 text-ink-3">{r.item_group}</td>
                        <td className={tdNum}>{num(r.qty, 2)} <span className="text-ink-3">{r.uom}</span></td>
                        <td className="py-1.5 pl-3 text-right font-medium text-ink">{pkr(r.amount)}</td>
                        <td className={tdNum}>{r.share_of_supplier_pct}%</td>
                        <td className={tdNum}>{r.share_of_total_pct}%</td>
                        {rateCell(r)}
                        <td className={tdNum}>{r.last_rate === null ? "—" : pkr(r.last_rate, { decimals: true })}</td>
                        <td className={tdNum}>{num(r.invoices)}</td>
                        <td className={tdNum}>{num(r.active_days)}</td>
                        <td className="whitespace-nowrap py-1.5 text-ink-3">{r.weekdays}</td>
                        <td className="max-w-[360px] truncate py-1.5 pl-3 text-ink-3" title={r.dates.map(fmtDate).join(", ")}>{r.dates.map((x) => fmtPeriod(x, "day")).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Every item this supplier delivered in the range, with each date it came in. &quot;Of supplier&quot; is the item&apos;s share of this supplier&apos;s purchases; &quot;Of total&quot; its share of all purchases.</p>
            </div>
          )}

          {view === "invoices" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <TableFilter query={query} onQuery={setQuery} shown={invoices.length} total={d.invoices.length} placeholder="Search invoice no. or item group…" />
                {supplierSelect}
              </div>
              <div className="max-h-[560px] overflow-auto">
                <table className="w-full min-w-[960px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>Date</th>
                      <th className={th}>Invoice</th>
                      <th className={th}>Supplier</th>
                      <th className={th}>Delivered to</th>
                      <th className={`${th} pl-3 text-right`}>Amount</th>
                      <th className={`${th} pl-3 text-right`}>Qty</th>
                      <th className={`${th} pl-3 text-right`}>Items</th>
                      <th className={th}>Groups</th>
                      <th className={th}>Top item</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {invoices.map((r) => (
                      <tr key={r.name} className="border-b border-line/60">
                        <td className="whitespace-nowrap py-1.5 text-ink">
                          {fmtDate(r.date)} <span className="text-[10px] text-ink-3">{r.weekday}</span>
                        </td>
                        <td className="whitespace-nowrap py-1.5 text-ink-2">
                          {r.name}
                          {r.is_return && <span className="ml-1 rounded bg-warn/10 px-1 text-[10px] text-warn">return</span>}
                        </td>
                        <td className="py-1.5 text-ink">{r.supplier}</td>
                        <td className="py-1.5 text-ink-2">{r.warehouse}</td>
                        <td className={`py-1.5 pl-3 text-right font-medium ${r.amount < 0 ? "text-bad" : "text-ink"}`}>{pkr(r.amount)}</td>
                        <td className={tdNum}>{num(r.qty, 1)}</td>
                        <td className={tdNum}>{num(r.items)}</td>
                        <td className="max-w-[200px] truncate py-1.5 pl-3 text-ink-3" title={r.groups}>{r.groups}</td>
                        <td className="max-w-[240px] truncate py-1.5 pl-3 text-ink-3" title={r.top_item ? `${r.top_item.item_name} · ${pkr(r.top_item.amount)}` : undefined}>
                          {r.top_item ? `${r.top_item.item_name} · ${num(r.top_item.amount)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {view === "lines" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <TableFilter query={query} onQuery={setQuery} group={group} onGroup={setGroup} groups={groups} shown={lines.length} total={d.lines.length} placeholder="Search item, code or invoice…" />
                {supplierSelect}
              </div>
              <div className="max-h-[600px] overflow-auto">
                <table className="w-full min-w-[1100px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>Date</th>
                      <th className={th}>Supplier</th>
                      <th className={th}>Item</th>
                      <th className={th}>Group</th>
                      <th className={`${th} pl-3 text-right`}>Qty</th>
                      <th className={`${th} pl-3 text-right`}>Rate</th>
                      <th className={`${th} pl-3 text-right`}>Amount</th>
                      <th className={th}>Delivered to</th>
                      <th className={th}>Invoice</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {lines.map((r, i) => (
                      <tr key={`${r.invoice}|${r.item_code}|${i}`} className="border-b border-line/60">
                        <td className="whitespace-nowrap py-1 text-ink">
                          {fmtDate(r.date)} <span className="text-[10px] text-ink-3">{r.weekday}</span>
                        </td>
                        <td className="whitespace-nowrap py-1 text-ink">{r.supplier}</td>
                        <td className="py-1 text-ink" title={r.item_code}>{r.item_name}</td>
                        <td className="py-1 text-ink-3">{r.item_group}</td>
                        <td className={`py-1 pl-3 text-right ${r.qty < 0 ? "text-bad" : "text-ink-2"}`}>{num(r.qty, 2)} <span className="text-ink-3">{r.uom}</span></td>
                        <td className={tdNum}>{pkr(r.rate, { decimals: true })}</td>
                        <td className={`py-1 pl-3 text-right font-medium ${r.amount < 0 ? "text-bad" : "text-ink"}`}>{pkr(r.amount)}</td>
                        <td className="py-1 text-ink-2">{r.warehouse}</td>
                        <td className="whitespace-nowrap py-1 text-ink-3">
                          {r.invoice}
                          {r.is_return && <span className="ml-1 rounded bg-warn/10 px-1 text-[10px] text-warn">return</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Every purchase invoice line in the range: which supplier delivered which item on which day, how much and at what rate. Filters narrow the export too.</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
