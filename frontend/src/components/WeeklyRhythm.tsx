"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE, ApiError, fetchJson } from "@/lib/api";
import { toIso } from "@/lib/dates";
import { fmtDate, num, pkr } from "@/lib/format";
import type { WeeklySales } from "@/lib/types";
import { sectionId } from "@/lib/voice";
import { SourceBadge } from "./Card";
import DeltaText from "./DeltaText";
import GroupedColumns from "./charts/GroupedColumns";
import { ErrorState, Skeleton } from "./States";

function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The week's rhythm: each day of the selected week against the same day last week and against
 * the average of that weekday over the previous four weeks (only weeks in which it traded).
 * Bakery sales follow a weekly beat, so "vs the same weekday" is the fairer comparison.
 */
export default function WeeklyRhythm({ refreshKey }: { refreshKey: number }) {
  const [weekStart, setWeekStart] = useState<string>(() => readStored<string>("sb-week", toIso(mondayOf(new Date()))));
  const [data, setData] = useState<WeeklySales | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const lastRefresh = useRef(refreshKey);

  useEffect(() => {
    try {
      localStorage.setItem("sb-week", JSON.stringify(weekStart));
    } catch {
      /* ignore */
    }
  }, [weekStart]);

  useEffect(() => {
    const controller = new AbortController();
    const bypass = refreshKey !== lastRefresh.current;
    lastRefresh.current = refreshKey;
    const url = `${API_BASE}/api/sales/weekly?week_start=${weekStart}${bypass ? "&refresh=1" : ""}`;
    fetchJson<WeeklySales>(url, controller.signal)
      .then((d) => {
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof ApiError ? e.message : (e as Error).message || "Request failed");
        setLoading(false);
      });
    return () => controller.abort();
  }, [weekStart, refreshKey]);

  const move = (days: number) => {
    const d = new Date(weekStart + "T00:00:00");
    d.setDate(d.getDate() + days);
    setWeekStart(toIso(mondayOf(d)));
  };

  const w = data;
  const rows = w ? w.days.map((d) => ({ label: d.weekday, current: d.net_sales, previous: d.last_week?.net_sales ?? 0, avg4: d.avg4?.net_sales ?? null, n: d.avg4?.trading_weeks ?? 0, date: d.date })) : [];

  return (
    <section id={sectionId("weekly")} className="card scroll-mt-4 p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">Weekly Rhythm</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            {w
              ? w.wtd.checks
                ? `${w.week.is_current ? "Is hafte ab tak" : "Is hafte"} ${pkr(w.wtd.net_sales)} · ${num(w.wtd.checks)} bills · avg bill ${pkr(w.wtd.avg_check)} · pichle hafte ke wahi din se `
                : `No bills in ${w.week.label} yet`
              : "Each day vs the same day last week and vs its 4-week average"}
            {w && w.wtd.checks ? <DeltaText value={w.wtd.vs_last_week_pct} /> : null}
            {w && w.wtd.checks && w.wtd.vs_avg4_pct !== null ? (
              <>
                {" · vs 4-wk avg "}
                <DeltaText value={w.wtd.vs_avg4_pct} />
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-line bg-surface p-0.5">
            <button onClick={() => move(-7)} disabled={!w?.week.can_go_back} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 disabled:opacity-40" aria-label="Previous week">‹</button>
            <span className="tnum px-2 text-xs text-ink">{w ? w.week.label : weekStart}</span>
            <button onClick={() => move(7)} disabled={!w?.week.can_go_forward} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 disabled:opacity-40" aria-label="Next week">›</button>
          </div>
          {w && !w.week.is_current && (
            <button onClick={() => setWeekStart(toIso(mondayOf(new Date())))} className="rounded-md border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2">This week</button>
          )}
          <SourceBadge source={w?.source} />
        </div>
      </header>

      {loading && !w ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : error && !w ? (
        <ErrorState message={error} />
      ) : w ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <table className="w-full self-start text-xs lg:col-span-2">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                <th className="py-1.5 font-medium">Day</th>
                <th className="py-1.5 text-right font-medium">This week</th>
                <th className="py-1.5 text-right font-medium">vs last week</th>
                <th className="hidden py-1.5 text-right font-medium sm:table-cell">vs 4-wk avg</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {w.days.map((d) => {
                const open = expanded === d.date;
                const muted = d.is_future || (!d.checks && !d.is_today);
                return (
                  <tr key={d.date} className={`cursor-pointer border-b border-line/60 align-top hover:bg-surface-2 ${muted ? "text-ink-3" : ""} ${d.is_today ? "bg-accent-soft/40" : ""}`} onClick={() => setExpanded(open ? null : d.date)}>
                    <td className="py-1.5 pr-2">
                      <span className={`font-medium ${d.is_today ? "text-accent" : muted ? "" : "text-ink"}`}>{d.weekday}</span>
                      <span className="ml-1 text-[11px] text-ink-3">{fmtDate(d.date).slice(0, 6)}</span>
                      {d.excluded && <span className="ml-1 text-[10px] text-warn" title="bulk / opening entry day, left out of averages">bulk</span>}
                      {open && (
                        <div className="mt-1 text-[11px] font-normal text-ink-3">
                          {d.checks ? `${num(d.checks)} bills · avg bill ${pkr(d.avg_check)} · ${d.share_of_week_pct}% of week` : d.is_future ? "not yet" : "no bills"}
                          {d.last_week ? ` · last week ${pkr(d.last_week.net_sales)} (${num(d.last_week.checks)} bills)` : " · last week: no bills"}
                          {d.avg4 ? ` · 4-wk avg ${pkr(d.avg4.net_sales)} over ${d.avg4.trading_weeks} of 4 weeks` : " · no 4-week history"}
                        </div>
                      )}
                    </td>
                    <td className={`py-1.5 text-right ${muted ? "" : "font-medium text-ink"}`}>{d.is_future ? "·" : pkr(d.net_sales)}</td>
                    <td className="py-1.5 text-right">{d.is_future ? "" : <DeltaText value={d.delta_vs_last_week_pct} />}</td>
                    <td className="hidden py-1.5 text-right sm:table-cell" title={d.avg4 ? `${d.avg4.trading_weeks} of 4 weeks traded` : undefined}>
                      {d.is_future ? "" : d.avg4 && d.avg4.trading_weeks >= 2 ? <DeltaText value={d.delta_vs_avg4_pct} /> : <span className="text-ink-3">{d.avg4 ? `n=${d.avg4.trading_weeks}` : "—"}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="text-ink">
                <td className="py-2 font-medium">Week to date</td>
                <td className="py-2 text-right font-semibold">{pkr(w.wtd.net_sales)}</td>
                <td className="py-2 text-right"><DeltaText value={w.wtd.vs_last_week_pct} /></td>
                <td className="hidden py-2 text-right sm:table-cell"><DeltaText value={w.wtd.vs_avg4_pct} /></td>
              </tr>
            </tfoot>
          </table>
          <div className="lg:col-span-3">
            <GroupedColumns
              rows={rows}
              names={["This week", "Last week"]}
              height={250}
              format={(v, e) => {
                const p = e.payload as { avg4?: number | null; n?: number } | undefined;
                const base = pkr(v);
                return e.dataKey === "current" && p?.avg4 != null ? `${base} · 4-wk avg ${pkr(p.avg4)} (n=${p.n})` : base;
              }}
              labelFormat={(l, e) => {
                const p = e?.payload as { date?: string } | undefined;
                return p?.date ? `${l} ${fmtDate(p.date)}` : String(l);
              }}
            />
            {w.excluded_days.length > 0 && <p className="mt-1 text-[11px] text-ink-3">Bulk-entry days ({w.excluded_days.map((d) => fmtDate(d)).join(", ")}) count in totals but not in averages.</p>}
          </div>
        </div>
      ) : null}
    </section>
  );
}
