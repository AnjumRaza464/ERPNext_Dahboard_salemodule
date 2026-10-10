"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import { fmtRange, num, pkr } from "@/lib/format";
import type { CostFactor, CostFactors, Range, RateRow, UsageRow } from "@/lib/types";
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

/** ▲ +1.2 pts / ▼ −0.8 pts pill; for cost a rise is bad (red), a drop good (green). */
function PtsBadge({ pts, suffix = "pts" }: { pts: number | null; suffix?: string }) {
  if (pts === null || !Number.isFinite(pts)) return <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-ink-3">no comparison</span>;
  const up = pts > 0;
  const flat = pts === 0;
  const tone = flat ? "bg-surface-2 text-ink-3" : up ? "bg-bad/10 text-bad" : "bg-good/10 text-good";
  return (
    <span className={`tnum inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {flat ? "▶" : up ? "▲" : "▼"} {pts > 0 ? "+" : ""}{pts.toFixed(1)} {suffix}
    </span>
  );
}

function Ticker({ label, value, sub, pts }: { label: string; value: string; sub?: string; pts?: number | null }) {
  return (
    <div className="flex min-w-[170px] flex-1 flex-col gap-1 rounded-lg border border-line p-3">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-3">{label}</span>
      <span className="tnum text-xl font-semibold leading-tight text-ink">{value}</span>
      {pts !== undefined && <span><PtsBadge pts={pts} /></span>}
      {sub && <span className="tnum text-[11px] text-ink-3">{sub}</span>}
    </div>
  );
}

function metricText(f: CostFactor): string {
  const m = f.metric;
  const money = f.key !== "efficiency";
  const fmt = (v: number | null) => (v === null ? "—" : money ? pkr(v) : `PKR ${num(v, 0)} / 100`);
  if (m.previous === null) return `${m.label}: ${fmt(m.current)}`;
  return `${m.label}: ${fmt(m.current)} now · ${fmt(m.previous)} previous · ${fmt(m.last_week)} last week · ${fmt(m.last_month)} last month`;
}

/**
 * Trading-board view of material cost: cost % of sales against the previous period, last week and last month,
 * then the factors behind the move ranked by estimated impact (rates, material per output, the sales side,
 * unsold produce, write-offs, volume), each expandable to the materials behind it.
 */
export default function CostBoard({ range, refreshKey, onRetry }: Props) {
  const q = useApi<CostFactors>("/api/decline/cost-factors", range, refreshKey, { limit: 15 });
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  const c = d?.current;
  const cmp = d?.comparisons;
  const shown = d ? d.factors.slice(0, TOP) : [];
  const isUp = !!d && (d.change_pts ?? 0) > 0;

  const factorCols: CsvColumn<CostFactor>[] = [
    { key: "rank", header: "Rank", value: (f) => shown.indexOf(f) + 1 },
    { key: "title", header: "Factor", value: (f) => f.title },
    { key: "impact", header: "Impact (PKR)", value: (f) => f.impact },
    { key: "pts", header: "Impact (pts of sales)", value: (f) => f.impact_pts },
    { key: "share", header: "Share of increase %", value: (f) => f.share_pct },
    { key: "detail", header: "Detail", value: (f) => f.detail },
    { key: "metric", header: "Metric", value: (f) => metricText(f) },
  ];
  const rateCols: CsvColumn<RateRow>[] = [
    { key: "item_name", header: "Material", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "qty", header: "Qty used", value: (r) => r.qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "rate", header: "Rate now", value: (r) => r.rate },
    { key: "prev_rate", header: "Rate before", value: (r) => r.prev_rate },
    { key: "chg", header: "Rate change %", value: (r) => r.rate_change_pct },
    { key: "effect", header: "Effect (PKR)", value: (r) => r.effect },
  ];
  const usageCols: CsvColumn<UsageRow>[] = [
    { key: "item_name", header: "Material", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "qty", header: "Qty now", value: (r) => r.qty },
    { key: "prev_qty", header: "Qty before", value: (r) => r.prev_qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "chg", header: "Qty change %", value: (r) => r.qty_change_pct },
    { key: "amount", header: "Value now (PKR)", value: (r) => r.amount },
    { key: "effect", header: "Effect (PKR)", value: (r) => r.effect },
  ];
  const onExport = (fmt: ExportFormat) => {
    if (!d) return;
    const stem = `cost-increase-${range.start}-${range.end}`;
    if (fmt === "csv") return exportTable("csv", stem, shown, factorCols);
    const rates = (d.factors.find((f) => f.key === "rates")?.items ?? []) as RateRow[];
    const usage = (d.factors.find((f) => f.key === "efficiency")?.items ?? []) as UsageRow[];
    const scope = `${fmtRange(range.start, range.end)} vs ${fmtRange(d.comparisons.previous.range.start, d.comparisons.previous.range.end)}`;
    void downloadWorkbook(`${stem}.xlsx`, [
      { name: "Factors", title: "Cost increase · factors", subtitle: `${scope} · material cost ${c?.cost_pct ?? "—"}% of sales (${d.change_pts !== null ? `${d.change_pts > 0 ? "+" : ""}${d.change_pts} pts` : "—"})`, columns: factorCols, rows: shown },
      { name: "Rates", title: "Material rates, now vs before", subtitle: scope, columns: rateCols, rows: rates, totals: true, noTotal: ["qty", "rate", "prev_rate"] },
      { name: "Usage", title: "Material used, now vs before", subtitle: scope, columns: usageCols, rows: usage, totals: true, noTotal: ["qty", "prev_qty"] },
      { name: "Cheaper", title: "Materials that got cheaper", subtitle: scope, columns: rateCols, rows: d.cheaper, totals: true, noTotal: ["qty", "rate", "prev_rate"] },
    ]);
  };

  return (
    <Card
      title="Cost Increase · Top Factors"
      subtitle={d && cmp ? `Material cost as % of net sales · ${fmtRange(range.start, range.end)} against the previous period (${fmtRange(cmp.previous.range.start, cmp.previous.range.end)}), the same days last week and last month` : undefined}
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!c && c.consumed === 0 && c.net === 0}
      emptyHint="No production or sales in this range."
      onRetry={onRetry}
      height={260}
      action={d ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {d && c && cmp && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Ticker label="Material cost % now" value={c.cost_pct !== null ? `${num(c.cost_pct, 1)}%` : "—"} sub={`${pkr(c.consumed)} material ÷ ${pkr(c.net)} sales · PKR ${num(c.material_per_100_output ?? 0, 0)} per 100 output`} />
            <Ticker label="vs previous period" value={cmp.previous.cost_pct !== null ? `${num(cmp.previous.cost_pct, 1)}%` : "—"} pts={cmp.previous.delta_pts} sub={fmtRange(cmp.previous.range.start, cmp.previous.range.end)} />
            <Ticker label="vs same days last week" value={cmp.last_week.cost_pct !== null ? `${num(cmp.last_week.cost_pct, 1)}%` : "—"} pts={cmp.last_week.delta_pts} sub={fmtRange(cmp.last_week.range.start, cmp.last_week.range.end)} />
            <Ticker label="vs same days last month" value={cmp.last_month.cost_pct !== null ? `${num(cmp.last_month.cost_pct, 1)}%` : "—"} pts={cmp.last_month.delta_pts} sub={fmtRange(cmp.last_month.range.start, cmp.last_month.range.end)} />
          </div>

          <div className={`rounded-lg px-4 py-2.5 text-sm ${isUp ? "bg-bad/10 text-bad" : "bg-good/10 text-good"}`}>
            {d.change_pts === null ? (
              <span className="font-semibold">Pichle period se comparison nahi ban saka.</span>
            ) : isUp ? (
              <>
                <span className="font-semibold">Material cost {d.change_pts.toFixed(1)} pts barha</span>
                <span className="opacity-80">
                  {" "}({cmp.previous.cost_pct}% se {c.cost_pct}%). Is mein sale girne ka hissa {d.sales_effect_pts !== null ? `${d.sales_effect_pts > 0 ? "+" : ""}${d.sales_effect_pts.toFixed(1)}` : "—"} pts, material ka hissa {d.material_effect_pts !== null ? `${d.material_effect_pts > 0 ? "+" : ""}${d.material_effect_pts.toFixed(1)}` : "—"} pts.
                </span>
              </>
            ) : (
              <>
                <span className="font-semibold">Material cost {Math.abs(d.change_pts).toFixed(1)} pts gira</span>
                <span className="opacity-80"> ({cmp.previous.cost_pct}% se {c.cost_pct}%). Neeche wo factors jo phir bhi upar dhakel rahe hain.</span>
              </>
            )}
          </div>

          <ol className="flex flex-col gap-2">
            {shown.map((f, i) => {
              const bad = f.impact > 0;
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
                    <span className="flex min-w-[200px] flex-col items-end gap-1">
                      <span className="flex items-center gap-2">
                        <span className={`tnum text-base font-semibold ${bad ? "text-bad" : f.impact < 0 ? "text-good" : "text-ink-3"}`}>{pkr(f.impact, { sign: true })}</span>
                        <PtsBadge pts={f.impact_pts} />
                      </span>
                      {bad && (
                        <span className="flex w-full items-center gap-2">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                            <span className="block h-full rounded-full bg-bad" style={{ width: `${Math.min(100, f.share_pct)}%` }} />
                          </span>
                          <span className="tnum w-10 text-right text-[11px] text-ink-3">{num(f.share_pct, 0)}%</span>
                        </span>
                      )}
                      {hasItems && <span className="text-[11px] text-accent">{isOpen ? "hide materials ▲" : `${num(f.items.length)} materials ▼`}</span>}
                    </span>
                  </button>

                  {isOpen && f.key === "rates" && (
                    <div className="max-h-[360px] overflow-auto border-t border-line px-3 pb-3">
                      <table className="w-full min-w-[720px] text-xs">
                        <thead className="sticky top-0 bg-surface">
                          <tr className={thead}>
                            <th className={th}>Material</th>
                            <th className={`${th} text-right`}>Qty used</th>
                            <th className={`${th} text-right`}>Rate now</th>
                            <th className={`${th} text-right`}>Rate before</th>
                            <th className={`${th} text-right`}>Change</th>
                            <th className={`${th} text-right`}>Effect</th>
                          </tr>
                        </thead>
                        <tbody className="tnum">
                          {(f.items as RateRow[]).map((r) => (
                            <tr key={r.item_code} className="border-b border-line/60">
                              <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name} <span className="text-[10px] text-ink-3">{r.item_group}</span></td>
                              <td className={tdNum}>{num(r.qty, 1)} <span className="text-ink-3">{r.uom}</span></td>
                              <td className="py-1.5 text-right font-medium text-ink">{pkr(r.rate, { decimals: true })}</td>
                              <td className={tdNum}>{pkr(r.prev_rate, { decimals: true })}</td>
                              <td className="py-1.5 text-right"><PtsBadge pts={r.rate_change_pct} suffix="%" /></td>
                              <td className={`py-1.5 text-right font-medium ${r.effect > 0 ? "text-bad" : "text-good"}`}>{pkr(r.effect, { sign: true })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {isOpen && f.key === "efficiency" && (
                    <div className="max-h-[360px] overflow-auto border-t border-line px-3 pb-3">
                      <table className="w-full min-w-[720px] text-xs">
                        <thead className="sticky top-0 bg-surface">
                          <tr className={thead}>
                            <th className={th}>Material</th>
                            <th className={`${th} text-right`}>Qty now</th>
                            <th className={`${th} text-right`}>Qty before</th>
                            <th className={`${th} text-right`}>Change</th>
                            <th className={`${th} text-right`}>Value now</th>
                            <th className={`${th} text-right`}>Effect</th>
                          </tr>
                        </thead>
                        <tbody className="tnum">
                          {(f.items as UsageRow[]).map((r) => (
                            <tr key={r.item_code} className="border-b border-line/60">
                              <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name} <span className="text-[10px] text-ink-3">{r.item_group}</span></td>
                              <td className="py-1.5 text-right font-medium text-ink">{num(r.qty, 1)} <span className="font-normal text-ink-3">{r.uom}</span></td>
                              <td className={tdNum}>{num(r.prev_qty, 1)}</td>
                              <td className="py-1.5 text-right">{r.qty_change_pct === null ? <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs text-accent">new</span> : <PtsBadge pts={r.qty_change_pct} suffix="%" />}</td>
                              <td className={tdNum}>{pkr(r.amount)}</td>
                              <td className={`py-1.5 text-right font-medium ${r.effect > 0 ? "text-bad" : "text-good"}`}>{pkr(r.effect, { sign: true })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-2 text-[11px] text-ink-3">Usage effect per material; the factor above takes out the part explained by making more or less in total.</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {d.cheaper.length > 0 && (
            <div className="rounded-lg border border-line px-3 py-2 text-[11px] text-ink-2">
              <span className="font-semibold text-good">Jo saste hue:</span> {pkr(d.cheaper_total, { sign: true })} ·{" "}
              {d.cheaper.slice(0, 5).map((r) => `${r.item_name} ${r.rate_change_pct !== null ? `${r.rate_change_pct.toFixed(1)}%` : ""}`).join(" · ")}
            </div>
          )}

          <p className="text-[11px] text-ink-3">
            Material cost % = material consumed in production ÷ net sales. Rate effects use the valuation rates production was booked at. Impacts are estimates against the previous period and overlap, so read them as a ranking; pts = share of this period&apos;s net sales.
          </p>
        </div>
      )}
    </Card>
  );
}
