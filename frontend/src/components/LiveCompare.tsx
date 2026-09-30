"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { presetRange, toIso } from "@/lib/dates";
import { fmtDate, fmtRange, fmtTime, num, pct, pkr } from "@/lib/format";
import type { LiveCompare as LiveCompareData, LiveDelta, LiveMetric, LivePeriodKey, Range } from "@/lib/types";
import { sectionId, type LiveCommand } from "@/lib/voice";
import { AutoRefreshControl, LIVE_INTERVALS, parseIntervalEnv, RefreshCountdown, withDefault } from "./AutoRefreshControl";
import { SourceBadge } from "./Card";
import { EmptyState, ErrorState, Skeleton } from "./States";
import MultiLineChart from "./charts/MultiLineChart";

type LivePreset = "today" | "yesterday" | "custom";
type ChartMetric = "sales" | "gcs";
type Flash = "up" | "down";
type CompareKey = "previous" | "last_week";

const DEFAULT_INTERVAL = parseIntervalEnv(process.env.NEXT_PUBLIC_LIVE_REFRESH_SECONDS, 60);
const INTERVAL_OPTIONS = withDefault(LIVE_INTERVALS, DEFAULT_INTERVAL);

interface MetricDef {
  key: LiveMetric;
  label: string;
  hint: string;
  fmt: (v: number) => string;
  fmtAbs: (v: number) => string;
}

const signedNum = (v: number, decimals = 0) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v), decimals)}`;

const METRICS: MetricDef[] = [
  { key: "sales", label: "Net Sales", hint: "PKR · returns deducted", fmt: (v) => pkr(v), fmtAbs: (v) => pkr(v, { sign: true }) },
  { key: "gcs", label: "GCS", hint: "guest checks · bills rung up at the till", fmt: (v) => num(v), fmtAbs: (v) => signedNum(v) },
  { key: "avg_check", label: "Average Check", hint: "net sales ÷ GCS", fmt: (v) => pkr(v), fmtAbs: (v) => pkr(v, { sign: true }) },
  { key: "qty", label: "Qty Sold", hint: "units", fmt: (v) => num(v, 1), fmtAbs: (v) => signedNum(v, 1) },
];
const TILES = METRICS.slice(0, 3);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function yesterdayRange(): Range {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const s = toIso(d);
  return { start: s, end: s };
}

function livePresetFor(r: Range): LivePreset {
  const t = presetRange("today");
  if (r.start === t.start && r.end === t.end) return "today";
  const y = yesterdayRange();
  if (r.start === y.start && r.end === y.end) return "yesterday";
  return "custom";
}

function rangeFor(preset: LivePreset, custom: Range): Range {
  if (preset === "today") return presetRange("today");
  if (preset === "yesterday") return yesterdayRange();
  return custom;
}

function validRange(r: unknown): r is Range {
  const x = r as Range | null;
  return !!x && ISO_DATE.test(x.start) && ISO_DATE.test(x.end) && x.start <= x.end;
}

/** Wording for the two comparison periods, given what the board is showing. */
function periodLabels(range: Range, days: number): Record<CompareKey, string> {
  if (days === 1) {
    return { previous: range.start === toIso(new Date()) ? "Yesterday" : "Previous day", last_week: "Same day last week" };
  }
  return { previous: `Previous ${days} days`, last_week: "Same period last week" };
}

function currentLabelFor(range: Range): string {
  if (range.start === range.end) {
    if (range.start === toIso(new Date())) return "Today";
    if (range.start === yesterdayRange().start) return "Yesterday";
  }
  return fmtRange(range.start, range.end);
}

/** ▲ +12.3% style badge, green for a rise and red for a drop. */
function DeltaBadge({ delta, invert }: { delta: LiveDelta; invert?: boolean }) {
  const p = delta.pct;
  const has = p !== null && Number.isFinite(p);
  const dir = !has ? "none" : p > 0 ? "up" : p < 0 ? "down" : "flat";
  const good = (dir === "up" && !invert) || (dir === "down" && invert);
  const bad = (dir === "down" && !invert) || (dir === "up" && invert);
  const tone = good ? "text-good bg-good/10" : bad ? "text-bad bg-bad/10" : "text-ink-3 bg-surface-2";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : dir === "flat" ? "▶" : "·";
  return (
    <span className={`tnum inline-flex min-w-[68px] items-center justify-end gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold ${tone}`} title={has ? "change vs that period" : "no sales in that period, so no percentage"}>
      <span aria-hidden="true" className="text-[9px]">{arrow}</span>
      {has ? pct(p) : "n/a"}
    </span>
  );
}

/** Two cumulative curves on one tiny scale: this period (solid) against a comparison (dashed). */
function Spark({ series }: { series: { values: (number | null)[]; color: string; dashed?: boolean }[] }) {
  const w = 96;
  const h = 30;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (all.length < 2) return <div style={{ width: w, height: h }} />;
  const max = Math.max(...all);
  const min = Math.min(0, ...all);
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * (w - 2) + 1 : w / 2);
  const y = (v: number) => (max === min ? h / 2 : h - 2 - ((v - min) / (max - min)) * (h - 4));
  return (
    <svg width={w} height={h} aria-hidden="true" className="shrink-0">
      {series.map((s, si) => {
        const pts = s.values.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" ");
        return pts ? <polyline key={si} points={pts} fill="none" stroke={s.color} strokeWidth={si === 0 ? 1.8 : 1.2} strokeDasharray={s.dashed ? "3 2" : undefined} strokeLinejoin="round" strokeLinecap="round" /> : null;
      })}
    </svg>
  );
}

function CompareLine({ label, value, delta, def }: { label: string; value: number; delta: LiveDelta; def: MetricDef }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="min-w-0 truncate text-ink-3">
        vs {label} <span className="tnum text-ink-2">{def.fmt(value)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="tnum text-ink-2">{def.fmtAbs(delta.abs)}</span>
        <DeltaBadge delta={delta} />
      </span>
    </div>
  );
}

interface Props {
  /** global refresh counter (the header's Refresh Now button) */
  refreshKey: number;
  onRetry: () => void;
  /** set by the voice assistant; a new nonce moves the board to that date */
  command?: LiveCommand;
}

/**
 * Trading-style live board: the selected day (default today) against yesterday and
 * against the same weekday last week, for net sales, GCS (guest checks) and average
 * check. Figures come from POS Invoice, so today's checks appear as soon as they are
 * rung up. Polls ERPNext on a configurable interval; Refresh fetches immediately.
 */
export default function LiveCompare({ refreshKey, onRetry, command }: Props) {
  const [preset, setPreset] = useState<LivePreset>(() => {
    const p = readStored<LivePreset>("sb-live-preset", "today");
    return p === "today" || p === "yesterday" || p === "custom" ? p : "today";
  });
  const [custom, setCustom] = useState<Range>(() => {
    const stored = readStored<Range | null>("sb-live-custom", null);
    return validRange(stored) ? stored : yesterdayRange();
  });
  const [draft, setDraft] = useState<Range>(custom);
  const [intervalSec, setIntervalSec] = useState<number>(() => {
    const v = readStored<number>("sb-live-interval", DEFAULT_INTERVAL);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_INTERVAL;
  });
  const [tick, setTick] = useState(0);
  const onTick = useCallback(() => setTick((t) => t + 1), []);
  const { nextAt, restart } = useAutoRefresh(intervalSec, onTick);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("sales");
  const [flash, setFlash] = useState<Partial<Record<LiveMetric, Flash>>>({});
  const [seenCommand, setSeenCommand] = useState(command?.nonce);
  const [seen, setSeen] = useState<{ data: LiveCompareData | null; key: string; totals: Record<LiveMetric, number> | null }>({ data: null, key: "", totals: null });

  // Apply a voice command during render (React's "adjust state on prop change" pattern).
  if (command && command.nonce !== seenCommand) {
    setSeenCommand(command.nonce);
    const p = livePresetFor(command.range);
    setPreset(p);
    if (p === "custom") {
      setCustom(command.range);
      setDraft(command.range);
    }
  }

  const range = rangeFor(preset, custom);
  const live = useApi<LiveCompareData>("/api/sales/live-compare", range, refreshKey + tick);
  const data = live.data;

  // Flash a tile green / red when its figure moved since the previous fetch of the same range
  // (derived from the new payload during render, so no extra effect pass).
  if (data && data !== seen.data) {
    const key = `${data.range.start}|${data.range.end}`;
    const cur = data.periods.current.totals;
    const totals: Record<LiveMetric, number> = { sales: cur.sales, gcs: cur.gcs, avg_check: cur.avg_check, qty: cur.qty };
    const next: Partial<Record<LiveMetric, Flash>> = {};
    if (seen.totals && seen.key === key) {
      for (const m of METRICS) {
        if (totals[m.key] !== seen.totals[m.key]) next[m.key] = totals[m.key] > seen.totals[m.key] ? "up" : "down";
      }
    }
    setSeen({ data, key, totals });
    if (Object.keys(next).length) setFlash(next);
  }

  useEffect(() => {
    try {
      localStorage.setItem("sb-live-preset", JSON.stringify(preset));
      localStorage.setItem("sb-live-custom", JSON.stringify(custom));
      localStorage.setItem("sb-live-range", JSON.stringify(range)); // read by the voice assistant
      localStorage.setItem("sb-live-interval", JSON.stringify(intervalSec));
    } catch {
      /* ignore */
    }
  }, [preset, custom, range.start, range.end, intervalSec]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tick flash lasts a moment, then the tile settles back.
  const flashing = Object.keys(flash).length > 0;
  useEffect(() => {
    if (!flashing) return;
    const id = window.setTimeout(() => setFlash({}), 1600);
    return () => window.clearTimeout(id);
  }, [flashing, flash]);

  const refreshNow = () => {
    setTick((t) => t + 1);
    restart();
  };

  const labels = periodLabels(range, data?.days ?? (range.start === range.end ? 1 : 2));
  const currentLabel = currentLabelFor(range);
  const invalidDraft = !validRange(draft);
  const noSalesYet = !!data && data.periods.current.totals.gcs === 0 && data.periods.current.totals.return_count === 0;

  const chartRows = useMemo(() => {
    if (!data) return [];
    const pick = (p: LivePeriodKey, pt: LiveCompareData["points"][number]) => (chartMetric === "sales" ? pt[p] : pt[`${p}_gcs`]);
    return data.points.map((pt) => ({
      label: pt.label,
      dates: pt.dates,
      current: pick("current", pt),
      previous: pick("previous", pt),
      last_week: pick("last_week", pt),
    }));
  }, [data, chartMetric]);
  const chartSeries = [
    { key: "current", name: currentLabel, color: "var(--series-1)" },
    { key: "previous", name: labels.previous, color: "var(--ink-3)", dashed: true },
    { key: "last_week", name: labels.last_week, color: "var(--series-2)", dashed: true },
  ];
  const chartFmt = chartMetric === "sales" ? (v: number) => pkr(v) : (v: number) => `${num(v)} checks`;

  const th = "py-1.5 font-medium";

  return (
    <section id={sectionId("live")} className="card scroll-mt-4 p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span className={`live-dot ${intervalSec ? "live-dot-on" : ""}`} aria-hidden="true" />
            Today vs Yesterday vs Last Week Same Day Analysis
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            {currentLabel} vs {labels.previous.toLowerCase()} and {labels.last_week.toLowerCase()} · net sales, GCS and average check from POS checks
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Live board date" className="flex rounded-lg border border-line bg-surface p-0.5">
            {(
              [
                { id: "today", label: "Today" },
                { id: "yesterday", label: "Yesterday" },
                { id: "custom", label: "Pick date" },
              ] as { id: LivePreset; label: string }[]
            ).map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={preset === p.id}
                onClick={() => {
                  setPreset(p.id);
                  if (p.id === "custom") setDraft(custom);
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${preset === p.id ? "bg-accent text-white shadow-sm" : "text-ink-2 hover:bg-surface-2"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!invalidDraft) setCustom(draft);
              }}
            >
              <input type="date" value={draft.start} max={draft.end} onChange={(e) => setDraft({ ...draft, start: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink" aria-label="Live board start date" />
              <span className="text-xs text-ink-3">to</span>
              <input type="date" value={draft.end} min={draft.start} onChange={(e) => setDraft({ ...draft, end: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink" aria-label="Live board end date" />
              <button type="submit" disabled={invalidDraft} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                Apply
              </button>
            </form>
          )}
          <AutoRefreshControl
            value={intervalSec}
            options={INTERVAL_OPTIONS}
            onChange={(v) => {
              setIntervalSec(v);
              restart();
            }}
            title="Poll ERPNext for new checks on this interval (paused while the tab is hidden)"
          />
          <button
            onClick={refreshNow}
            disabled={live.loading || live.refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
            title="Fetch the latest checks from ERPNext now"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={live.refreshing ? "animate-spin" : ""}>
              <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
            </svg>
            Refresh
          </button>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
        <span className="tnum">
          {live.fetchedAt ? `Updated ${fmtTime(live.fetchedAt)}` : "Loading…"}
          {live.refreshing ? " · refreshing…" : ""}
          {live.error && data ? ` · last refresh failed: ${live.error}` : ""}
        </span>
        <span className="flex items-center gap-3">
          <RefreshCountdown nextAt={nextAt} intervalSec={intervalSec} />
          <SourceBadge source={data?.source} />
        </span>
      </div>

      {live.error && !data ? (
        <ErrorState message={live.error} onRetry={onRetry} />
      ) : !data ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {TILES.map((m) => (
            <Skeleton key={m.key} className="h-32" />
          ))}
        </div>
      ) : (
        <div className={`transition-opacity ${live.refreshing ? "opacity-70" : ""}`}>
          {noSalesYet && (
            <div className="mb-3 rounded-md border border-warn/40 bg-surface-2 px-3 py-2 text-xs text-ink-2">
              <span className="font-medium text-warn">No checks recorded for {currentLabel.toLowerCase()} yet.</span>
              {data.last_trading_day ? ` Last sale on ${fmtDate(data.last_trading_day)}.` : ""} The comparison periods are shown for reference.
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {TILES.map((m) => {
              const cur = data.periods.current.totals[m.key];
              const f = flash[m.key];
              const sparkKey = m.key === "gcs" ? "_gcs" : "";
              return (
                <div key={m.key} className={`rounded-xl border border-line p-3 ${f === "up" ? "tick-up" : f === "down" ? "tick-down" : ""}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{m.label}</div>
                      <div className="tnum mt-0.5 truncate text-2xl font-semibold leading-tight text-ink" title={m.fmt(cur)}>
                        {m.fmt(cur)}
                      </div>
                      <div className="text-[11px] text-ink-3">{m.hint}</div>
                    </div>
                    {m.key !== "avg_check" && (
                      <Spark
                        series={[
                          { values: data.points.map((p) => p[`current${sparkKey}` as "current" | "current_gcs"]), color: "var(--series-1)" },
                          { values: data.points.map((p) => p[`previous${sparkKey}` as "previous" | "previous_gcs"]), color: "var(--ink-3)", dashed: true },
                        ]}
                      />
                    )}
                  </div>
                  <div className="mt-3 flex flex-col gap-1.5 border-t border-line/60 pt-2">
                    <CompareLine label={labels.previous} value={data.periods.previous.totals[m.key]} delta={data.deltas.previous[m.key]} def={m} />
                    <CompareLine label={labels.last_week} value={data.periods.last_week.totals[m.key]} delta={data.deltas.last_week[m.key]} def={m} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="flex flex-col gap-2 lg:col-span-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-ink-3">
                  {data.granularity === "hour" ? "Running total through the day" : "Running total day by day"} · {fmtRange(range.start, range.end)}
                </span>
                <div role="tablist" aria-label="Chart metric" className="flex rounded-md border border-line bg-surface p-0.5">
                  {(["sales", "gcs"] as ChartMetric[]).map((k) => (
                    <button key={k} role="tab" aria-selected={chartMetric === k} onClick={() => setChartMetric(k)} className={`rounded px-2 py-0.5 text-[11px] font-medium ${chartMetric === k ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
                      {k === "sales" ? "Sales" : "GCS"}
                    </button>
                  ))}
                </div>
              </div>
              {chartRows.length ? (
                <MultiLineChart
                  data={chartRows}
                  series={chartSeries}
                  height={220}
                  format={chartFmt}
                  labelFormat={(l, e) => {
                    const d = (e?.payload as { dates?: Record<LivePeriodKey, string> } | undefined)?.dates;
                    return data.granularity === "hour" ? `${l}` : `${l} · ${fmtDate(d?.current)} vs ${fmtDate(d?.previous)} / ${fmtDate(d?.last_week)}`;
                  }}
                />
              ) : (
                <EmptyState title="No checks in any of the three periods" />
              )}
            </div>

            <table className="w-full self-start text-xs lg:col-span-2">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                  <th className={th}>Metric</th>
                  <th className={`${th} text-right`}>{currentLabel}</th>
                  <th className={`${th} text-right`}>{labels.previous}</th>
                  <th className={`${th} text-right`}>Δ</th>
                  <th className={`${th} text-right`}>{labels.last_week}</th>
                  <th className={`${th} text-right`}>Δ</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {METRICS.map((m) => (
                  <tr key={m.key} className="border-b border-line/60">
                    <td className="py-1.5 text-ink-2">{m.label}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{m.fmt(data.periods.current.totals[m.key])}</td>
                    <td className="py-1.5 text-right text-ink-2">{m.fmt(data.periods.previous.totals[m.key])}</td>
                    <td className="py-1.5 text-right">
                      <DeltaBadge delta={data.deltas.previous[m.key]} />
                    </td>
                    <td className="py-1.5 text-right text-ink-2">{m.fmt(data.periods.last_week.totals[m.key])}</td>
                    <td className="py-1.5 text-right">
                      <DeltaBadge delta={data.deltas.last_week[m.key]} />
                    </td>
                  </tr>
                ))}
                {(data.periods.current.totals.return_count > 0 || data.periods.previous.totals.return_count > 0 || data.periods.last_week.totals.return_count > 0) && (
                  <tr className="border-b border-line/60">
                    <td className="py-1.5 text-ink-2">Returns</td>
                    {(["current", "previous", "last_week"] as LivePeriodKey[]).map((p, i) => (
                      <td key={p} className={`py-1.5 text-right text-ink-2 ${i > 0 ? "" : ""}`} colSpan={i === 0 ? 1 : 2}>
                        {pkr(data.periods[p].totals.returns_total)} · {num(data.periods[p].totals.return_count)}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} className="pt-2 text-[11px] text-ink-3">
                    {currentLabel}: {fmtRange(data.periods.current.range.start, data.periods.current.range.end)} · {labels.previous}: {fmtRange(data.periods.previous.range.start, data.periods.previous.range.end)} · {labels.last_week}: {fmtRange(data.periods.last_week.range.start, data.periods.last_week.range.end)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
