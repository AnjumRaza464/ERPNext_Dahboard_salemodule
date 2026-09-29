"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { fmtDate, fmtRange, num, pct, pkr } from "@/lib/format";
import type {
  HourlySales, InvoiceDistribution, InvoicesResponse, ItemGroupSales, ItemPareto, MonthlySales, OutletSales, PaymentModes, Range, RunRate,
  SalesComposition, SalesHeatmap, SalesKpis, SalesTrend, TopCustomers, TopItems, WeekdaySales,
} from "@/lib/types";
import Card from "../Card";
import InvoicesTable from "../InvoicesTable";
import KpiCard from "../KpiCard";
import SalesComparison from "../SalesComparison";
import { sectionId, type CompareCommand } from "@/lib/voice";
import ColumnChart from "../charts/ColumnChart";
import DonutChart from "../charts/DonutChart";
import HeatmapGrid from "../charts/HeatmapGrid";
import HorizontalBars from "../charts/HorizontalBars";
import ParetoChart from "../charts/ParetoChart";
import SalesTrendChart from "../charts/SalesTrendChart";
import WaterfallChart from "../charts/WaterfallChart";

export function SalesKpiRow({ kpis }: { kpis: ReturnType<typeof useApi<SalesKpis>> }) {
  const c = kpis.data?.current;
  const d = kpis.data?.delta_pct;
  const prev = kpis.data ? fmtRange(kpis.data.previous_range.start, kpis.data.previous_range.end) : undefined;
  const common = { loading: kpis.loading, refreshing: kpis.refreshing, error: !!kpis.error };
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <KpiCard label="Total Sales" value={pkr(c?.total_sales)} delta={d?.total_sales} sub={prev && `vs ${prev}`} {...common} />
      <KpiCard label="Invoice Count" value={num(c?.invoice_count)} delta={d?.invoice_count} sub={c && c.return_count ? `${c.return_count} returns` : undefined} {...common} />
      <KpiCard label="Avg Invoice Value" value={pkr(c?.avg_invoice_value)} delta={d?.avg_invoice_value} {...common} />
      <KpiCard label="Qty Sold" value={num(c?.total_qty)} delta={d?.total_qty} sub={c && c.invoice_count ? `${num(c.total_qty / c.invoice_count, 1)} per invoice` : undefined} {...common} />
      <KpiCard label="Outstanding" value={pkr(c?.outstanding)} delta={d?.outstanding} invert sub={c ? "on invoices in range" : undefined} {...common} />
    </div>
  );
}

/** Daily pace tiles: how fast sales are coming in and where the month is heading. */
export function SalesPaceRow({ pace }: { pace: ReturnType<typeof useApi<RunRate>> }) {
  const r = pace.data;
  const m = r?.month;
  const common = { loading: pace.loading, refreshing: pace.refreshing, error: !!pace.error };
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard label="Avg per Active Day" value={pkr(r?.avg_per_active_day)} sub={r ? `${num(r.active_days)} of ${num(r.calendar_days)} days had sales · ${pkr(r.avg_per_day)} per calendar day` : undefined} {...common} />
      <KpiCard label="Best Day" value={pkr(r?.best_day?.total)} sub={r?.best_day ? `${fmtDate(r.best_day.date)} · ${num(r.best_day.invoice_count)} invoices` : r ? "no sales in range" : undefined} {...common} />
      <KpiCard label="Lowest Day" value={pkr(r?.worst_day?.total)} sub={r?.worst_day ? `${fmtDate(r.worst_day.date)} · ${num(r.worst_day.invoice_count)} invoices` : r ? "no sales in range" : undefined} {...common} />
      <KpiCard
        label={m ? (m.is_complete ? `${m.label} Total` : `Projected ${m.label}`) : "Projected Month"}
        value={pkr(m?.is_complete ? m.mtd : m?.projected)}
        sub={m ? (m.is_complete ? `${num(m.active_days)} active days · ${pkr(m.avg_per_day)} per day` : `${pkr(m.mtd)} so far · ${num(m.remaining_days)} days left at ${pkr(m.avg_per_day)}/day`) : undefined}
        {...common}
      />
    </div>
  );
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";

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

export function SalesCharts({ range, refreshKey, onRetry }: { range: Range; refreshKey: number; onRetry: () => void }) {
  const trend = useApi<SalesTrend>("/api/sales/trend", range, refreshKey);
  const monthly = useApi<MonthlySales>("/api/sales/monthly", range, refreshKey, { months: 12 });
  const items = useApi<TopItems>("/api/sales/top-items", range, refreshKey, { limit: 10 });
  const pareto = useApi<ItemPareto>("/api/sales/item-pareto", range, refreshKey, { limit: 30 });
  const outlets = useApi<OutletSales>("/api/sales/by-outlet", range, refreshKey);
  const groups = useApi<ItemGroupSales>("/api/sales/by-item-group", range, refreshKey);
  const modes = useApi<PaymentModes>("/api/sales/payment-modes", range, refreshKey);
  const hours = useApi<HourlySales>("/api/sales/by-hour", range, refreshKey);
  const weekdays = useApi<WeekdaySales>("/api/sales/by-weekday", range, refreshKey);
  const heat = useApi<SalesHeatmap>("/api/sales/heatmap", range, refreshKey);
  const dist = useApi<InvoiceDistribution>("/api/sales/invoice-distribution", range, refreshKey);
  const composition = useApi<SalesComposition>("/api/sales/composition", range, refreshKey);
  const customers = useApi<TopCustomers>("/api/sales/top-customers", range, refreshKey, { limit: 10 });
  const [itemsView, setItemsView] = useState<"bars" | "donut">("bars");

  const monthRows = monthly.data ? monthly.data.points.map((p) => ({ ...p, value: p.total })) : [];
  const bestMonth = monthly.data?.points.find((p) => p.period === monthly.data?.best_month);

  return (
    <>
      <Card
        title="Sales Trend"
        id={sectionId("trend")}
        subtitle={trend.data ? (trend.data.granularity === "day" ? "Daily invoiced sales (PKR)" : "Monthly invoiced sales (PKR)") : undefined}
        source={trend.data?.source}
        loading={trend.loading}
        refreshing={trend.refreshing}
        error={trend.error}
        empty={!!trend.data && trend.data.points.every((p) => p.total === 0)}
        onRetry={onRetry}
        className="lg:col-span-2"
      >
        {trend.data && <SalesTrendChart data={trend.data} />}
      </Card>

      <Card
        title="Monthly Sales History"
        id={sectionId("monthly")}
        subtitle={
          monthly.data
            ? `Last ${monthly.data.months} months to ${fmtDate(range.end)} · avg full month ${pkr(monthly.data.avg_month)}${bestMonth ? ` · best ${bestMonth.label} ${pkr(bestMonth.total)}` : ""}`
            : undefined
        }
        source={monthly.data?.source}
        loading={monthly.loading}
        refreshing={monthly.refreshing}
        error={monthly.error}
        empty={!!monthly.data && monthly.data.total === 0}
        onRetry={onRetry}
        className="lg:col-span-2"
      >
        {monthly.data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <ColumnChart
                rows={monthRows}
                colors={monthRows.map((p) => (p.is_partial ? "var(--ord-2)" : "var(--series-1)"))}
                format={(v, e) => `${pkr(v)} · ${num(Number(e.payload?.invoice_count))} inv · MoM ${pct(e.payload?.mom_pct as number | null)}${e.payload?.is_partial ? " · month in progress" : ""}`}
                seriesName="Sales"
              />
            </div>
            <table className="w-full self-start text-xs lg:col-span-2">
              <thead>
                <tr className={thead}>
                  <th className={th}>Month</th>
                  <th className={`${th} text-right`}>Sales</th>
                  <th className={`${th} text-right`}>Inv</th>
                  <th className={`${th} text-right`}>Avg/day</th>
                  <th className={`${th} text-right`}>MoM</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {monthly.data.points.slice(-6).reverse().map((p) => (
                  <tr key={p.period} className="border-b border-line/60">
                    <td className="py-1.5 text-ink">
                      {p.label}
                      {p.is_partial && <span className="ml-1 text-[10px] text-ink-3">(to date)</span>}
                    </td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(p.total)}</td>
                    <td className="py-1.5 text-right text-ink-2">{num(p.invoice_count)}</td>
                    <td className="py-1.5 text-right text-ink-2">{pkr(p.avg_per_day)}</td>
                    <td className={`py-1.5 text-right ${p.mom_pct === null ? "text-ink-3" : p.mom_pct >= 0 ? "text-good" : "text-bad"}`}>{pct(p.mom_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Sales by Item Group"
        id={sectionId("item_groups")}
        subtitle={groups.data ? `${groups.data.groups.length} groups · ${pkr(groups.data.total_amount)} total` : undefined}
        source={groups.data?.source}
        loading={groups.loading}
        refreshing={groups.refreshing}
        error={groups.error}
        empty={!!groups.data && groups.data.groups.length === 0}
        onRetry={onRetry}
        height={200}
      >
        {groups.data && (
          <DonutChart
            rows={groups.data.groups.map((g) => ({ label: g.item_group, value: g.amount, note: `${num(g.items)} items · ${num(g.qty)} qty` }))}
            total={groups.data.total_amount}
            centerLabel="Sales"
          />
        )}
      </Card>

      <Card
        title="Payment Modes"
        id={sectionId("payment_modes")}
        subtitle={modes.data ? `How ${pkr(modes.data.total)} of invoiced sales was settled` : undefined}
        source={modes.data?.source}
        loading={modes.loading}
        refreshing={modes.refreshing}
        error={modes.error}
        empty={!!modes.data && modes.data.modes.length === 0}
        onRetry={onRetry}
        height={200}
      >
        {modes.data && <DonutChart rows={modes.data.modes.map((m) => ({ label: m.mode, value: m.amount, note: `${num(m.count)} inv` }))} total={modes.data.total} centerLabel="Settled" />}
      </Card>

      <Card
        title="Top Items"
        id={sectionId("top_items")}
        subtitle={items.data ? `Top ${items.data.items.length} of ${items.data.distinct_items} items by sales value` : undefined}
        source={items.data?.source}
        loading={items.loading}
        refreshing={items.refreshing}
        error={items.error}
        empty={!!items.data && items.data.items.length === 0}
        onRetry={onRetry}
        action={<ViewToggle value={itemsView} options={[{ id: "bars", label: "Bars" }, { id: "donut", label: "Share" }]} onChange={setItemsView} />}
      >
        {items.data &&
          (itemsView === "bars" ? (
            <HorizontalBars
              rows={items.data.items.map((i) => ({ label: i.item_name, value: i.amount, qty: i.qty, share: i.share_pct }))}
              format={(v, e) => `${pkr(v)} · ${num(Number(e.payload?.qty), 2)} qty · ${e.payload?.share}%`}
              seriesName="Sales"
            />
          ) : (
            <DonutChart
              rows={[
                ...items.data.items.slice(0, 5).map((i) => ({ label: i.item_name, value: i.amount, note: `${num(i.qty)} qty` })),
                { label: "All other items", value: items.data.total_amount - items.data.items.slice(0, 5).reduce((s, i) => s + i.amount, 0), note: `${num(items.data.distinct_items - 5)} items`, other: true },
              ]}
              total={items.data.total_amount}
              centerLabel="Sales"
              size={210}
            />
          ))}
      </Card>

      <Card
        title="Item Concentration (Pareto / ABC)"
        id={sectionId("pareto")}
        subtitle={
          pareto.data
            ? `${num(pareto.data.items_for_80_pct)} of ${num(pareto.data.distinct_items)} items make 80% of sales · showing top ${pareto.data.items.length} by share`
            : undefined
        }
        source={pareto.data?.source}
        loading={pareto.loading}
        refreshing={pareto.refreshing}
        error={pareto.error}
        empty={!!pareto.data && pareto.data.items.length === 0}
        onRetry={onRetry}
      >
        {pareto.data && <ParetoChart data={pareto.data} />}
      </Card>

      <Card
        title="Outlet-wise Sales"
        id={sectionId("outlets")}
        subtitle={outlets.data ? `${outlets.data.outlets.length} outlet${outlets.data.outlets.length === 1 ? "" : "s"} · ${pkr(outlets.data.total)} total` : undefined}
        source={outlets.data?.source}
        loading={outlets.loading}
        refreshing={outlets.refreshing}
        error={outlets.error}
        empty={!!outlets.data && outlets.data.outlets.length === 0}
        onRetry={onRetry}
      >
        {outlets.data && (
          <div className="flex h-full flex-col gap-3">
            <HorizontalBars
              rows={outlets.data.outlets.map((o) => ({ label: o.outlet, value: o.total, count: o.invoice_count, share: o.share_pct }))}
              format={(v, e) => `${pkr(v)} · ${e.payload?.count} inv · ${e.payload?.share}%`}
              height={Math.max(120, outlets.data.outlets.length * 36 + 30)}
              seriesName="Sales"
            />
            <table className="w-full text-xs">
              <thead>
                <tr className={thead}>
                  <th className={th}>Outlet</th>
                  <th className={`${th} text-right`}>Invoices</th>
                  <th className={`${th} text-right`}>Avg Invoice</th>
                  <th className={`${th} text-right`}>Sales</th>
                  <th className={`${th} text-right`}>Share</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {outlets.data.outlets.map((o) => (
                  <tr key={o.outlet + (o.pos_profile ?? "")} className="border-b border-line/60">
                    <td className="py-1.5 text-ink" title={o.pos_profile ?? undefined}>{o.outlet}</td>
                    <td className="py-1.5 text-right text-ink-2">{num(o.invoice_count)}</td>
                    <td className="py-1.5 text-right text-ink-2">{pkr(o.avg_invoice_value)}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(o.total)}</td>
                    <td className="py-1.5 text-right text-ink-2">{o.share_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Sales Composition"
        id={sectionId("composition")}
        subtitle={composition.data ? `Gross to net · ${num(composition.data.invoice_count)} invoices · discounts ${composition.data.discount_pct}% of gross${composition.data.return_count ? ` · ${composition.data.return_count} returns` : ""}` : undefined}
        source={composition.data?.source}
        loading={composition.loading}
        refreshing={composition.refreshing}
        error={composition.error}
        empty={!!composition.data && composition.data.gross === 0}
        onRetry={onRetry}
      >
        {composition.data && <WaterfallChart steps={composition.data.steps} />}
      </Card>

      <Card
        title="Weekday × Hour Heatmap"
        id={sectionId("heatmap")}
        subtitle={heat.data ? `Average sales per day for each weekday and hour${heat.data.peak ? ` · peak ${heat.data.peak.weekday} ${String(heat.data.peak.hour).padStart(2, "0")}:00 (${pkr(heat.data.peak.avg_per_day)}/day)` : ""}` : undefined}
        source={heat.data?.source}
        loading={heat.loading}
        refreshing={heat.refreshing}
        error={heat.error}
        empty={!!heat.data && heat.data.max_avg === 0}
        onRetry={onRetry}
        className="lg:col-span-2"
        height={240}
      >
        {heat.data && <HeatmapGrid data={heat.data} />}
      </Card>

      <Card
        title="Sales by Hour of Day"
        id={sectionId("by_hour")}
        subtitle={hours.data ? `Total sales per hour across ${num(hours.data.active_days)} trading days${hours.data.peak_hour !== null ? ` · peak ${String(hours.data.peak_hour).padStart(2, "0")}:00` : ""}` : undefined}
        source={hours.data?.source}
        loading={hours.loading}
        refreshing={hours.refreshing}
        error={hours.error}
        empty={!!hours.data && hours.data.points.every((p) => p.total === 0)}
        onRetry={onRetry}
      >
        {hours.data && (
          <ColumnChart
            rows={hours.data.points.map((p) => ({ label: p.label, value: p.total, count: p.invoice_count, avg: p.avg_per_day, hour: p.hour }))}
            format={(v, e) => `${pkr(v)} · ${e.payload?.count} inv · ${pkr(Number(e.payload?.avg))}/day`}
            seriesName="Sales"
            tickEvery={3}
            highlight={(r) => r.hour === hours.data!.peak_hour}
          />
        )}
      </Card>

      <Card
        title="Sales by Weekday"
        id={sectionId("by_weekday")}
        subtitle={weekdays.data ? `Average sales per day of the week${weekdays.data.best_weekday ? ` · best ${weekdays.data.best_weekday}` : ""}` : undefined}
        source={weekdays.data?.source}
        loading={weekdays.loading}
        refreshing={weekdays.refreshing}
        error={weekdays.error}
        empty={!!weekdays.data && weekdays.data.points.every((p) => p.total === 0)}
        onRetry={onRetry}
      >
        {weekdays.data && (
          <ColumnChart
            rows={weekdays.data.points.map((p) => ({ label: p.weekday, value: p.avg_per_day, total: p.total, count: p.invoice_count, occ: p.occurrences }))}
            format={(v, e) => `${pkr(v)}/day · ${pkr(Number(e.payload?.total))} over ${e.payload?.occ} days · ${e.payload?.count} inv`}
            seriesName="Avg / day"
            highlight={(r) => r.label === weekdays.data!.best_weekday}
          />
        )}
      </Card>

      <Card
        title="Invoice Value Distribution"
        id={sectionId("distribution")}
        subtitle={dist.data ? `${num(dist.data.stats.count)} invoices · median ${pkr(dist.data.stats.median)} · 90% under ${pkr(dist.data.stats.p90)} · max ${pkr(dist.data.stats.max)}` : undefined}
        source={dist.data?.source}
        loading={dist.loading}
        refreshing={dist.refreshing}
        error={dist.error}
        empty={!!dist.data && dist.data.stats.count === 0}
        onRetry={onRetry}
      >
        {dist.data && (
          <ColumnChart
            rows={dist.data.buckets.map((b) => ({ label: b.bucket, value: b.invoice_count, total: b.total }))}
            format={(v, e) => `${num(v)} invoices · ${pkr(Number(e.payload?.total))}`}
            seriesName="Invoices"
            ordinal
            yFormat={(v) => num(v)}
          />
        )}
      </Card>

      <Card
        title="Top Customers"
        id={sectionId("customers")}
        subtitle={customers.data ? `Top ${customers.data.customers.length} of ${num(customers.data.distinct_customers)} customers by sales value` : undefined}
        source={customers.data?.source}
        loading={customers.loading}
        refreshing={customers.refreshing}
        error={customers.error}
        empty={!!customers.data && customers.data.customers.length === 0}
        onRetry={onRetry}
        className="lg:col-span-2"
      >
        {customers.data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <HorizontalBars
              rows={customers.data.customers.map((c) => ({ label: c.customer_name, value: c.total, count: c.invoice_count, share: c.share_pct }))}
              format={(v, e) => `${pkr(v)} · ${e.payload?.count} inv · ${e.payload?.share}%`}
              seriesName="Sales"
              height={Math.max(160, customers.data.customers.length * 30 + 24)}
            />
            <table className="w-full self-start text-xs">
              <thead>
                <tr className={thead}>
                  <th className={th}>Customer</th>
                  <th className={`${th} text-right`}>Invoices</th>
                  <th className={`${th} text-right`}>Avg Invoice</th>
                  <th className={`${th} text-right`}>Sales</th>
                  <th className={`${th} text-right`}>Outstanding</th>
                  <th className={`${th} text-right`}>Last</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {customers.data.customers.map((c) => (
                  <tr key={c.customer} className="border-b border-line/60">
                    <td className="py-1.5 text-ink">{c.customer_name}</td>
                    <td className="py-1.5 text-right text-ink-2">{num(c.invoice_count)}</td>
                    <td className="py-1.5 text-right text-ink-2">{pkr(c.avg_invoice_value)}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(c.total)}</td>
                    <td className={`py-1.5 text-right ${c.outstanding > 0 ? "text-warn" : "text-ink-2"}`}>{pkr(c.outstanding)}</td>
                    <td className="py-1.5 text-right text-ink-2">{fmtDate(c.last_invoice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export function SectionHeading({ title, hint, id }: { title: string; hint: string; id?: string }) {
  return (
    <div id={id} className="mt-1 flex scroll-mt-4 items-baseline gap-2">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <span className="text-xs text-ink-3">{hint}</span>
    </div>
  );
}

export default function SalesTab({ range, refreshKey, onRetry, compareCommand }: { range: Range; refreshKey: number; onRetry: () => void; compareCommand?: CompareCommand }) {
  const kpis = useApi<SalesKpis>("/api/sales/kpis", range, refreshKey);
  const pace = useApi<RunRate>("/api/sales/run-rate", range, refreshKey);
  const invoices = useApi<InvoicesResponse>("/api/sales/invoices", range, refreshKey);
  return (
    <div className="flex flex-col gap-4">
      <div id={sectionId("kpis")} className="scroll-mt-24">
        <SalesKpiRow kpis={kpis} />
      </div>
      <div id={sectionId("pace")} className="scroll-mt-4">
        <SalesPaceRow pace={pace} />
      </div>
      <SectionHeading id={sectionId("comparison")} title="Comparison" hint="how this range stacks up against another period" />
      <SalesComparison range={range} refreshKey={refreshKey} onRetry={onRetry} command={compareCommand} />
      <SectionHeading title="Trends, Mix & Patterns" hint="what sells, when, and how it is paid for" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SalesCharts range={range} refreshKey={refreshKey} onRetry={onRetry} />
      </div>
      <div id={sectionId("invoices")} className="scroll-mt-4">
        <InvoicesTable state={invoices} range={range} onRetry={onRetry} />
      </div>
    </div>
  );
}
