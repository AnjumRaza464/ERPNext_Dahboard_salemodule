"use client";

import { useApi } from "@/hooks/useApi";
import { fmtDate, fmtPeriod, fmtRange, num, pct, pkr } from "@/lib/format";
import type { CompareBreakdown, CompareMode, CompareTotals, Range, SalesCompare } from "@/lib/types";
import Card from "./Card";
import DeltaText from "./DeltaText";
import GroupedColumns from "./charts/GroupedColumns";
import MultiLineChart from "./charts/MultiLineChart";
import { useState } from "react";

export const DATA_FROM = "2026-04-16";

export const MODES: { id: CompareMode; label: string; short: string; hint: string }[] = [
  { id: "previous", label: "Previous period", short: "Previous period", hint: "the same number of days immediately before the selected range" },
  { id: "last_week", label: "Same days last week", short: "Last week", hint: "the same dates one week earlier (weekday-aligned)" },
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
  { label: "Net sales", key: "net_sales", fmt: (v) => pkr(v) },
  { label: "Bills", key: "checks", fmt: (v) => num(v) },
  { label: "Avg bill", key: "avg_check", fmt: (v) => pkr(v) },
  { label: "Qty sold", key: "total_qty", fmt: (v) => num(v) },
  { label: "Qty per bill", key: "items_per_check", fmt: (v) => num(v, 1) },
  { label: "Trading days", key: "active_days", fmt: (v) => num(v) },
  { label: "Avg per trading day", key: "avg_per_day", fmt: (v) => pkr(v) },
  { label: "Returns", key: "returns_total", fmt: (v) => pkr(v), invert: true },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when "same period last year" would fall before the first bill in ERPNext. */
export function lastYearUnavailable(range: Range): boolean {
  const y = Number(range.start.slice(0, 4)) - 1;
  return `${y}${range.start.slice(4)}` < DATA_FROM;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
  mode: CompareMode;
  onModeChange: (mode: CompareMode) => void;
  custom: Range;
  onCustomChange: (range: Range) => void;
}

/**
 * Sales comparison block: the selected range against another period (previous period, the
 * same days last week, last year, or any custom period), on bills: KPIs side by side with a
 * traffic-vs-spend attribution, daily or cumulative curves, and where the difference came
 * from (top and low items, item groups).
 */
export default function SalesComparison({ range, refreshKey, onRetry, mode, onModeChange, custom, onCustomChange }: Props) {
  const [draft, setDraft] = useState<Range>(custom);
  const [view, setView] = useState<View>("daily");
  const [seenCustom, setSeenCustom] = useState(custom);
  if (custom !== seenCustom) {
    setSeenCustom(custom);
    setDraft(custom);
  }

  const extra: Record<string, string | number> = mode === "custom" ? { mode, cmp_start: custom.start, cmp_end: custom.end } : { mode };
  const cmp = useApi<SalesCompare>("/api/sales/compare", range, refreshKey, extra);
  const br = useApi<CompareBreakdown>("/api/sales/compare-breakdown", range, refreshKey, { ...extra, limit: 8 });

  const modeDef = MODES.find((m) => m.id === mode)!;
  const cmpName = modeDef.short;
  const cmpRange = cmp.data ? fmtRange(cmp.data.previous_range.start, cmp.data.previous_range.end) : undefined;
  const invalid = draft.start > draft.end || !ISO_DATE.test(draft.start) || !ISO_DATE.test(draft.end);
  const noLastYear = lastYearUnavailable(range);

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

  const attribution = cmp.data?.attribution ?? null;
  const itemFormat = (v: number, e: { dataKey?: string | number; payload?: Record<string, unknown> }) =>
    `${pkr(v)} · ${num(Number(e.dataKey === "current" ? e.payload?.current_qty : e.payload?.previous_qty))} qty`;
  const itemLabel = (l: string | number, e?: { payload?: Record<string, unknown> }) => `${l} · ${pct(Number(e?.payload?.delta_pct ?? NaN))}`;

  const modeControl = (
    <div role="tablist" aria-label="Compare against" className="flex flex-wrap rounded-lg border border-line bg-surface p-0.5">
      {MODES.map((m) => {
        const disabled = m.id === "last_year" && noLastYear;
        return (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            disabled={disabled}
            title={disabled ? `Data starts ${fmtDate(DATA_FROM)}, so last year is not available yet` : m.hint}
            onClick={() => onModeChange(m.id)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${mode === m.id ? "bg-accent text-white shadow-sm" : "text-ink-2 hover:bg-surface-2"}`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-2">Compare against</span>
          {modeControl}
          <span className="text-[11px] text-ink-3">applies to the KPI tiles, this block and the product mix</span>
        </div>
        {mode === "custom" && (
          <form
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!invalid) onCustomChange(draft);
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
              <div className="flex flex-col gap-2 lg:col-span-2">
                <table className="w-full self-start text-xs">
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
                      const cur = cmp.data!.current[r.key] as number;
                      const prev = cmp.data!.previous[r.key] as number;
                      if (r.key === "returns_total" && !cur && !prev) return null;
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
                {attribution && (
                  <p className="tnum text-[11px] text-ink-2" title="traffic effect = change in bills × previous avg bill; spend effect = change in avg bill × this period's bills">
                    Sales <DeltaText value={cmp.data.delta_pct} />: {attribution.traffic_pct !== null && attribution.traffic_pct >= 0 ? "zyada bill" : "kam bill"} (<DeltaText value={attribution.traffic_pct} />, {pkr(attribution.traffic_effect, { sign: true })}) aur {attribution.spend_pct !== null && attribution.spend_pct >= 0 ? "bade bill" : "chhote bill"} (<DeltaText value={attribution.spend_pct} />, {pkr(attribution.spend_effect, { sign: true })})
                  </p>
                )}
                {cmp.data.current.excluded_days.length > 0 && (
                  <p className="text-[11px] text-ink-3">Averages leave out bulk-entry days ({cmp.data.current.excluded_days.map((d) => fmtDate(d)).join(", ")}); totals include them.</p>
                )}
              </div>

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
        title="Top Items: This vs Comparison"
        subtitle={br.data ? `Top ${br.data.top_items.length} items of this period${br.data.new_items ? ` · ${br.data.new_items} not sold in the ${cmpName.toLowerCase()}` : ""}` : undefined}
        source={br.data?.source}
        loading={br.loading}
        refreshing={br.refreshing}
        error={br.error}
        empty={!!br.data && br.data.top_items.length === 0}
        onRetry={onRetry}
      >
        {br.data && <GroupedColumns rows={br.data.top_items.map((r) => ({ ...r }))} names={["This period", cmpName]} layout="vertical" format={itemFormat} labelFormat={itemLabel} />}
      </Card>

      <Card
        title="Low Items: This vs Comparison"
        subtitle={
          br.data
            ? `Lowest ${br.data.bottom_items.length} selling items of this period${br.data.dropped_items ? ` · ${br.data.dropped_items} sold in the ${cmpName.toLowerCase()} but not in this one` : ""}`
            : undefined
        }
        source={br.data?.source}
        loading={br.loading}
        refreshing={br.refreshing}
        error={br.error}
        empty={!!br.data && br.data.bottom_items.length === 0}
        emptyHint="No items sold in this period"
        onRetry={onRetry}
      >
        {br.data && <GroupedColumns rows={br.data.bottom_items.map((r) => ({ ...r }))} names={["This period", cmpName]} layout="vertical" format={itemFormat} labelFormat={itemLabel} />}
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
        className="lg:col-span-2"
        height={200}
      >
        {br.data && <GroupedColumns rows={br.data.item_groups.slice(0, 8).map((r) => ({ ...r }))} names={["This period", cmpName]} layout="vertical" format={itemFormat} labelFormat={itemLabel} height={Math.max(160, br.data.item_groups.slice(0, 8).length * 40 + 40)} />}
      </Card>
    </div>
  );
}
