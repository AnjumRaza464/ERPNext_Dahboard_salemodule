"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type ExportFormat } from "@/lib/csv";
import { fmtDate, fmtPeriod, fmtRange, num, pkr } from "@/lib/format";
import type { CostingConsumption, CostingKpis, CostingPurchases, CostingStock, CostingTrend, Range } from "@/lib/types";
import Card from "../Card";
import DepartmentDetail from "../DepartmentDetail";
import ExportButtons from "../ExportButtons";
import TableFilter from "../TableFilter";
import FlowDetail from "../FlowDetail";
import ProducedVsSold from "../ProducedVsSold";
import ProductionDetail from "../ProductionDetail";
import StockAdjustments from "../StockAdjustments";
import StoreIssueDetail from "../StoreIssueDetail";
import DeltaText from "../DeltaText";
import KpiCard from "../KpiCard";
import DonutChart from "../charts/DonutChart";
import GroupedColumns from "../charts/GroupedColumns";
import HorizontalBars from "../charts/HorizontalBars";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

function ViewToggle<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex rounded-md border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)} className={`rounded px-2 py-0.5 text-[11px] font-medium ${value === o.id ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rows whose item name or code contains `query` (case-insensitive), and whose group matches when one is picked. */
function filterRows<T extends { item_name: string; item_code: string; item_group?: string }>(rows: T[], query: string, group = ""): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (!group || r.item_group === group) && (!q || r.item_name.toLowerCase().includes(q) || r.item_code.toLowerCase().includes(q)));
}

/** "+1.2 pts" / "−0.8 pts" for ratio changes measured in percentage points. */
function pts(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} pts`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86_400_000);
}

/** Headline tiles: what was bought, what production used, what it cost against sales, what came out. */
function CostingKpiRow({ kpis }: { kpis: ReturnType<typeof useApi<CostingKpis>> }) {
  const c = kpis.data?.current;
  const p = kpis.data?.previous;
  const d = kpis.data?.delta_pct;
  const dp = kpis.data?.delta_points;
  const prev = kpis.data ? fmtRange(kpis.data.previous_range.start, kpis.data.previous_range.end) : undefined;
  const common = { loading: kpis.loading, refreshing: kpis.refreshing, error: !!kpis.error };
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard label="Raw Material Purchased" value={pkr(c?.raw_purchases)} delta={d?.raw_purchases} invert sub={c ? `${num(c.purchase_invoices)} invoices · ${num(c.raw_purchase_items)} items · vs ${prev}` : undefined} {...common} />
      <KpiCard label="Material Consumed" value={pkr(c?.consumed)} delta={d?.consumed} invert sub={c ? `raw ${pkr(c.raw_consumed)} · packaging ${pkr(c.packaging_consumed)} · ${num(c.batches)} batches` : undefined} {...common} />
      <KpiCard
        label="Material Cost % of Sales"
        value={c?.material_cost_pct != null ? `${num(c.material_cost_pct, 1)}%` : "—"}
        sub={c ? (c.material_cost_pct != null ? `${pts(dp?.material_cost_pct)} vs ${p?.material_cost_pct != null ? num(p.material_cost_pct, 1) + "%" : "—"} · net sales ${pkr(c.net_sales)}` : "no sales in range") : undefined}
        {...common}
      />
      <KpiCard label="Finished Goods Produced" value={pkr(c?.produced_value)} delta={d?.produced_value} sub={c ? `${num(c.produced_qty)} qty · ${num(c.produced_items)} items · ${num(c.production_days)} production din` : undefined} {...common} />
    </div>
  );
}

/** Second row: stock cover, daily usage, output per rupee of material, and purchase vs usage gap. */
function CostingPaceRow({ kpis }: { kpis: ReturnType<typeof useApi<CostingKpis>> }) {
  const c = kpis.data?.current;
  const d = kpis.data?.delta_pct;
  const dp = kpis.data?.delta_points;
  const s = kpis.data?.stock;
  const common = { loading: kpis.loading, refreshing: kpis.refreshing, error: !!kpis.error };
  const gapNote = c ? (c.purchase_gap >= 0 ? "bought more than used · stock built up" : "used more than bought · drawn from stock") : undefined;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard label="Raw Material Stock" value={pkr(s?.raw_value)} sub={s ? `${num(s.raw_items)} items · ${s.raw_days_cover != null ? `${num(s.raw_days_cover, 0)} din cover at this range's usage` : "no usage in range"}` : undefined} {...common} />
      <KpiCard label="Avg Consumed / Production Day" value={pkr(c?.avg_consumed_per_production_day)} delta={d?.avg_consumed_per_production_day} invert sub={c ? `${num(c.production_days)} of ${num(c.calendar_days)} din had production` : undefined} {...common} />
      <KpiCard
        label="Output per PKR 100 Material"
        value={c?.yield_pct != null ? `PKR ${num(c.yield_pct, 0)}` : "—"}
        sub={c ? (c.yield_pct != null ? `${pts(dp?.yield_pct)} · finished goods value ÷ material consumed` : "no production in range") : undefined}
        {...common}
      />
      <KpiCard label="Purchased − Consumed (raw)" value={pkr(c?.purchase_gap, { sign: true })} sub={gapNote} {...common} />
    </div>
  );
}

/** One line about the data itself: when material was last bought and last used in production. */
function CostingHealthLine({ kpis }: { kpis: CostingKpis }) {
  const h = kpis.health;
  const c = kpis.current;
  const lag = h.last_production_date ? daysBetween(h.last_production_date, h.today) : null;
  const stale = lag !== null && lag >= 2;
  const parts: string[] = [];
  if (h.last_purchase_date) parts.push(`Last purchase ${fmtDate(h.last_purchase_date)}`);
  if (h.last_production_date) parts.push(`last production entry ${fmtDate(h.last_production_date)}`);
  parts.push(`${num(c.production_days)} of ${num(c.calendar_days)} din had production`);
  parts.push(`${num(c.purchase_days)} din had purchases`);
  parts.push(`${num(c.consumed_items)} materials used`);
  const ex = h.excluded;
  const exNote = ex && (ex.purchases || ex.consumed || ex.produced) ? `Left out as opening / conversion entries (${ex.items.join(", ")}): purchases ${pkr(ex.purchases)} · consumed ${pkr(ex.consumed)} · produced ${pkr(ex.produced)}` : null;
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] ${stale ? "text-warn" : "text-ink-3"}`} title="Data health: production entries (Repack) and purchase invoices are posted in ERPNext after the fact, so recent days can change">
      {stale && <span className="inline-flex items-center rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">{lag} din se production entry nahi</span>}
      <span className="tnum">{parts.join(" · ")}</span>
      {exNote && <span className="tnum basis-full text-ink-3">{exNote}</span>}
    </div>
  );
}

type TrendView = "purchases" | "output";
type StockGroup = "Raw Material" | "Packaging";

function coverTone(days: number | null): string {
  if (days === null) return "text-ink-3";
  if (days < 7) return "text-bad";
  if (days < 14) return "text-warn";
  return "text-ink-2";
}

/** Raw material / costing view: purchases, production consumption, output, stock on hand. */
export default function CostingTab({ range, refreshKey, onRetry }: Props) {
  const kpis = useApi<CostingKpis>("/api/costing/kpis", range, refreshKey);
  const trend = useApi<CostingTrend>("/api/costing/trend", range, refreshKey);
  const consumption = useApi<CostingConsumption>("/api/costing/consumption", range, refreshKey, { limit: 0 });
  const purchases = useApi<CostingPurchases>("/api/costing/purchases", range, refreshKey, { limit: 0 });
  const [stockGroup, setStockGroup] = useState<StockGroup>("Raw Material");
  const stock = useApi<CostingStock>("/api/costing/stock", range, refreshKey, { limit: 0, group: stockGroup });
  const [trendView, setTrendView] = useState<TrendView>("purchases");
  // Search / group filters on the three item tables; exports send out the filtered rows.
  const [consumedQuery, setConsumedQuery] = useState("");
  const [consumedGroup, setConsumedGroup] = useState("");
  const [purchaseQuery, setPurchaseQuery] = useState("");
  const [stockQuery, setStockQuery] = useState("");
  const consumedRows = filterRows(consumption.data?.items ?? [], consumedQuery, consumedGroup);
  const consumedGroups = Array.from(new Set((consumption.data?.items ?? []).map((r) => r.item_group))).sort();
  const purchaseRows = filterRows(purchases.data?.items ?? [], purchaseQuery);
  const stockRows = filterRows(stock.data?.items ?? [], stockQuery);

  const gran = trend.data?.granularity ?? "day";
  const trendRows = trend.data
    ? trend.data.points.map((p) => ({
        label: fmtPeriod(p.period, gran),
        current: trendView === "purchases" ? p.purchased : p.consumed,
        previous: trendView === "purchases" ? p.consumed : p.produced,
        batches: p.batches,
        purchased_all: p.purchased_all,
      }))
    : [];
  const trendNames: [string, string] = trendView === "purchases" ? ["Raw material purchased", "Material consumed"] : ["Material consumed", "Finished goods produced"];
  const trendEmpty = !!trend.data && trend.data.totals.purchased === 0 && trend.data.totals.consumed === 0 && trend.data.totals.produced === 0;

  const exportConsumed = (fmt: ExportFormat) => {
    if (!consumption.data) return;
    exportTable(fmt, `material-consumed-${range.start}-${range.end}`, consumedRows, [
        { key: "item_code", header: "Item code", value: (r) => r.item_code },
        { key: "item_name", header: "Item", value: (r) => r.item_name },
        { key: "item_group", header: "Group", value: (r) => r.item_group },
        { key: "qty", header: "Qty", value: (r) => r.qty },
        { key: "uom", header: "UOM", value: (r) => r.uom },
        { key: "rate", header: "Avg rate", value: (r) => r.rate },
        { key: "amount", header: "Amount", value: (r) => r.amount },
        { key: "share", header: "Share %", value: (r) => r.share_pct },
        { key: "prev", header: "Previous amount", value: (r) => r.prev_amount },
        { key: "delta", header: "Change %", value: (r) => r.delta_pct },
        { key: "entries", header: "Entries", value: (r) => r.entries },
      ]);
  };
  const exportPurchased = (fmt: ExportFormat) => {
    if (!purchases.data) return;
    exportTable(fmt, `raw-material-purchases-${range.start}-${range.end}`, purchaseRows, [
        { key: "item_code", header: "Item code", value: (r) => r.item_code },
        { key: "item_name", header: "Item", value: (r) => r.item_name },
        { key: "qty", header: "Qty", value: (r) => r.qty },
        { key: "uom", header: "UOM", value: (r) => r.uom },
        { key: "rate", header: "Avg rate", value: (r) => r.rate },
        { key: "last_rate", header: "Last rate", value: (r) => r.last_rate },
        { key: "last_date", header: "Last bought", value: (r) => r.last_date },
        { key: "prev_rate", header: "Previous period rate", value: (r) => r.prev_rate },
        { key: "rate_change", header: "Rate change %", value: (r) => r.rate_change_pct },
        { key: "amount", header: "Amount", value: (r) => r.amount },
        { key: "share", header: "Share %", value: (r) => r.share_pct },
        { key: "invoices", header: "Invoices", value: (r) => r.invoices },
      ]);
  };
  const exportStock = (fmt: ExportFormat) => {
    if (!stock.data) return;
    exportTable(fmt, `${stockGroup.toLowerCase().replace(" ", "-")}-stock-${stock.data.as_of}`, stockRows, [
        { key: "item_code", header: "Item code", value: (r) => r.item_code },
        { key: "item_name", header: "Item", value: (r) => r.item_name },
        { key: "qty", header: "Qty", value: (r) => r.qty },
        { key: "uom", header: "UOM", value: (r) => r.uom },
        { key: "rate", header: "Valuation rate", value: (r) => r.valuation_rate },
        { key: "value", header: "Value", value: (r) => r.value },
        { key: "share", header: "Share %", value: (r) => r.share_pct },
        { key: "used", header: "Used in range", value: (r) => r.used_qty },
        { key: "daily", header: "Daily use", value: (r) => r.daily_use },
        { key: "cover", header: "Days cover", value: (r) => r.days_cover },
      ]);
  };

  return (
    <div className="flex flex-col gap-4">
      <CostingKpiRow kpis={kpis} />
      {kpis.data && <CostingHealthLine kpis={kpis.data} />}
      <CostingPaceRow kpis={kpis} />

      <Card
        title="Purchases, Consumption & Output"
        subtitle={trend.data ? `${gran === "month" ? "Per month" : "Per day"} · raw material bought ${pkr(trend.data.totals.purchased)} · consumed ${pkr(trend.data.totals.consumed)} · finished goods ${pkr(trend.data.totals.produced)}` : undefined}
        source={trend.data?.source}
        loading={trend.loading}
        refreshing={trend.refreshing}
        error={trend.error}
        empty={trendEmpty}
        emptyHint="No purchase invoices or production entries in this range."
        onRetry={onRetry}
        action={<ViewToggle value={trendView} options={[{ id: "purchases", label: "Bought vs used" }, { id: "output", label: "Used vs produced" }]} onChange={setTrendView} />}
      >
        {trend.data && (
          <GroupedColumns
            rows={trendRows}
            names={trendNames}
            format={(v) => pkr(v)}
            labelFormat={(label, e) => `${label}${e?.payload?.batches ? ` · ${num(Number(e.payload.batches))} production entr${Number(e.payload.batches) === 1 ? "y" : "ies"}` : ""}`}
          />
        )}
      </Card>

      <FlowDetail range={range} refreshKey={refreshKey} onRetry={onRetry} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Consumption by Department"
          subtitle={consumption.data ? `${pkr(consumption.data.total)} of material used across ${consumption.data.by_department.length} department${consumption.data.by_department.length === 1 ? "" : "s"}` : undefined}
          source={consumption.data?.source}
          loading={consumption.loading}
          refreshing={consumption.refreshing}
          error={consumption.error}
          empty={!!consumption.data && consumption.data.by_department.length === 0}
          emptyHint="No production (Repack) entries in this range."
          onRetry={onRetry}
          height={200}
        >
          {consumption.data && (
            <DonutChart
              rows={consumption.data.by_department.map((d) => ({ label: d.department, value: d.amount, note: `${num(d.entries)} entries · ${num(d.items)} items` }))}
              total={consumption.data.total}
              centerLabel="Used"
            />
          )}
        </Card>

        <Card
          title="Purchases by Supplier"
          subtitle={purchases.data ? `${num(purchases.data.invoices)} invoices · ${pkr(purchases.data.total)} across all item groups` : undefined}
          source={purchases.data?.source}
          loading={purchases.loading}
          refreshing={purchases.refreshing}
          error={purchases.error}
          empty={!!purchases.data && purchases.data.by_supplier.length === 0}
          emptyHint="No purchase invoices in this range."
          onRetry={onRetry}
          height={200}
        >
          {purchases.data && (
            <HorizontalBars
              rows={purchases.data.by_supplier.map((s) => ({ label: s.supplier, value: s.amount, invoices: s.invoices, share: s.share_pct }))}
              format={(v, e) => `${pkr(v)} · ${num(Number(e.payload?.invoices))} invoices · ${e.payload?.share}%`}
              seriesName="Purchases"
              height={Math.max(160, purchases.data.by_supplier.length * 28 + 24)}
              labelWidth={160}
            />
          )}
        </Card>

        <Card
          title="Purchases by Item Group"
          subtitle={purchases.data ? `Raw material is ${purchases.data.total ? num((purchases.data.raw_total / purchases.data.total) * 100, 1) : 0}% of what was bought` : undefined}
          source={purchases.data?.source}
          loading={purchases.loading}
          refreshing={purchases.refreshing}
          error={purchases.error}
          empty={!!purchases.data && purchases.data.by_group.length === 0}
          onRetry={onRetry}
          height={200}
        >
          {purchases.data && (
            <DonutChart rows={purchases.data.by_group.map((g) => ({ label: g.item_group, value: g.amount, note: `${num(g.items)} items` }))} total={purchases.data.total} centerLabel="Bought" />
          )}
        </Card>

        <Card
          title="Finished Goods Produced"
          subtitle={consumption.data ? `Top ${consumption.data.produced.length} of ${num(consumption.data.produced_distinct_items)} items · ${pkr(consumption.data.produced_total)} booked into Finished Goods` : undefined}
          source={consumption.data?.source}
          loading={consumption.loading}
          refreshing={consumption.refreshing}
          error={consumption.error}
          empty={!!consumption.data && consumption.data.produced.length === 0}
          onRetry={onRetry}
          height={200}
        >
          {consumption.data && (
            <HorizontalBars
              rows={consumption.data.produced.slice(0, 10).map((i) => ({ label: i.item_name, value: i.amount, qty: i.qty, uom: i.uom, share: i.share_pct }))}
              format={(v, e) => `${pkr(v)} · ${num(Number(e.payload?.qty), 1)} ${e.payload?.uom} · ${e.payload?.share}%`}
              seriesName="Produced"
              color="var(--series-3)"
              height={Math.max(160, Math.min(10, consumption.data.produced.length) * 28 + 24)}
              labelWidth={170}
            />
          )}
        </Card>
      </div>

      <StoreIssueDetail range={range} refreshKey={refreshKey} onRetry={onRetry} />

      <DepartmentDetail range={range} refreshKey={refreshKey} onRetry={onRetry} />

      <ProductionDetail range={range} refreshKey={refreshKey} onRetry={onRetry} />

      <ProducedVsSold range={range} refreshKey={refreshKey} onRetry={onRetry} />

      <Card
        title="Top Consumed Materials"
        subtitle={consumption.data ? `All ${num(consumption.data.distinct_items)} materials by value used · ${pkr(consumption.data.total)} total · change vs ${fmtRange(consumption.data.previous_range.start, consumption.data.previous_range.end)}` : undefined}
        source={consumption.data?.source}
        loading={consumption.loading}
        refreshing={consumption.refreshing}
        error={consumption.error}
        empty={!!consumption.data && consumption.data.items.length === 0}
        emptyHint="No production (Repack) entries in this range."
        onRetry={onRetry}
        height={200}
        action={consumption.data && consumption.data.items.length > 0 ? <ExportButtons onExport={exportConsumed} /> : undefined}
      >
        {consumption.data && (
          <div className="flex flex-col gap-2">
            <TableFilter query={consumedQuery} onQuery={setConsumedQuery} group={consumedGroup} onGroup={setConsumedGroup} groups={consumedGroups} shown={consumedRows.length} total={consumption.data.items.length} />
            <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className={thead}>
                  <th className={th}>Item</th>
                  <th className={th}>Group</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Avg rate</th>
                  <th className={`${th} text-right`}>Amount</th>
                  <th className={`${th} text-right`}>Share</th>
                  <th className={`${th} text-right`}>vs prev</th>
                  <th className={`${th} text-right`}>Rate chg</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {consumedRows.map((r) => (
                  <tr key={r.item_code} className="border-b border-line/60">
                    <td className="py-1.5 text-ink" title={`${r.item_code} · used in ${num(r.entries)} entries`}>{r.item_name}</td>
                    <td className="py-1.5 text-ink-3">{r.item_group}</td>
                    <td className={tdNum}>{num(r.qty, 2)} <span className="text-ink-3">{r.uom}</span></td>
                    <td className={tdNum}>{pkr(r.rate, { decimals: true })}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                    <td className={tdNum}>{r.share_pct}%</td>
                    <td className="py-1.5 text-right"><DeltaText value={r.delta_pct} invert /></td>
                    <td className="py-1.5 text-right" title={r.prev_rate != null ? `previous period avg rate ${pkr(r.prev_rate, { decimals: true })}` : "not used in the previous period"}><DeltaText value={r.rate_change_pct} invert /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Raw Material Price Watch"
        subtitle={purchases.data ? `All ${num(purchases.data.distinct_items)} raw materials bought · ${pkr(purchases.data.raw_total)} total · rates vs ${fmtRange(purchases.data.previous_range.start, purchases.data.previous_range.end)}` : undefined}
        source={purchases.data?.source}
        loading={purchases.loading}
        refreshing={purchases.refreshing}
        error={purchases.error}
        empty={!!purchases.data && purchases.data.items.length === 0}
        emptyHint="No raw material purchase invoices in this range."
        onRetry={onRetry}
        height={200}
        action={purchases.data && purchases.data.items.length > 0 ? <ExportButtons onExport={exportPurchased} /> : undefined}
      >
        {purchases.data && (
          <div className="flex flex-col gap-2">
            <TableFilter query={purchaseQuery} onQuery={setPurchaseQuery} shown={purchaseRows.length} total={purchases.data.items.length} />
            <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className={thead}>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Avg rate</th>
                  <th className={`${th} text-right`}>Last rate</th>
                  <th className={`${th} text-right`}>Prev period</th>
                  <th className={`${th} text-right`}>Rate chg</th>
                  <th className={`${th} text-right`}>Amount</th>
                  <th className={`${th} text-right`}>Share</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {purchaseRows.map((r) => (
                  <tr key={r.item_code} className="border-b border-line/60">
                    <td className="py-1.5 text-ink" title={`${r.item_code} · ${num(r.invoices)} invoices`}>{r.item_name}</td>
                    <td className={tdNum}>{num(r.qty, 2)} <span className="text-ink-3">{r.uom}</span></td>
                    <td className={tdNum}>{pkr(r.rate, { decimals: true })}</td>
                    <td className={tdNum} title={r.last_date ? `bought ${fmtDate(r.last_date)}` : undefined}>
                      {pkr(r.last_rate, { decimals: true })}
                      {r.last_date && <span className="ml-1 text-[10px] text-ink-3">· {fmtDate(r.last_date).slice(0, 6)}</span>}
                    </td>
                    <td className={tdNum}>{r.prev_rate != null ? pkr(r.prev_rate, { decimals: true }) : <span className="text-ink-3">—</span>}</td>
                    <td className="py-1.5 text-right"><DeltaText value={r.rate_change_pct} invert /></td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                    <td className={tdNum}>{r.share_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </Card>

      <Card
        title={`${stockGroup} Stock on Hand`}
        subtitle={
          stock.data
            ? `As of ${fmtDate(stock.data.as_of)} · ${pkr(stock.data.total_value)} in ${num(stock.data.distinct_items)} items · ${stock.data.by_warehouse.map((w) => `${w.warehouse} ${pkr(w.value)}`).join(" · ")} · days cover at this range's usage`
            : undefined
        }
        source={stock.data?.source}
        loading={stock.loading}
        refreshing={stock.refreshing}
        error={stock.error}
        empty={!!stock.data && stock.data.items.length === 0}
        emptyHint="No stock in this item group."
        onRetry={onRetry}
        height={200}
        action={
          <div className="flex items-center gap-2">
            <ViewToggle value={stockGroup} options={[{ id: "Raw Material", label: "Raw Material" }, { id: "Packaging", label: "Packaging" }]} onChange={setStockGroup} />
            {stock.data && stock.data.items.length > 0 && <ExportButtons onExport={exportStock} />}
          </div>
        }
      >
        {stock.data && (
          <div className="flex flex-col gap-2">
            <TableFilter query={stockQuery} onQuery={setStockQuery} shown={stockRows.length} total={stock.data.items.length} />
            <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className={thead}>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Valuation rate</th>
                  <th className={`${th} text-right`}>Value</th>
                  <th className={`${th} text-right`}>Share</th>
                  <th className={`${th} text-right`}>Used in range</th>
                  <th className={`${th} text-right`}>Days cover</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {stockRows.map((r) => (
                  <tr key={r.item_code} className="border-b border-line/60">
                    <td className="py-1.5 text-ink" title={`${r.item_code}${r.warehouses > 1 ? ` · in ${r.warehouses} warehouses` : ""}`}>{r.item_name}</td>
                    <td className={tdNum}>{num(r.qty, 2)} <span className="text-ink-3">{r.uom}</span></td>
                    <td className={tdNum}>{pkr(r.valuation_rate, { decimals: true })}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(r.value)}</td>
                    <td className={tdNum}>{r.share_pct}%</td>
                    <td className={tdNum}>{r.used_qty ? `${num(r.used_qty, 2)} ${r.uom}` : <span className="text-ink-3">not used</span>}</td>
                    <td className={`py-1.5 text-right font-medium ${coverTone(r.days_cover)}`} title={r.daily_use ? `${num(r.daily_use, 3)} ${r.uom} per day` : undefined}>
                      {r.days_cover === null ? "—" : r.days_cover > 365 ? "> 1 year" : `${num(r.days_cover, 0)} din`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stock.data.other_value > 0 && <p className="mt-2 text-[11px] text-ink-3">{pkr(stock.data.other_value)} more in {num(stock.data.distinct_items - stock.data.items.length)} smaller items.</p>}
            </div>
          </div>
        )}
      </Card>

      <StockAdjustments range={range} refreshKey={refreshKey} onRetry={onRetry} />

      <p className="px-1 text-[11px] text-ink-3">
        Purchases come from submitted Purchase Invoices. Consumption and output come from production Stock Entries (Repack): materials issued out of a department are
        counted as consumed, finished goods booked in are counted as produced. Values are ERPNext valuation amounts, not sale prices.
      </p>
    </div>
  );
}
