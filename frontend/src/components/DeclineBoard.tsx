"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import { fmtRange, num, pkr } from "@/lib/format";
import type { DeclineFactor, DeclineFactors, DecliningItem, MissingItem, Range } from "@/lib/types";
import Card from "./Card";
import ExportButtons from "./ExportButtons";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";
const TOP = 5;

/** ▲ +12.3% / ▼ −8.1% pill, green for a rise and red for a drop (trading-board style). */
function Badge({ pct, abs }: { pct: number | null; abs?: number }) {
  if (pct === null || !Number.isFinite(pct)) return <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-ink-3">no comparison</span>;
  const up = pct > 0;
  const flat = pct === 0;
  const tone = flat ? "bg-surface-2 text-ink-3" : up ? "bg-good/10 text-good" : "bg-bad/10 text-bad";
  return (
    <span className={`tnum inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {flat ? "▶" : up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%{abs !== undefined && <span className="font-normal opacity-80">({pkr(abs, { sign: true })})</span>}
    </span>
  );
}

function Ticker({ label, value, sub, pct, abs }: { label: string; value: string; sub?: string; pct?: number | null; abs?: number }) {
  return (
    <div className="flex min-w-[170px] flex-1 flex-col gap-1 rounded-lg border border-line p-3">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-3">{label}</span>
      <span className="tnum text-xl font-semibold leading-tight text-ink">{value}</span>
      {pct !== undefined && <span><Badge pct={pct} abs={abs} /></span>}
      {sub && <span className="tnum text-[11px] text-ink-3">{sub}</span>}
    </div>
  );
}

function metricText(f: DeclineFactor): string {
  const m = f.metric;
  const money = f.key === "basket" || f.key === "discounts";
  const fmt = (v: number | null) => (v === null ? "—" : money ? pkr(v) : num(v));
  if (m.previous === null) return `${m.label}: ${fmt(m.current)}`;
  return `${m.label}: ${fmt(m.current)} now · ${fmt(m.previous)} previous · ${fmt(m.last_week)} last week · ${fmt(m.last_month)} last month`;
}

/**
 * Trading-board view of a sales decline: the range against the previous period, the same days last week
 * and last month, then the top factors behind the move ranked by estimated PKR impact, each expandable.
 */
export default function DeclineBoard({ range, refreshKey, onRetry }: Props) {
  const q = useApi<DeclineFactors>("/api/decline/factors", range, refreshKey, { limit: 15 });
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  const c = d?.current;
  const cmp = d?.comparisons;
  const down = d ? d.factors.filter((f) => f.impact < 0) : [];
  const shown = d ? [...down, ...d.factors.filter((f) => f.impact >= 0)].slice(0, TOP) : [];
  const isDecline = !!d && d.decline_abs < 0;

  const factorCols: CsvColumn<DeclineFactor>[] = [
    { key: "rank", header: "Rank", value: (f) => shown.indexOf(f) + 1 },
    { key: "title", header: "Factor", value: (f) => f.title },
    { key: "impact", header: "Impact (PKR)", value: (f) => f.impact },
    { key: "share", header: "Share of decline %", value: (f) => f.share_pct },
    { key: "detail", header: "Detail", value: (f) => f.detail },
    { key: "metric", header: "Metric", value: (f) => metricText(f) },
  ];
  const missingCols: CsvColumn<MissingItem>[] = [
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "prev_qty", header: "Qty sold before", value: (r) => r.prev_qty },
    { key: "prev_amount", header: "Sales before (PKR)", value: (r) => r.prev_amount },
    { key: "lw", header: "Same days last week (PKR)", value: (r) => r.last_week_amount },
    { key: "lm", header: "Same days last month (PKR)", value: (r) => r.last_month_amount },
    { key: "stock", header: "Outlet stock now", value: (r) => r.outlet_stock },
    { key: "made", header: "Produced in range", value: (r) => r.produced_qty },
    { key: "reason", header: "Reason", value: (r) => r.reason },
  ];
  const decliningCols: CsvColumn<DecliningItem>[] = [
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "qty", header: "Qty now", value: (r) => r.qty },
    { key: "amount", header: "Sales now (PKR)", value: (r) => r.amount },
    { key: "prev_amount", header: "Sales previous (PKR)", value: (r) => r.prev_amount },
    { key: "delta", header: "Change (PKR)", value: (r) => r.delta_abs },
    { key: "delta_pct", header: "Change %", value: (r) => r.delta_pct },
    { key: "lw", header: "vs last week %", value: (r) => r.vs_last_week_pct },
    { key: "lm", header: "vs last month %", value: (r) => r.vs_last_month_pct },
    { key: "stock", header: "Outlet stock now", value: (r) => r.outlet_stock },
  ];
  const onExport = (fmt: ExportFormat) => {
    if (!d) return;
    const stem = `sales-decline-${range.start}-${range.end}`;
    if (fmt === "csv") return exportTable("csv", stem, shown, factorCols);
    const missing = (d.factors.find((f) => f.key === "stock_out")?.items ?? []) as MissingItem[];
    const declining = (d.factors.find((f) => f.key === "item_decline")?.items ?? []) as DecliningItem[];
    const scope = `${fmtRange(range.start, range.end)} vs ${fmtRange(d.comparisons.previous.range.start, d.comparisons.previous.range.end)}`;
    void downloadWorkbook(`${stem}.xlsx`, [
      { name: "Factors", title: "Sales decline · factors", subtitle: `${scope} · net sales ${pkr(d.current.net)} (${pkr(d.decline_abs, { sign: true })})`, columns: factorCols, rows: shown },
      { name: "Not available", title: "Items not available at the outlet", subtitle: scope, columns: missingCols, rows: missing, totals: true },
      { name: "Selling less", title: "Items selling less", subtitle: scope, columns: decliningCols, rows: declining, totals: true },
    ]);
  };

  return (
    <Card
      title="Sales Decline · Top Factors"
      subtitle={d && cmp ? `${fmtRange(range.start, range.end)} against the previous ${num(d.current.calendar_days)} days (${fmtRange(cmp.previous.range.start, cmp.previous.range.end)}), the same days last week and last month` : undefined}
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!c && c.net === 0 && (cmp?.previous.net ?? 0) === 0}
      emptyHint="No bills in this range or the one before it."
      onRetry={onRetry}
      height={260}
      action={d ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {d && c && cmp && (
        <div className="flex flex-col gap-4">
          {/* ticker */}
          <div className="flex flex-wrap gap-2">
            <Ticker label="Net sales now" value={pkr(c.net)} sub={`${num(c.checks)} bills · avg bill ${pkr(c.avg_check)} · ${num(c.active_days)} of ${num(c.calendar_days)} din`} />
            <Ticker label="vs previous period" value={pkr(cmp.previous.net)} pct={cmp.previous.delta_pct} abs={cmp.previous.delta_abs} sub={fmtRange(cmp.previous.range.start, cmp.previous.range.end)} />
            <Ticker label="vs same days last week" value={pkr(cmp.last_week.net)} pct={cmp.last_week.delta_pct} abs={cmp.last_week.delta_abs} sub={fmtRange(cmp.last_week.range.start, cmp.last_week.range.end)} />
            <Ticker label="vs same days last month" value={pkr(cmp.last_month.net)} pct={cmp.last_month.delta_pct} abs={cmp.last_month.delta_abs} sub={fmtRange(cmp.last_month.range.start, cmp.last_month.range.end)} />
          </div>

          {/* headline band */}
          <div className={`rounded-lg px-4 py-2.5 text-sm ${isDecline ? "bg-bad/10 text-bad" : "bg-good/10 text-good"}`}>
            {isDecline ? (
              <>
                <span className="font-semibold">Sale {pkr(Math.abs(d.decline_abs))} kam hui</span>
                <span className="opacity-80"> ({d.decline_pct !== null ? `${Math.abs(d.decline_pct).toFixed(1)}%` : "—"}) pichle period se. Neeche top {shown.length} wajohaat, PKR asar ke hisaab se.</span>
              </>
            ) : (
              <>
                <span className="font-semibold">Sale {pkr(d.decline_abs, { sign: true })} barhi</span>
                <span className="opacity-80"> pichle period se. Neeche wo factors jo phir bhi neeche kheench rahe hain.</span>
              </>
            )}
          </div>

          {/* ranked factors */}
          <ol className="flex flex-col gap-2">
            {shown.map((f, i) => {
              const bad = f.impact < 0;
              const isOpen = open === f.key;
              const hasItems = f.items.length > 0;
              return (
                <li key={f.key} className="rounded-lg border border-line">
                  <button
                    onClick={() => hasItems && setOpen(isOpen ? null : f.key)}
                    className={`flex w-full flex-wrap items-center gap-3 px-3 py-2.5 text-left ${hasItems ? "hover:bg-surface-2" : "cursor-default"}`}
                    aria-expanded={hasItems ? isOpen : undefined}
                  >
                    <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${bad ? "bg-bad" : "bg-good"}`}>{i + 1}</span>
                    <span className="min-w-[200px] flex-1">
                      <span className="block text-sm font-semibold text-ink">{f.title}</span>
                      <span className="block text-[11px] text-ink-3">{f.detail}</span>
                      <span className="tnum block text-[11px] text-ink-2">{metricText(f)}</span>
                    </span>
                    <span className="flex min-w-[180px] flex-col items-end gap-1">
                      <span className={`tnum text-base font-semibold ${bad ? "text-bad" : f.impact > 0 ? "text-good" : "text-ink-3"}`}>{pkr(f.impact, { sign: true })}</span>
                      {bad && (
                        <span className="flex w-full items-center gap-2">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                            <span className="block h-full rounded-full bg-bad" style={{ width: `${Math.min(100, f.share_pct)}%` }} />
                          </span>
                          <span className="tnum w-10 text-right text-[11px] text-ink-3">{num(f.share_pct, 0)}%</span>
                        </span>
                      )}
                      {hasItems && <span className="text-[11px] text-accent">{isOpen ? "hide items ▲" : `${num(f.items.length)} items ▼`}</span>}
                    </span>
                  </button>

                  {isOpen && f.key === "stock_out" && (
                    <div className="max-h-[360px] overflow-auto border-t border-line px-3 pb-3">
                      <table className="w-full min-w-[760px] text-xs">
                        <thead className="sticky top-0 bg-surface">
                          <tr className={thead}>
                            <th className={th}>Item</th>
                            <th className={`${th} text-right`}>Sold before</th>
                            <th className={`${th} text-right`}>Sales before</th>
                            <th className={`${th} text-right`}>Last week</th>
                            <th className={`${th} text-right`}>Last month</th>
                            <th className={`${th} text-right`}>Outlet stock</th>
                            <th className={`${th} text-right`}>Produced</th>
                            <th className={th}>Reason</th>
                          </tr>
                        </thead>
                        <tbody className="tnum">
                          {(f.items as MissingItem[]).map((r) => (
                            <tr key={r.item_code} className="border-b border-line/60">
                              <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name} <span className="text-[10px] text-ink-3">{r.item_group}</span></td>
                              <td className={tdNum}>{num(r.prev_qty, 1)}</td>
                              <td className="py-1.5 text-right font-medium text-bad">{pkr(r.prev_amount)}</td>
                              <td className={tdNum}>{r.last_week_amount ? pkr(r.last_week_amount) : "—"}</td>
                              <td className={tdNum}>{r.last_month_amount ? pkr(r.last_month_amount) : "—"}</td>
                              <td className={`py-1.5 text-right ${r.outlet_stock <= 0 ? "text-bad" : "text-ink-2"}`}>{num(r.outlet_stock, 1)}</td>
                              <td className={tdNum}>{r.produced_qty ? num(r.produced_qty, 1) : "—"}</td>
                              <td className="py-1.5 text-ink-2">{r.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {isOpen && f.key === "item_decline" && (
                    <div className="max-h-[360px] overflow-auto border-t border-line px-3 pb-3">
                      <table className="w-full min-w-[820px] text-xs">
                        <thead className="sticky top-0 bg-surface">
                          <tr className={thead}>
                            <th className={th}>Item</th>
                            <th className={`${th} text-right`}>Qty now</th>
                            <th className={`${th} text-right`}>Sales now</th>
                            <th className={`${th} text-right`}>Previous</th>
                            <th className={`${th} text-right`}>Change</th>
                            <th className={`${th} text-right`}>vs last week</th>
                            <th className={`${th} text-right`}>vs last month</th>
                            <th className={`${th} text-right`}>Outlet stock</th>
                          </tr>
                        </thead>
                        <tbody className="tnum">
                          {(f.items as DecliningItem[]).map((r) => (
                            <tr key={r.item_code} className="border-b border-line/60">
                              <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name} <span className="text-[10px] text-ink-3">{r.item_group}</span></td>
                              <td className={tdNum}>{num(r.qty, 1)} <span className="text-ink-3">({num(r.prev_qty, 1)})</span></td>
                              <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                              <td className={tdNum}>{pkr(r.prev_amount)}</td>
                              <td className="py-1.5 text-right"><Badge pct={r.delta_pct} abs={r.delta_abs} /></td>
                              <td className="py-1.5 text-right"><Badge pct={r.vs_last_week_pct} /></td>
                              <td className="py-1.5 text-right"><Badge pct={r.vs_last_month_pct} /></td>
                              <td className={`py-1.5 text-right ${r.outlet_stock <= 0 ? "text-bad" : "text-ink-2"}`}>{num(r.outlet_stock, 1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {d.gains.length > 0 && (
            <div className="rounded-lg border border-line px-3 py-2 text-[11px] text-ink-2">
              <span className="font-semibold text-good">Jo barha:</span> {pkr(d.gains_total, { sign: true })} ·{" "}
              {d.gains.slice(0, 5).map((g) => `${g.item_name} ${pkr(g.delta_abs, { sign: true })}`).join(" · ")}
            </div>
          )}

          <p className="text-[11px] text-ink-3">
            Impacts are estimates against the previous period and overlap (fewer trading days also means fewer bills), so read them as a ranking, not a sum.
            &quot;Not available&quot; = sold in the previous period, nothing now, and no stock at the outlet in ERPNext. Figures from POS bills; outlet stock from ERPNext.
          </p>
        </div>
      )}
    </Card>
  );
}
