"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import { fmtDate, fmtRange, num, pkr } from "@/lib/format";
import type { CompareMode, ItemVelocity, Pmix, PmixItem, Range, VelocityItem } from "@/lib/types";
import { sectionId } from "@/lib/voice";
import { SourceBadge } from "./Card";
import DeltaText from "./DeltaText";
import Spark from "./charts/Spark";
import { EmptyState, ErrorState, Skeleton } from "./States";

type View = "mix" | "plan";
type Basis = "qty" | "value";
type Chip = "all" | "new" | "declining";
type SortKey = keyof Pick<PmixItem, "item_name" | "qty" | "net_sales" | "delta_sales_pct" | "delta_qty_pct" | "avg_price" | "sales_share_pct">;

const PAGE = 15;
const MODE_LABEL: Record<CompareMode, string> = { previous: "previous period", last_week: "same days last week", last_year: "last year", custom: "comparison period" };

const CSV_COLUMNS: CsvColumn<PmixItem>[] = [
  { key: "item_code", header: "Item Code", value: (r) => r.item_code },
  { key: "item_name", header: "Item", value: (r) => r.item_name },
  { key: "item_group", header: "Group", value: (r) => r.item_group },
  { key: "qty", header: "Qty", value: (r) => r.qty },
  { key: "net_sales", header: "Net Sales (PKR)", value: (r) => r.net_sales },
  { key: "qty_share_pct", header: "Qty Share %", value: (r) => r.qty_share_pct },
  { key: "sales_share_pct", header: "Sales Share %", value: (r) => r.sales_share_pct },
  { key: "avg_price", header: "Avg Price (PKR)", value: (r) => r.avg_price },
  { key: "prev_qty", header: "Prev Qty", value: (r) => r.prev_qty },
  { key: "prev_net_sales", header: "Prev Net Sales (PKR)", value: (r) => r.prev_net_sales },
  { key: "delta_qty_pct", header: "Qty Change %", value: (r) => r.delta_qty_pct },
  { key: "delta_sales_pct", header: "Sales Change %", value: (r) => r.delta_sales_pct },
];

const PLAN_COLUMNS: CsvColumn<VelocityItem>[] = [
  { key: "item_code", header: "Item Code", value: (r) => r.item_code },
  { key: "item_name", header: "Item", value: (r) => r.item_name },
  { key: "item_group", header: "Group", value: (r) => r.item_group },
  { key: "typical_qty", header: "Typical Qty / trading day", value: (r) => r.typical_qty },
  { key: "weekday_qty", header: "Same-weekday Avg Qty", value: (r) => r.weekday_qty },
  { key: "weekday_n", header: "Same-weekday Days", value: (r) => r.weekday_n },
  { key: "days_sold", header: "Days Sold", value: (r) => r.days_sold },
  { key: "total_qty", header: "Total Qty (window)", value: (r) => r.total_qty },
];

interface Props {
  range: Range;
  refreshKey: number;
  mode: CompareMode;
  cmpRange?: Range;
  onRetry: () => void;
}

/**
 * Product mix: every item sold in the range by quantity or value, its share, average price and
 * the change against the comparison period, with chips for new and declining items. The
 * "Kal ka plan" view lists typical units per trading day (last 4 weeks) for tomorrow's production.
 */
export default function PmixTable({ range, refreshKey, mode, cmpRange, onRetry }: Props) {
  const extra: Record<string, string | number> = mode === "custom" && cmpRange ? { mode, cmp_start: cmpRange.start, cmp_end: cmpRange.end } : { mode };
  const pmix = useApi<Pmix>("/api/sales/pmix", range, refreshKey, extra);
  const [view, setView] = useState<View>("mix");
  const [basis, setBasis] = useState<Basis>("qty");
  const [chip, setChip] = useState<Chip>("all");
  const [group, setGroup] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "qty", dir: "desc" });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  // the plan never depends on the date filter: always the last 4 weeks to today
  const plan = useApi<ItemVelocity>("/api/sales/item-velocity", { start: range.start, end: range.end }, refreshKey, { weeks: 4, limit: 60 });

  const rows = useMemo(() => {
    const all = pmix.data?.items ?? [];
    const q = query.trim().toLowerCase();
    const filtered = all.filter((r) => {
      if (chip === "new" && !r.is_new) return false;
      if (chip === "declining" && !(r.is_declining || r.is_dropped)) return false;
      if (chip === "all" && r.net_sales === 0) return false;
      if (group !== "all" && r.item_group !== group) return false;
      if (q && !`${r.item_name} ${r.item_code} ${r.item_group}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [pmix.data, chip, group, query, sort]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * PAGE, current * PAGE + PAGE);
  const d = pmix.data;
  const cmpLabel = MODE_LABEL[mode];

  const setBasisAndSort = (b: Basis) => {
    setBasis(b);
    setSort({ key: b === "qty" ? "qty" : "net_sales", dir: "desc" });
    setPage(0);
  };
  const toggleSort = (key: SortKey) => {
    setPage(0);
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "item_name" ? "asc" : "desc" }));
  };

  const th = "py-1.5 pr-2 font-medium";
  const sortBtn = (key: SortKey, label: string, right = true) => (
    <th className={`${th} ${right ? "text-right" : ""}`} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button onClick={() => toggleSort(key)} className={`inline-flex items-center gap-1 hover:text-ink ${sort.key === key ? "text-ink" : ""}`}>
        {label}
        <span className="text-[9px]">{sort.key === key ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );

  const tab = (active: boolean) => `rounded px-2 py-0.5 text-[11px] font-medium ${active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`;
  const chipCls = (active: boolean) => `rounded-full border px-2 py-0.5 text-[11px] ${active ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:bg-surface-2"}`;

  return (
    <section id={sectionId("pmix")} className="card scroll-mt-4 p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{view === "mix" ? "Product Mix" : "Kal ka Plan"}</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            {view === "mix"
              ? d
                ? `${num(d.totals.distinct_items)} items sold · top 5 = ${d.top5_share_pct}% of sales · ${num(d.totals.new_items)} new · ${num(d.totals.declining_items)} declining · ${num(d.totals.dropped_items)} not sold vs ${cmpLabel}`
                : "Every item sold in the range, by quantity or value, vs the comparison period"
              : plan.data
                ? `Typical units per trading day over ${fmtRange(plan.data.range.start, plan.data.range.end)} (${num(plan.data.trading_days)} trading din) · next day ${plan.data.next_day.weekday} ${fmtDate(plan.data.next_day.date)}${plan.data.weekday_dates.length ? ` · ${plan.data.weekday_dates.length} ${plan.data.next_day.weekday}s in window` : ""}`
                : "Typical units per trading day for tomorrow's production"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" className="flex rounded-md border border-line bg-surface p-0.5">
            <button role="tab" aria-selected={view === "mix"} onClick={() => setView("mix")} className={tab(view === "mix")}>Mix</button>
            <button role="tab" aria-selected={view === "plan"} onClick={() => setView("plan")} className={tab(view === "plan")}>Kal ka plan</button>
          </div>
          {view === "mix" && (
            <div role="tablist" className="flex rounded-md border border-line bg-surface p-0.5">
              <button role="tab" aria-selected={basis === "qty"} onClick={() => setBasisAndSort("qty")} className={tab(basis === "qty")}>By qty</button>
              <button role="tab" aria-selected={basis === "value"} onClick={() => setBasisAndSort("value")} className={tab(basis === "value")}>By value</button>
            </div>
          )}
          <button
            onClick={() =>
              view === "mix"
                ? downloadCsv(`product-mix_${range.start}_to_${range.end}.csv`, toCsv(rows, CSV_COLUMNS))
                : plan.data && downloadCsv(`kal-ka-plan_${plan.data.next_day.date}.csv`, toCsv(plan.data.items, PLAN_COLUMNS))
            }
            disabled={view === "mix" ? !rows.length : !plan.data?.items.length}
            className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
          >
            Export CSV
          </button>
          <SourceBadge source={d?.source} />
        </div>
      </header>

      {view === "mix" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              <button onClick={() => { setChip("all"); setPage(0); }} className={chipCls(chip === "all")}>Sab</button>
              <button onClick={() => { setChip("new"); setPage(0); }} className={chipCls(chip === "new")} title="sold this period, not in the comparison period">Naye{d ? ` ${d.totals.new_items}` : ""}</button>
              <button onClick={() => { setChip("declining"); setPage(0); }} className={chipCls(chip === "declining")} title="sales down 30% or more, or not sold at all this period">Girte hue{d ? ` ${d.totals.declining_items + d.totals.dropped_items}` : ""}</button>
              {d?.groups.map((g) => (
                <button key={g.item_group} onClick={() => { setGroup(group === g.item_group ? "all" : g.item_group); setPage(0); }} className={chipCls(group === g.item_group)} title={`${pkr(g.net_sales)} · ${g.share_pct}% · ${num(g.items)} items`}>
                  {g.item_group}
                </button>
              ))}
            </div>
            <input
              type="search"
              placeholder="Search item…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }}
              className="ml-auto w-44 rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink placeholder:text-ink-3"
            />
          </div>
          {pmix.loading ? (
            <div className="flex flex-col gap-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : pmix.error ? (
            <ErrorState message={pmix.error} onRetry={onRetry} />
          ) : rows.length === 0 ? (
            <EmptyState title={query || chip !== "all" || group !== "all" ? "No items match" : "No items sold in this range"} />
          ) : (
            <div className={`transition-opacity ${pmix.refreshing ? "opacity-60" : ""}`}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-xs">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                      {sortBtn("item_name", "Item", false)}
                      {sortBtn("qty", "Qty")}
                      {sortBtn("net_sales", "Sales")}
                      {sortBtn("sales_share_pct", "Share")}
                      {sortBtn("avg_price", "Avg price")}
                      {sortBtn(basis === "qty" ? "delta_qty_pct" : "delta_sales_pct", `vs ${cmpLabel === "previous period" ? "prev" : cmpLabel === "same days last week" ? "last wk" : cmpLabel === "last year" ? "last yr" : "cmp"}`)}
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {visible.map((r) => {
                      const open = expanded === r.item_code;
                      return (
                        <tr key={r.item_code} className="cursor-pointer border-b border-line/60 align-top hover:bg-surface-2" onClick={() => setExpanded(open ? null : r.item_code)}>
                          <td className="py-1.5 pr-2 text-ink">
                            <span className="font-medium">{r.item_name}</span>
                            {r.is_new && <span className="ml-1 rounded bg-accent-soft px-1 text-[10px] text-accent">new</span>}
                            {r.is_dropped && <span className="ml-1 rounded bg-surface-2 px-1 text-[10px] text-ink-3">not sold</span>}
                            {r.is_declining && <span className="ml-1 rounded bg-bad/10 px-1 text-[10px] text-bad">declining</span>}
                            {open && (
                              <div className="mt-1 text-[11px] font-normal text-ink-3">
                                {r.item_group} · {r.item_code} · qty share {r.qty_share_pct}% · {cmpLabel}: {num(r.prev_qty)} qty, {pkr(r.prev_net_sales)}
                                {r.delta_sales_pct !== null ? ` · sales ${r.delta_sales_pct > 0 ? "+" : ""}${r.delta_sales_pct}%` : ""}
                              </div>
                            )}
                          </td>
                          <td className={`py-1.5 pr-2 text-right ${basis === "qty" ? "font-medium text-ink" : "text-ink-2"}`}>{num(r.qty, r.qty % 1 ? 1 : 0)}</td>
                          <td className={`py-1.5 pr-2 text-right ${basis === "value" ? "font-medium text-ink" : "text-ink-2"}`}>{pkr(r.net_sales)}</td>
                          <td className="py-1.5 pr-2 text-right text-ink-2">{r.sales_share_pct}%</td>
                          <td className="py-1.5 pr-2 text-right text-ink-2">{pkr(r.avg_price)}</td>
                          <td className="py-1.5 pr-2 text-right"><DeltaText value={basis === "qty" ? r.delta_qty_pct : r.delta_sales_pct} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {d && (
                    <tfoot>
                      <tr className="font-medium text-ink">
                        <td className="py-2 pr-2">Total ({num(rows.length)} items shown)</td>
                        <td className="py-2 pr-2 text-right">{num(rows.reduce((s, r) => s + r.qty, 0))}</td>
                        <td className="py-2 pr-2 text-right">{pkr(rows.reduce((s, r) => s + r.net_sales, 0))}</td>
                        <td className="py-2 pr-2 text-right">{num(rows.reduce((s, r) => s + r.sales_share_pct, 0), 0)}%</td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {pages > 1 && (
                <div className="mt-3 flex items-center justify-between text-xs text-ink-3">
                  <span>Page {current + 1} of {pages}</span>
                  <div className="flex gap-1">
                    <button onClick={() => setPage(Math.max(0, current - 1))} disabled={current === 0} className="rounded-md border border-line px-2.5 py-1 hover:bg-surface-2 disabled:opacity-40">Prev</button>
                    <button onClick={() => setPage(Math.min(pages - 1, current + 1))} disabled={current >= pages - 1} className="rounded-md border border-line px-2.5 py-1 hover:bg-surface-2 disabled:opacity-40">Next</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : plan.loading ? (
        <div className="flex flex-col gap-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
      ) : plan.error ? (
        <ErrorState message={plan.error} onRetry={onRetry} />
      ) : !plan.data || plan.data.items.length === 0 ? (
        <EmptyState title="No bills in the last 4 weeks" />
      ) : (
        <div className={`overflow-x-auto transition-opacity ${plan.refreshing ? "opacity-60" : ""}`}>
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                <th className={th}>Item</th>
                <th className={`${th} text-right`} title="average units on each trading day of the last 4 weeks (days with no sale of the item count as zero)">Typical / din</th>
                <th className={`${th} text-right`} title={`average units on past ${plan.data.next_day.weekday}s in the window`}>{plan.data.next_day.weekday.slice(0, 3)} avg{plan.data.weekday_dates.length ? ` (n=${plan.data.weekday_dates.length})` : ""}</th>
                <th className={`${th} text-right`}>Last 4 din</th>
                <th className={`${th} text-right`}>Days sold</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {plan.data.items.map((r) => (
                <tr key={r.item_code} className="border-b border-line/60 hover:bg-surface-2">
                  <td className="py-1.5 pr-2 text-ink">
                    <span className="font-medium">{r.item_name}</span>
                    <span className="ml-1 text-[11px] text-ink-3">{r.item_group}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-right font-medium text-ink">{num(r.typical_qty, r.typical_qty < 10 ? 1 : 0)}</td>
                  <td className="py-1.5 pr-2 text-right text-ink-2">{r.weekday_qty !== null && r.weekday_n >= 2 ? num(r.weekday_qty, r.weekday_qty < 10 ? 1 : 0) : <span className="text-ink-3">—</span>}</td>
                  <td className="py-1.5 pr-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <Spark series={[{ values: r.last_4_days, color: "var(--series-1)" }]} width={56} height={18} />
                      <span className="text-ink-2">{r.last_4_days.map((v) => num(v)).join(" · ")}</span>
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-right text-ink-2">{num(r.days_sold)} / {num(plan.data!.trading_days)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-ink-3">Typical = units per trading day over the last 4 weeks; the weekday average is shown once that weekday has traded at least twice. Bulk-entry days are left out.</p>
        </div>
      )}
    </section>
  );
}
