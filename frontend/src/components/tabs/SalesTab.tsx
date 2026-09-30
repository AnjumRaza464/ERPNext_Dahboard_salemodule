"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { toIso } from "@/lib/dates";
import { fmtDate, fmtRange, num, pct, pkr } from "@/lib/format";
import type {
  CompareMode, InvoicesResponse, ItemGroupSales, MonthlySales, OutletSales, PaymentModes, Range, RunRate, SalesKpis, TopCustomers, TopItems,
} from "@/lib/types";
import Card from "../Card";
import DeltaText from "../DeltaText";
import GuardrailLine from "../GuardrailLine";
import InvoicesTable from "../InvoicesTable";
import KpiCard from "../KpiCard";
import LiveCompare from "../LiveCompare";
import MorningBrief from "../MorningBrief";
import PmixTable from "../PmixTable";
import SalesComparison, { lastYearUnavailable } from "../SalesComparison";
import TargetTile from "../TargetTile";
import WeeklyRhythm from "../WeeklyRhythm";
import { sectionId, type CompareCommand, type LiveCommand } from "@/lib/voice";
import ColumnChart from "../charts/ColumnChart";
import DonutChart from "../charts/DonutChart";
import HorizontalBars from "../charts/HorizontalBars";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Calendar month before the range start: a sensible first custom comparison. */
function defaultCustom(range: Range): Range {
  const d = new Date(range.start + "T00:00:00");
  return { start: toIso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), end: toIso(new Date(d.getFullYear(), d.getMonth(), 0)) };
}

/** Headline tiles on bills (POS Invoice): net sales, bills, average bill, quantity. */
export function SalesKpiRow({ kpis, cmpLabel }: { kpis: ReturnType<typeof useApi<SalesKpis>>; cmpLabel: string }) {
  const c = kpis.data?.current;
  const d = kpis.data?.delta_pct;
  const prev = kpis.data ? fmtRange(kpis.data.previous_range.start, kpis.data.previous_range.end) : undefined;
  const common = { loading: kpis.loading, refreshing: kpis.refreshing, error: !!kpis.error };
  const extras: string[] = [];
  if (c?.discounts) extras.push(`disc ${pkr(c.discounts)}`);
  if (c?.returns_total) extras.push(`returns ${pkr(Math.abs(c.returns_total))}`);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard label="Net Sales" value={pkr(c?.net_sales)} delta={d?.net_sales} sub={prev ? `vs ${cmpLabel} ${prev}${extras.length ? " · " + extras.join(" · ") : ""}` : undefined} {...common} />
      <KpiCard label="Bills" value={num(c?.checks)} delta={d?.checks} sub={c ? `${num(c.checks_per_trading_day, 1)} per trading din · ${num(c.active_days)} din` : undefined} {...common} />
      <KpiCard label="Avg Bill" value={pkr(c?.avg_check)} delta={d?.avg_check} sub={c ? (c.excluded_days.length ? `excl. ${c.excluded_days.length} bulk-entry din` : "net sales ÷ bills") : undefined} {...common} />
      <KpiCard label="Qty Sold" value={num(c?.total_qty)} delta={d?.total_qty} sub={c && c.checks ? `${num(c.items_per_check, 1)} per bill` : undefined} {...common} />
    </div>
  );
}

/** Pace tiles: how fast sales come in per trading day, best / lowest day, and the month against its target. */
export function SalesPaceRow({ pace, onTargetChange }: { pace: ReturnType<typeof useApi<RunRate>>; onTargetChange: (v: number | null) => void }) {
  const r = pace.data;
  const common = { loading: pace.loading, refreshing: pace.refreshing, error: !!pace.error };
  const excl = r?.excluded_days.length ? ` · excl. ${r.excluded_days.length} bulk-entry din` : "";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard label="Avg per Trading Day" value={pkr(r?.avg_per_active_day)} sub={r ? `${num(r.active_days)} of ${num(r.calendar_days)} din had bills · ${num(r.avg_checks_per_active_day, 1)} bills/din${excl}` : undefined} {...common} />
      <KpiCard label="Best Day" value={pkr(r?.best_day?.total)} sub={r?.best_day ? `${fmtDate(r.best_day.date)} · ${num(r.best_day.checks)} bills` : r ? "no bills in range" : undefined} {...common} />
      <KpiCard label="Lowest Day" value={pkr(r?.worst_day?.total)} sub={r?.worst_day ? `${fmtDate(r.worst_day.date)} · ${num(r.worst_day.checks)} bills` : r ? "no bills in range" : undefined} {...common} />
      <TargetTile pace={pace} onTargetChange={onTargetChange} />
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

type MonthMetric = "sales" | "checks" | "qty";

export function SalesCharts({ range, refreshKey, onRetry, cmpMode, cmpCustom }: { range: Range; refreshKey: number; onRetry: () => void; cmpMode: CompareMode; cmpCustom: Range }) {
  const monthly = useApi<MonthlySales>("/api/sales/monthly", range, refreshKey, { months: 12 });
  const items = useApi<TopItems>("/api/sales/top-items", range, refreshKey, { limit: 10 });
  const outlets = useApi<OutletSales>("/api/sales/by-outlet", range, refreshKey);
  const groups = useApi<ItemGroupSales>("/api/sales/by-item-group", range, refreshKey);
  const modes = useApi<PaymentModes>("/api/sales/payment-modes", range, refreshKey);
  const customers = useApi<TopCustomers>("/api/sales/top-customers", range, refreshKey, { limit: 10 });
  const [itemsView, setItemsView] = useState<"bars" | "donut">("donut");
  const [monthMetric, setMonthMetric] = useState<MonthMetric>("sales");
  const [more, setMore] = useState<boolean>(() => readStored<boolean>("sb-more", false));
  useEffect(() => {
    try {
      localStorage.setItem("sb-more", JSON.stringify(more));
    } catch {
      /* ignore */
    }
  }, [more]);

  const monthRows = monthly.data
    ? monthly.data.points.map((p) => ({ ...p, value: monthMetric === "sales" ? p.total : monthMetric === "checks" ? p.checks : p.qty }))
    : [];
  const bestMonth = monthly.data?.points.find((p) => p.period === monthly.data?.best_month);
  const monthFmt = (v: number) => (monthMetric === "sales" ? pkr(v) : num(v));

  // Cards that carry no information on this data set (one outlet, one walk-in customer, cash only)
  // stay out of the way until asked for.
  const singleOutlet = !!outlets.data && outlets.data.outlets.length <= 1;
  const singleMode = !!modes.data && modes.data.modes.length <= 1;
  const singleCustomer = !!customers.data && customers.data.distinct_customers <= 1;
  const hiddenCount = [singleOutlet, singleMode, singleCustomer].filter(Boolean).length;
  const showOutlets = !singleOutlet || more;
  const showModes = !singleMode || more;
  const showCustomers = !singleCustomer || more;

  return (
    <>
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
        action={<ViewToggle value={monthMetric} options={[{ id: "sales", label: "Sales" }, { id: "checks", label: "Bills" }, { id: "qty", label: "Qty" }]} onChange={setMonthMetric} />}
      >
        {monthly.data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <ColumnChart
                rows={monthRows}
                colors={monthRows.map((p) => (p.is_partial ? "var(--ord-2)" : "var(--series-1)"))}
                format={(v, e) => `${monthFmt(v)} · ${num(Number(e.payload?.checks))} bills · avg bill ${pkr(Number(e.payload?.avg_check))} · MoM ${pct(e.payload?.mom_pct as number | null)}${e.payload?.is_partial ? " · month in progress" : ""}${(e.payload?.excluded_days as string[] | undefined)?.length ? " · incl. opening entries" : ""}`}
                seriesName={monthMetric === "sales" ? "Sales" : monthMetric === "checks" ? "Bills" : "Qty"}
                yFormat={monthMetric === "sales" ? undefined : (v) => num(v)}
              />
            </div>
            <table className="w-full self-start text-xs lg:col-span-2">
              <thead>
                <tr className={thead}>
                  <th className={th}>Month</th>
                  <th className={`${th} text-right`}>Sales</th>
                  <th className={`${th} text-right`}>Bills</th>
                  <th className={`${th} text-right`}>Avg bill</th>
                  <th className={`${th} text-right`}>MoM</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {monthly.data.points.slice(-6).reverse().map((p) => (
                  <tr key={p.period} className="border-b border-line/60">
                    <td className="py-1.5 text-ink">
                      {p.label}
                      {p.is_partial && <span className="ml-1 text-[10px] text-ink-3">(to date)</span>}
                      {p.excluded_days.length > 0 && <span className="ml-1 text-[10px] text-warn" title={`bulk / opening entries on ${p.excluded_days.map((d) => fmtDate(d)).join(", ")}; left out of the average bill`}>incl. opening entries</span>}
                    </td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(p.total)}</td>
                    <td className="py-1.5 text-right text-ink-2">{num(p.checks)}</td>
                    <td className="py-1.5 text-right text-ink-2">{p.avg_check ? pkr(p.avg_check) : "—"}</td>
                    <td className="py-1.5 text-right"><DeltaText value={p.mom_pct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="lg:col-span-2">
        <PmixTable range={range} refreshKey={refreshKey} mode={cmpMode} cmpRange={cmpCustom} onRetry={onRetry} />
      </div>

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

      {showOutlets && (
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
          className={showModes || showCustomers ? "" : "lg:col-span-2"}
        >
          {outlets.data && (
            <div className="flex h-full flex-col gap-3">
              <HorizontalBars
                rows={outlets.data.outlets.map((o) => ({ label: o.outlet, value: o.total, count: o.checks, share: o.share_pct }))}
                format={(v, e) => `${pkr(v)} · ${e.payload?.count} bills · ${e.payload?.share}%`}
                height={Math.max(120, outlets.data.outlets.length * 36 + 30)}
                seriesName="Sales"
              />
              <table className="w-full text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Outlet</th>
                    <th className={`${th} text-right`}>Bills</th>
                    <th className={`${th} text-right`}>Avg bill</th>
                    <th className={`${th} text-right`}>Sales</th>
                    <th className={`${th} text-right`}>Share</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {outlets.data.outlets.map((o) => (
                    <tr key={o.outlet + (o.pos_profile ?? "")} className="border-b border-line/60">
                      <td className="py-1.5 text-ink" title={o.pos_profile ?? undefined}>{o.outlet}</td>
                      <td className="py-1.5 text-right text-ink-2">{num(o.checks)}</td>
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
      )}

      {showModes && (
        <Card
          title="Payment Modes"
          id={sectionId("payment_modes")}
          subtitle={modes.data ? `How ${pkr(modes.data.total)} of bills was settled` : undefined}
          source={modes.data?.source}
          loading={modes.loading}
          refreshing={modes.refreshing}
          error={modes.error}
          empty={!!modes.data && modes.data.modes.length === 0}
          onRetry={onRetry}
          height={200}
        >
          {modes.data && <DonutChart rows={modes.data.modes.map((m) => ({ label: m.mode, value: m.amount, note: `${num(m.count)} bills` }))} total={modes.data.total} centerLabel="Settled" />}
        </Card>
      )}

      {showCustomers && (
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
                rows={customers.data.customers.map((c) => ({ label: c.customer_name, value: c.total, count: c.checks, share: c.share_pct }))}
                format={(v, e) => `${pkr(v)} · ${e.payload?.count} bills · ${e.payload?.share}%`}
                seriesName="Sales"
                height={Math.max(160, customers.data.customers.length * 30 + 24)}
              />
              <table className="w-full self-start text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Customer</th>
                    <th className={`${th} text-right`}>Bills</th>
                    <th className={`${th} text-right`}>Avg bill</th>
                    <th className={`${th} text-right`}>Sales</th>
                    <th className={`${th} text-right`}>Last</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {customers.data.customers.map((c) => (
                    <tr key={c.customer} className="border-b border-line/60">
                      <td className="py-1.5 text-ink">{c.customer_name}</td>
                      <td className="py-1.5 text-right text-ink-2">{num(c.checks)}</td>
                      <td className="py-1.5 text-right text-ink-2">{pkr(c.avg_invoice_value)}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(c.total)}</td>
                      <td className="py-1.5 text-right text-ink-2">{fmtDate(c.last_invoice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {hiddenCount > 0 && (
        <div className="lg:col-span-2 -mt-1 text-[11px] text-ink-3">
          <button onClick={() => setMore((m) => !m)} className="underline decoration-dotted underline-offset-2 hover:text-ink">
            {more ? "Hide" : "Show"} {[singleOutlet && "outlets", singleMode && "payment modes", singleCustomer && "customers"].filter(Boolean).join(", ")}
          </button>
          {!more && <span> · only one value each on this data (one outlet, cash only, walk-in customer)</span>}
        </div>
      )}
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

const CMP_LABEL: Record<CompareMode, string> = { previous: "previous", last_week: "last week", last_year: "last year", custom: "" };

export default function SalesTab({
  range, refreshKey, onRetry, compareCommand, liveCommand, onShowInvoices,
}: { range: Range; refreshKey: number; onRetry: () => void; compareCommand?: CompareCommand; liveCommand?: LiveCommand; onShowInvoices?: () => void }) {
  // Comparison basis shared by the KPI tiles, the comparison block and the product mix.
  const [cmpMode, setCmpMode] = useState<CompareMode>(() => readStored<CompareMode>("sb-cmp-mode", "previous"));
  const [cmpCustom, setCmpCustom] = useState<Range>(() => {
    const stored = readStored<Range | null>("sb-cmp-range", null);
    return stored && ISO_DATE.test(stored.start) && ISO_DATE.test(stored.end) && stored.start <= stored.end ? stored : defaultCustom(range);
  });
  const [seenCommand, setSeenCommand] = useState(compareCommand?.nonce);
  if (compareCommand && compareCommand.nonce !== seenCommand) {
    setSeenCommand(compareCommand.nonce);
    setCmpMode(compareCommand.mode);
    if (compareCommand.range) setCmpCustom(compareCommand.range);
  }
  const effectiveMode: CompareMode = cmpMode === "last_year" && lastYearUnavailable(range) ? "previous" : cmpMode;
  useEffect(() => {
    try {
      localStorage.setItem("sb-cmp-mode", JSON.stringify(cmpMode));
      localStorage.setItem("sb-cmp-range", JSON.stringify(cmpCustom));
    } catch {
      /* ignore */
    }
  }, [cmpMode, cmpCustom]);

  // Monthly target typed by the owner, remembered per month in this browser.
  const monthKey = range.end.slice(0, 7);
  const [targets, setTargets] = useState<Record<string, number>>(() => readStored<Record<string, number>>("sb-targets", {}));
  const target = targets[monthKey] ?? null;
  const setTarget = (v: number | null) => {
    const next = { ...targets };
    if (v) next[monthKey] = v;
    else delete next[monthKey];
    setTargets(next);
    try {
      localStorage.setItem("sb-targets", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const cmpExtra: Record<string, string | number> = effectiveMode === "custom" ? { mode: effectiveMode, cmp_start: cmpCustom.start, cmp_end: cmpCustom.end } : { mode: effectiveMode };
  const kpis = useApi<SalesKpis>("/api/sales/kpis", range, refreshKey, cmpExtra);
  const pace = useApi<RunRate>("/api/sales/run-rate", range, refreshKey, target ? { target } : {});
  const invoices = useApi<InvoicesResponse>("/api/sales/invoices", range, refreshKey);

  return (
    <div className="flex flex-col gap-4">
      <div id={sectionId("kpis")} className="scroll-mt-24">
        <SalesKpiRow kpis={kpis} cmpLabel={CMP_LABEL[effectiveMode]} />
      </div>
      {kpis.data && <GuardrailLine health={kpis.data.health} onShowInvoices={onShowInvoices} />}
      <div id={sectionId("pace")} className="scroll-mt-4">
        <SalesPaceRow pace={pace} onTargetChange={setTarget} />
      </div>
      <MorningBrief refreshKey={refreshKey} target={target} />
      <LiveCompare refreshKey={refreshKey} onRetry={onRetry} command={liveCommand} />
      <WeeklyRhythm refreshKey={refreshKey} />
      <SectionHeading id={sectionId("comparison")} title="Comparison" hint="how this range stacks up against another period" />
      <SalesComparison range={range} refreshKey={refreshKey} onRetry={onRetry} mode={cmpMode} onModeChange={setCmpMode} custom={cmpCustom} onCustomChange={setCmpCustom} />
      <SectionHeading title="Trends, Mix & Patterns" hint="what sells, how much, and how it moves month to month" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SalesCharts range={range} refreshKey={refreshKey} onRetry={onRetry} cmpMode={effectiveMode} cmpCustom={cmpCustom} />
      </div>
      <div id={sectionId("invoices")} className="scroll-mt-4">
        <InvoicesTable state={invoices} range={range} onRetry={onRetry} />
      </div>
    </div>
  );
}
