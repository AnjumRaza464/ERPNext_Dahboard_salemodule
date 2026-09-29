"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { toIso } from "@/lib/dates";
import { fmtDate, fmtPeriod, fmtRange, num, pct, pkr } from "@/lib/format";
import type { CompareBreakdown, CompareMode, CompareTotals, Range, SalesCompare } from "@/lib/types";
import type { CompareCommand } from "@/lib/voice";
import Card from "./Card";
import GroupedColumns from "./charts/GroupedColumns";
import HorizontalBars from "./charts/HorizontalBars";
import MultiLineChart from "./charts/MultiLineChart";

const MODES: { id: CompareMode; label: string; short: string; hint: string }[] = [
  { id: "previous", label: "Previous period", short: "Previous period", hint: "the same number of days immediately before the selected range" },
  { id: "last_year", label: "Same period last year", short: "Last year", hint: "the same dates one year earlier" },
  { id: "custom", label: "Custom period", short: "Comparison period", hint: "any two dates you choose" },
];

type View = "daily" | "cumulative";

interface KpiRowDef {
  label: string;
  key: keyof CompareTotals;
  fmt: (v: number) => string;
  /** a rise is bad (returns) */
  invert?: boolean;
}

const KPI_ROWS: KpiRowDef[] = [
  { label: "Total sales", key: "total_sales", fmt: (v) => pkr(v) },
  { label: "Invoices", key: "invoice_count", fmt: (v) => num(v) },
  { label: "Avg invoice value", key: "avg_invoice_value", fmt: (v) => pkr(v) },
  { label: "Qty sold", key: "total_qty", fmt: (v) => num(v) },
  { label: "Qty per invoice", key: "avg_qty_per_invoice", fmt: (v) => num(v, 1) },
  { label: "Active days", key: "active_days", fmt: (v) => num(v) },
  { label: "Avg per active day", key: "avg_per_day", fmt: (v) => pkr(v) },
  { label: "Returns", key: "returns_total", fmt: (v) => pkr(v), invert: true },
];

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

function DeltaText({ value, invert }: { value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="text-ink-3">—</span>;
  const positive = invert ? value < 0 : value > 0;
  const negative = invert ? value > 0 : value < 0;
  return <span className={`font-medium ${positive ? "text-good" : negative ? "text-bad" : "text-ink-3"}`}>{pct(value)}</span>;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
  /** set by the voice assistant; a new nonce switches the mode (and custom period) */
  command?: CompareCommand;
}

/**
 * Sales comparison block: pick what to compare the selected range against
 * (previous period / same period last year / any custom period), then see the
 * KPIs side by side, the daily or cumulative curves, and where the difference
 * came from (item groups, items, weekdays, biggest movers).
 */
export default function SalesComparison({ range, refreshKey, onRetry, command }: Props) {
  const [mode, setMode] = useState<CompareMode>(() => readStored<CompareMode>("sb-cmp-mode", "previous"));
  const [custom, setCustom] = useState<Range>(() => {
    const stored = readStored<Range | null>("sb-cmp-range", null);
    return stored && ISO_DATE.test(stored.start) && ISO_DATE.test(stored.end) && stored.start <= stored.end ? stored : defaultCustom(range);
  });
  const [draft, setDraft] = useState<Range>(custom);
  const [view, setView] = useState<View>("daily");
  const [seenCommand, setSeenCommand] = useState(command?.nonce);

  // Apply a new voice command during render (React's "adjust state on prop change" pattern).
  if (command && command.nonce !== seenCommand) {
    setSeenCommand(command.nonce);
    setMode(command.mode);
    if (command.range) {
      setCustom(command.range);
      setDraft(command.range);
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem("sb-cmp-mode", JSON.stringify(mode));
      localStorage.setItem("sb-cmp-range", JSON.stringify(custom));
    } catch {
      /* ignore */
    }
  }, [mode, custom]);

  const extra: Record<string, string | number> = mode === "custom" ? { mode, cmp_start: custom.start, cmp_end: custom.end } : { mode };
  const cmp = useApi<SalesCompare>("/api/sales/compare", range, refreshKey, extra);
  const br = useApi<CompareBreakdown>("/api/sales/compare-breakdown", range, refreshKey, { ...extra, limit: 8 });

  const modeDef = MODES.find((m) => m.id === mode)!;
  const cmpName = modeDef.short;
  const cmpRange = cmp.data ? fmtRange(cmp.data.previous_range.start, cmp.data.previous_range.end) : undefined;
  const invalid = draft.start > draft.end || !ISO_DATE.test(draft.start) || !ISO_DATE.test(draft.end);

  const rows = cmp.data
    ? cmp.data.points.map((p) => ({
        ...p,
        label: p.period ? fmtPeriod(p.period, cmp.data!.granularity) : `#${p.index}`,
      }))
    : [];
  const series =
    view === "daily"
      ? [
          { key: "current", name: "This period", color: "var(--series-1)" },
          { key: "previous", name: cmpName, color: "var(--ink-3)", dashed: true },
        ]
      : [
          { key: "current_cum", name: "This period (cumulative)", color: "var(--series-1)" },
          { key: "previous_cum", name: `${cmpName} (cumulative)`, color: "var(--ink-3)", dashed: true },
        ];

  const movers = br.data ? [...br.data.gainers.slice(0, 5), ...br.data.losers.slice(0, 5).reverse()].sort((a, b) => b.delta_abs - a.delta_abs) : [];

  const modeControl = (
    <div role="tablist" aria-label="Compare against" className="flex flex-wrap rounded-lg border border-line bg-surface p-0.5">
      {MODES.map((m) => (
        <button
          key={m.id}
          role="tab"
          aria-selected={mode === m.id}
          title={m.hint}
          onClick={() => setMode(m.id)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${mode === m.id ? "bg-accent text-white shadow-sm" : "text-ink-2 hover:bg-surface-2"}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-2">Compare against</span>
          {modeControl}
        </div>
        {mode === "custom" && (
          <form
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!invalid) setCustom(draft);
            }}
          >
            <span className="text-xs text-ink-2">Compare with</span>
            <input type="date" value={draft.start} max={draft.end} onChange={(e) => setDraft({ ...draft, start: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink" aria-label="Comparison start date" />
            <span className="text-xs text-ink-3">to</span>
            <input type="date" value={draft.end} min={draft.start} onChange={(e) => setDraft({ ...draft, end: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink" aria-label="Comparison end date" />
            <button type="submit" disabled={invalid} className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40">
              Apply
            </button>
            {invalid && <span className="text-xs text-bad">Pick two valid dates, start before end</span>}
            {cmp.data && cmp.data.granularity === "month" && <span className="text-xs text-ink-3">Long ranges are compared month by month</span>}
          </form>
        )}
      </div>

      <Card
        title="Sales Comparison"
        subtitle={
          cmp.data
            ? `${fmtRange(range.start, range.end)} vs ${cmpRange} · ${pkr(cmp.data.current_total)} vs ${pkr(cmp.data.previous_total)} · ${cmp.data.delta_pct !== null ? pct(cmp.data.delta_pct) : "no comparison sales"} (${pkr(cmp.data.delta_abs, { sign: true })})`
            : `Compare the selected range against ${modeDef.hint}`
        }
        source={cmp.data?.source}
        loading={cmp.loading}
        refreshing={cmp.refreshing}
        error={cmp.error}
        onRetry={onRetry}
        className="lg:col-span-2"
        height={300}
      >
        <div className="flex flex-col gap-4">

          {cmp.data && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
              <table className="w-full self-start text-xs lg:col-span-2">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Metric</th>
                    <th className={`${th} text-right`}>This period</th>
                    <th className={`${th} text-right`}>{cmpName}</th>
                    <th className={`${th} text-right`}>Change</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {KPI_ROWS.map((r) => {
                    const cur = cmp.data!.current[r.key];
                    const prev = cmp.data!.previous[r.key];
                    return (
                      <tr key={r.key} className="border-b border-line/60">
                        <td className="py-1.5 text-ink-2">{r.label}</td>
                        <td className="py-1.5 text-right font-medium text-ink">{r.fmt(cur)}</td>
                        <td className="py-1.5 text-right text-ink-2">{r.fmt(prev)}</td>
                        <td className="py-1.5 text-right">
                          <DeltaText value={cmp.data!.kpi_delta_pct[r.key]} invert={r.invert} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="flex flex-col gap-2 lg:col-span-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-ink-3">
                    {cmp.data.granularity === "day" ? "Day by day" : "Month by month"}, aligned by position · this period {fmtRange(range.start, range.end)} · {cmpName.toLowerCase()} {cmpRange}
                  </span>
                  <div role="tablist" aria-label="Chart view" className="flex rounded-md border border-line bg-surface p-0.5">
                    {(["daily", "cumulative"] as View[]).map((v) => (
                      <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`rounded px-2 py-0.5 text-[11px] font-medium ${view === v ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
                        {v === "daily" ? (cmp.data!.granularity === "day" ? "Daily" : "Monthly") : "Cumulative"}
                      </button>
                    ))}
                  </div>
                </div>
                <MultiLineChart
                  data={rows}
                  series={series}
                  height={250}
                  labelFormat={(_, e) => {
                    const p = e?.payload as { period?: string | null; previous_period?: string | null; label?: string } | undefined;
                    if (cmp.data!.granularity === "day") return `${fmtDate(p?.period)} vs ${fmtDate(p?.previous_period)}`;
                    return `${p?.label ?? ""} vs ${p?.previous_period ? fmtPeriod(p.previous_period, "month") : "—"}`;
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Item Groups: This vs Comparison"
        subtitle={br.data ? `Sales value per item group · ${cmpName.toLowerCase()} ${cmpRange ?? ""}` : undefined}
        source={br.data?.source}
        loading={br.loading}
        refreshing={br.refreshing}
        error={br.error}
        empty={!!br.data && br.data.item_groups.length === 0}
        onRetry={onRetry}
      >
        {br.data && (
          <GroupedColumns
            rows={br.data.item_groups.slice(0, 8).map((r) => ({ ...r }))}
            names={["This period", cmpName]}
            layout="vertical"
            format={(v, e) => `${pkr(v)} · ${num(Number(e.dataKey === "current" ? e.payload?.current_qty : e.payload?.previous_qty))} qty`}
            labelFormat={(l, e) => `${l} · ${pct(Number(e?.payload?.delta_pct ?? NaN))}`}
          />
        )}
      </Card>

      <Card
        title="Top Items: This vs Comparison"
        subtitle={br.data ? `Top ${br.data.top_items.length} items of this period${br.data.new_items ? ` · ${br.data.new_items} not sold in the ${cmpName.toLowerCase()}` : ""}` : undefined}
        source={br.data?.source}
        loading={br.loading}
        refreshing={br.refreshing}
        error={br.error}
        empty={!!br.data && br.data.top_items.length === 0}
        onRetry={onRetry}
      >
        {br.data && (
          <GroupedColumns
            rows={br.data.top_items.map((r) => ({ ...r }))}
            names={["This period", cmpName]}
            layout="vertical"
            format={(v, e) => `${pkr(v)} · ${num(Number(e.dataKey === "current" ? e.payload?.current_qty : e.payload?.previous_qty))} qty`}
            labelFormat={(l, e) => `${l} · ${pct(Number(e?.payload?.delta_pct ?? NaN))}`}
          />
        )}
      </Card>

      <Card
        title="Weekday Pattern: This vs Comparison"
        subtitle="Average sales per day of the week in each period"
        source={br.data?.source}
        loading={br.loading}
        refreshing={br.refreshing}
        error={br.error}
        empty={!!br.data && br.data.weekdays.every((w) => w.current === 0 && w.previous === 0)}
        onRetry={onRetry}
      >
        {br.data && (
          <GroupedColumns
            rows={br.data.weekdays.map((r) => ({ ...r }))}
            names={["This period", cmpName]}
            format={(v, e) => `${pkr(v)}/day · ${pkr(Number(e.dataKey === "current" ? e.payload?.current_total : e.payload?.previous_total))} total`}
            labelFormat={(l, e) => `${l} · ${pct(Number(e?.payload?.delta_pct ?? NaN))}`}
          />
        )}
      </Card>

      <Card
        title="Biggest Movers"
        subtitle={br.data ? `Items with the largest gain or drop in sales value vs the ${cmpName.toLowerCase()}` : undefined}
        source={br.data?.source}
        loading={br.loading}
        refreshing={br.refreshing}
        error={br.error}
        empty={!!br.data && movers.length === 0}
        onRetry={onRetry}
      >
        {br.data && (
          <HorizontalBars
            rows={movers.map((m) => ({ label: m.label, value: m.delta_abs, current: m.current, previous: m.previous, delta_pct: m.delta_pct }))}
            colorFor={(r) => (r.value >= 0 ? "var(--series-1)" : "var(--neg)")}
            format={(v, e) => `${pkr(v, { sign: true })} (${pct(Number(e.payload?.delta_pct ?? NaN))}) · ${pkr(Number(e.payload?.current))} vs ${pkr(Number(e.payload?.previous))}`}
            seriesName="Change"
            height={Math.max(180, movers.length * 30 + 24)}
          />
        )}
      </Card>
    </div>
  );
}
