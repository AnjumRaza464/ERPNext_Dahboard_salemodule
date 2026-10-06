"use client";

import { Fragment, useEffect, useState } from "react";
import { API_BASE, fetchJson } from "@/lib/api";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import { fmtDate, num, pkr } from "@/lib/format";
import type { NextDayPlan as Plan, PlanItem } from "@/lib/types";
import Card from "./Card";
import DeltaText from "./DeltaText";
import ExportButtons from "./ExportButtons";
import TableFilter from "./TableFilter";
import ViewToggle from "./ViewToggle";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

/** Tomorrow in the browser's local calendar (toISOString would shift to UTC and give today before 05:00 PKT). */
function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function short(dept: string): string {
  return dept.replace(/\s+Department$/i, "");
}

/**
 * Tomorrow's production plan: for the plan date's weekday, the average of what sold on that weekday over the
 * last four weeks, per product, with the four days shown so the pattern is visible. The plan date can be changed.
 */
export default function NextDayPlan({ refreshKey, source = "sales" }: { refreshKey: number; source?: "sales" | "production" }) {
  const onProduction = source === "production";
  const noun = onProduction ? "production entries" : "bills";
  const verb = onProduction ? "made" : "sold";
  const [planDate, setPlanDate] = useState<string>(tomorrowIso);
  const [weeks, setWeeks] = useState<4 | 6 | 8>(4);
  const [data, setData] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneKey, setDoneKey] = useState("");
  const [query, setQuery] = useState("");
  const [dept, setDept] = useState("");
  const [tick, setTick] = useState(0);

  const key = `${planDate}|${weeks}|${refreshKey}|${tick}|${source}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<Plan>(`${API_BASE}/api/forecast/next-day?date=${planDate}&weeks=${weeks}&source=${source}${refreshKey || tick ? "&refresh=1" : ""}`, controller.signal)
      .then((d) => {
        setData(d);
        setError(null);
        setDoneKey(key);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setError(e.message);
        setDoneKey(key);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planDate, weeks, refreshKey, tick, source]);

  const pending = doneKey !== key;
  const d = data;
  const depts = Array.from(new Set((d?.items ?? []).map((r) => r.department))).sort();
  const needle = query.trim().toLowerCase();
  const rows = (d?.items ?? []).filter((r) => (!dept || r.department === dept) && (!needle || r.item_name.toLowerCase().includes(needle) || r.item_code.toLowerCase().includes(needle)));
  // one block per department, biggest first; inside a block the products stay sorted by value
  const deptOrder = (d?.by_department ?? []).map((b) => b.department);
  const groups = Array.from(new Set(rows.map((r) => r.department)))
    .sort((a, b) => (deptOrder.indexOf(a) === -1 ? 99 : deptOrder.indexOf(a)) - (deptOrder.indexOf(b) === -1 ? 99 : deptOrder.indexOf(b)))
    .map((name) => {
      const items = rows.filter((r) => r.department === name);
      return { name, items, units: items.reduce((s, r) => s + r.suggested_qty, 0), value: items.reduce((s, r) => s + r.avg_sales, 0) };
    });
  const dates = d?.dates_used ?? [];
  const nCols = dates.length + 5;
  const sameDay = d?.basis === "same_weekday";

  const cols: CsvColumn<PlanItem>[] = [
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Product", value: (r) => r.item_name },
    { key: "department", header: "Department", value: (r) => r.department },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    ...dates.map((dt) => ({ key: dt, header: `${onProduction ? "Made" : "Sold"} ${fmtDate(dt)}`, value: (r: PlanItem) => r.by_date[dt] ?? 0 })),
    { key: "avg_qty", header: "Average qty", value: (r) => r.avg_qty },
    { key: "suggested_qty", header: "Suggested qty", value: (r) => r.suggested_qty },
    { key: "last_week_qty", header: "Last same day qty", value: (r) => r.last_week_qty },
    { key: "trend", header: "Trend %", value: (r) => r.trend_pct },
    { key: "avg_sales", header: onProduction ? "Produced value (PKR)" : "Expected sales (PKR)", value: (r) => r.avg_sales },
    { key: "days_sold", header: "Days sold", value: (r) => r.days_sold },
  ];
  const onExport = (fmt: ExportFormat) => {
    if (!d) return;
    const stem = `production-plan-${onProduction ? "on-production" : "on-sales"}-${d.plan_date}`;
    if (fmt === "csv") return exportTable("csv", stem, rows, cols);
    void downloadWorkbook(`${stem}.xlsx`, [
      { name: "Plan", title: `Production plan · ${d.weekday} ${fmtDate(d.plan_date)}`, subtitle: `${sameDay ? `average of the last ${dates.length} ${d.weekday}s` : `average of the last ${dates.length} trading days`}: ${dates.map(fmtDate).join(", ")}`, columns: cols, rows, totals: true, noTotal: ["days_sold", "avg_qty", "last_week_qty"] },
    ]);
  };

  return (
    <Card
      title={onProduction ? "Kal ka Production Plan · production ke hisaab se" : "Kal ka Production Plan · sale ke hisaab se"}
      subtitle={
        d
          ? `${d.weekday} ${fmtDate(d.plan_date)} · ${sameDay ? `average of what was ${verb} on the last ${num(dates.length)} ${d.weekday}s with ${noun}` : `no past ${d.weekday} had ${noun} in ${num(d.lookback_weeks)} weeks, so the last ${num(dates.length)} days with ${noun} are used`}: ${dates.map((x) => fmtDate(x).slice(0, 6)).join(", ")}`
          : onProduction ? "Average production of the same weekday over the last 4 weeks, per product" : "Average sale of the same weekday over the last 4 weeks, per product"
      }
      source={d?.source}
      loading={pending && !d}
      refreshing={pending && !!d}
      error={error}
      empty={!!d && d.items.length === 0}
      emptyHint={`No ${noun} found in the lookback window.`}
      onRetry={() => setTick((t) => t + 1)}
      height={240}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-3">
            Plan for
            <input type="date" value={planDate} onChange={(e) => e.target.value && setPlanDate(e.target.value)} className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink" aria-label="Plan date" />
          </label>
          <ViewToggle value={String(weeks) as "4" | "6" | "8"} options={[{ id: "4", label: "4 wk" }, { id: "6", label: "6 wk" }, { id: "8", label: "8 wk" }]} onChange={(v) => setWeeks(Number(v) as 4 | 6 | 8)} />
          {d && d.items.length > 0 && <ExportButtons onExport={onExport} />}
        </div>
      }
    >
      {d && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded-lg border border-line px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-ink-3">Suggested total</div>
              <div className="tnum text-lg font-semibold text-ink">{num(d.totals.suggested_qty)} <span className="text-xs font-normal text-ink-3">units</span></div>
              <div className="tnum text-[11px] text-ink-3">{num(d.totals.products)} products</div>
            </div>
            <div className="rounded-lg border border-line px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-ink-3">{onProduction ? "Produced value" : "Expected sales"}</div>
              <div className="tnum text-lg font-semibold text-ink">{pkr(d.totals.avg_sales)}</div>
              <div className="tnum text-[11px] text-ink-3">average of the days used</div>
            </div>
            <div className="rounded-lg border border-line px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-ink-3">Last {sameDay ? d.weekday : "trading day"}</div>
              <div className="tnum text-lg font-semibold text-ink">{num(d.totals.last_week_qty)} <span className="text-xs font-normal text-ink-3">units</span></div>
              <div className="tnum text-[11px] text-ink-3">{dates[0] ? `${fmtDate(dates[0])} · ${pkr(d.totals.last_week_sales)}` : "—"}</div>
            </div>
            <div className="rounded-lg border border-line px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-ink-3">By department</div>
              <div className="flex flex-col text-[11px] text-ink-2">
                {d.by_department.map((b) => (
                  <span key={b.department} className="tnum">
                    {short(b.department)}: <span className="font-medium text-ink">{num(b.suggested_qty)}</span> units · {pkr(b.avg_sales)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {d.dates_skipped.length > 0 && sameDay && (
            <p className="text-[11px] text-warn">
              Skipped {d.dates_skipped.map((s) => `${fmtDate(s.date).slice(0, 6)} (${s.reason})`).join(", ")}; older {d.weekday}s were used instead.
            </p>
          )}

          <TableFilter query={query} onQuery={setQuery} group={dept} onGroup={setDept} groups={depts} shown={rows.length} total={d.items.length} placeholder="Search product or code…" />

          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[860px] text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className={thead}>
                  <th className={th}>Product</th>
                  {dates.map((dt) => (
                    <th key={dt} className={`${th} text-right`} title={dt}>{fmtDate(dt).slice(0, 6)}</th>
                  ))}
                  <th className={`${th} text-right`}>Average</th>
                  <th className={`${th} text-right`} title="average rounded up to whole units">Make</th>
                  <th className={`${th} text-right`} title="the two most recent weeks against the two before">Trend</th>
                  <th className={`${th} text-right`}>{onProduction ? "Produced value" : "Expected sales"}</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {groups.map((g) => (
                  <Fragment key={g.name}>
                    <tr className="bg-surface-2/70">
                      <td colSpan={nCols} className="py-1.5 pl-1 text-[11px] font-semibold uppercase tracking-wide text-ink">
                        {g.name}
                        <span className="ml-2 font-normal normal-case tracking-normal text-ink-3">
                          {num(g.items.length)} products · make {num(g.units)} units · {pkr(g.value)}
                        </span>
                      </td>
                    </tr>
                    {g.items.map((r) => (
                      <tr key={r.item_code} className="border-b border-line/60">
                        <td className="py-1.5 pl-3 text-ink" title={`${r.item_code} · ${r.item_group} · sold on ${r.days_sold} of ${dates.length} days`}>
                          {r.item_name} <span className="text-[10px] text-ink-3">{r.uom}</span>
                        </td>
                        {dates.map((dt) => (
                          <td key={dt} className={tdNum}>{r.by_date[dt] ? num(r.by_date[dt], 1) : <span className="text-ink-3">—</span>}</td>
                        ))}
                        <td className={tdNum}>{num(r.avg_qty, 1)}</td>
                        <td className="py-1.5 text-right text-base font-semibold text-ink">{num(r.suggested_qty)}</td>
                        <td className="py-1.5 text-right"><DeltaText value={r.trend_pct} /></td>
                        <td className={tdNum}>{pkr(r.avg_sales)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-ink-3">
            Make = average of the days shown, rounded up. A day with {noun} but none of an item counts as zero; days with no {noun} at all and bulk-entry days are skipped.{" "}
            {onProduction ? "Quantities come from production (Repack) entries in each product's stock unit, so this repeats what the bakery actually made on those days; bought-in items do not appear here." : "Quantities are in each product's stock unit, taken from bills, so they include bought-in items (shown as \"Bought in\")."}
          </p>
        </div>
      )}
    </Card>
  );
}
