"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import { fmtDate, fmtPeriod, fmtRange, num, pkr } from "@/lib/format";
import type { CostingStoreIssues, IssuedItem, IssueTarget, Range, StoreIssueDayRow, StoreIssueEntry } from "@/lib/types";
import Card from "./Card";
import DeltaText from "./DeltaText";
import ExportButtons from "./ExportButtons";
import StackedColumns from "./charts/StackedColumns";
import TableFilter from "./TableFilter";
import ViewToggle from "./ViewToggle";
import WeekdayFilter from "./WeekdayFilter";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

type View = "daily" | "items" | "entries";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

/** "Icing Department" -> "Icing"; "Sindh Bakery - Outlet 1 (FG)" -> "Outlet 1 (FG)". */
function short(label: string): string {
  return label.replace(/\s+Department$/i, "").replace(/^Sindh Bakery\s*-\s*/i, "");
}

function matches(query: string) {
  const q = query.trim().toLowerCase();
  return (r: { item_name: string; item_code: string }) => !q || r.item_name.toLowerCase().includes(q) || r.item_code.toLowerCase().includes(q);
}

/** Issued minus consumed: grey when it nets to (almost) nothing, amber when material is left over, red when more was used than issued. */
function varianceTone(v: number | null, base: number): string {
  if (v === null) return "text-ink-3";
  if (Math.abs(v) <= Math.max(1, Math.abs(base) * 0.01)) return "text-ink-3";
  return v > 0 ? "text-warn" : "text-bad";
}

/**
 * What the Stores warehouse issued (Material Transfer): the per-destination summary against what each department
 * then consumed and still holds, then day by day, every item per destination, or every transfer entry.
 */
export default function StoreIssueDetail({ range, refreshKey, onRetry }: Props) {
  const [days, setDays] = useState<string[]>([]);
  const q = useApi<CostingStoreIssues>("/api/costing/store-issues", range, refreshKey, { limit: 0, ...(days.length ? { weekdays: days.join(",") } : {}) });
  const [view, setView] = useState<View>("daily");
  const [target, setTarget] = useState<string | null>(null);
  const [itemQuery, setItemQuery] = useState("");
  const d = q.data;
  const targets = d?.targets.map((x) => x.target) ?? [];
  const active = target && targets.includes(target) ? target : targets[0];
  const activeInfo = d?.targets.find((x) => x.target === active);
  const gran = d?.granularity ?? "day";
  const keys = targets.map(short);
  const targetItems = d && active ? d.items[active] ?? [] : [];
  const shownItems = targetItems.filter(matches(itemQuery));
  const dayRows = d ? d.daily.map((r) => ({ label: fmtPeriod(r.period, gran), weekday: r.weekday, entries: r.entries, total: r.total, consumed: r.consumed, ...Object.fromEntries(targets.map((k) => [short(k), r.by_target[k] ?? 0])) })) : [];
  const tickEvery = dayRows.length > 40 ? 4 : dayRows.length > 20 ? 2 : 1;

  const summaryCols: CsvColumn<IssueTarget>[] = [
    { key: "target", header: "Issued to", value: (r) => r.target },
    { key: "amount", header: "Issued (PKR)", value: (r) => r.amount },
    { key: "share", header: "Share %", value: (r) => r.share_pct },
    { key: "qty", header: "Issued qty", value: (r) => r.qty },
    { key: "entries", header: "Entries", value: (r) => r.entries },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "active_days", header: "Active din", value: (r) => r.active_days },
    { key: "consumed", header: "Consumed in production (PKR)", value: (r) => r.consumed },
    { key: "variance", header: "Issued minus consumed (PKR)", value: (r) => r.variance },
    { key: "variance_qty", header: "Issued minus consumed qty", value: (r) => r.variance_qty },
    { key: "balance", header: "Stock there now (PKR)", value: (r) => r.balance_now },
    { key: "prev", header: "Previous (PKR)", value: (r) => r.prev_amount },
    { key: "delta", header: "Change %", value: (r) => r.delta_pct },
  ];
  const dailyCols: CsvColumn<StoreIssueDayRow>[] = [
    { key: "period", header: gran === "month" ? "Month" : "Date", value: (r) => r.period },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    ...targets.map((k) => ({ key: k, header: `${k} (PKR)`, value: (r: StoreIssueDayRow) => r.by_target[k] ?? 0 })),
    { key: "total", header: "Total issued (PKR)", value: (r) => r.total },
    { key: "to_departments", header: "To departments (PKR)", value: (r) => r.to_departments },
    { key: "consumed", header: "Consumed in production (PKR)", value: (r) => r.consumed },
    { key: "variance", header: "Issued minus consumed (PKR)", value: (r) => r.variance },
    { key: "entries", header: "Entries", value: (r) => r.entries },
  ];
  const itemCols: CsvColumn<IssuedItem>[] = [
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "qty", header: "Issued qty", value: (r) => r.qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "rate", header: "Avg rate", value: (r) => r.rate },
    { key: "amount", header: "Issued (PKR)", value: (r) => r.amount },
    { key: "share", header: "Share %", value: (r) => r.share_pct },
    { key: "consumed_qty", header: "Consumed qty", value: (r) => r.consumed_qty },
    { key: "variance_qty", header: "Issued minus consumed qty", value: (r) => r.variance_qty },
    { key: "entries", header: "Entries", value: (r) => r.entries },
  ];
  const allItemCols: CsvColumn<IssuedItem & { target: string }>[] = [{ key: "target", header: "Issued to", value: (r) => r.target }, ...itemCols];
  const entryCols: CsvColumn<StoreIssueEntry>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    { key: "weekday", header: "Weekday", value: (r) => r.weekday },
    { key: "name", header: "Entry", value: (r) => r.name },
    { key: "target", header: "Issued to", value: (r) => r.target },
    { key: "amount", header: "Issued (PKR)", value: (r) => r.amount },
    { key: "qty", header: "Qty", value: (r) => r.qty },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "groups", header: "Item groups", value: (r) => r.groups },
  ];
  const stem = `${range.start}-${range.end}`;
  const scope = `${fmtRange(range.start, range.end)}${days.length ? ` · ${days.join(", ")} only` : ""}`;

  const exportView = () => {
    if (!d) return;
    if (view === "daily") exportTable("csv", `store-issue-daily-${stem}`, d.daily, dailyCols);
    else if (view === "items" && active) exportTable("csv", `store-issue-${short(active).toLowerCase().replace(/\s+/g, "-")}-${stem}`, shownItems, itemCols);
    else exportTable("csv", `store-issue-entries-${stem}`, d.entries, entryCols);
  };
  const exportWorkbook = () => {
    if (!d) return;
    const all = targets.flatMap((k) => (d.items[k] ?? []).map((r) => ({ ...r, target: k })));
    void downloadWorkbook(`store-issue-${stem}.xlsx`, [
      { name: "Summary", title: "Store Issue · Summary", subtitle: `${scope} · ${pkr(d.total)} issued from ${d.store} · ${pkr(d.to_departments)} to departments, ${pkr(d.consumed_total)} consumed in production · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}`, columns: summaryCols, rows: d.targets, totals: true, noTotal: ["active_days", "items", "balance"] },
      { name: gran === "month" ? "Month-wise" : "Day-wise", title: `Store Issue · ${gran === "month" ? "Month" : "Day"}-wise`, subtitle: `${scope} · issued per ${gran === "month" ? "month" : "day"} by destination against production consumption, PKR`, columns: dailyCols, rows: d.daily, totals: true },
      { name: "Items", title: "Items issued by destination", subtitle: `${scope} · every item, with what the department consumed of it`, columns: allItemCols, rows: all, totals: true },
      { name: "Entries", title: "Transfer entries out of Stores", subtitle: `${scope} · ${num(d.entries.length)} of ${num(d.entries_total)} entries`, columns: entryCols, rows: d.entries, totals: true },
    ]);
  };
  const onExport = (fmt: ExportFormat) => (fmt === "xlsx" ? exportWorkbook() : exportView());

  return (
    <Card
      title="Store Issue · Detail"
      subtitle={
        d
          ? `${pkr(d.total)} issued from ${d.store} in ${num(d.entries_total)} transfer entries · ${pkr(d.to_departments)} to departments vs ${pkr(d.consumed_total)} consumed in production${d.to_other ? ` · ${pkr(d.to_other)} straight to the outlet` : ""} · change vs ${fmtRange(d.previous_range.start, d.previous_range.end)}`
          : undefined
      }
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && d.targets.length === 0}
      emptyHint="No Material Transfer entries out of Stores in this range."
      onRetry={onRetry}
      height={240}
      action={
        <div className="flex items-center gap-2">
          <ViewToggle value={view} options={[{ id: "daily", label: gran === "month" ? "Month-wise" : "Day-wise" }, { id: "items", label: "Items" }, { id: "entries", label: "Entries" }]} onChange={setView} />
          {d && <ExportButtons onExport={onExport} />}
        </div>
      }
    >
      {d && (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr className={thead}>
                  <th className={th}>Issued to</th>
                  <th className={`${th} text-right`}>Issued</th>
                  <th className={`${th} text-right`}>Share</th>
                  <th className={`${th} text-right`}>Entries</th>
                  <th className={`${th} text-right`}>Items</th>
                  <th className={`${th} text-right`}>Consumed</th>
                  <th className={`${th} text-right`}>Issued − used</th>
                  <th className={`${th} text-right`}>Qty diff</th>
                  <th className={`${th} text-right`}>Stock there now</th>
                  <th className={`${th} text-right`}>Previous</th>
                  <th className={`${th} text-right`}>vs prev</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {d.targets.map((r, i) => (
                  <tr key={r.target} className="border-b border-line/60">
                    <td className="py-1.5 text-ink">
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: SERIES[i % SERIES.length] }} />
                      {r.target}
                      {!r.is_department && <span className="ml-1 text-[10px] text-ink-3">not a production department</span>}
                    </td>
                    <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                    <td className={tdNum}>{r.share_pct}%</td>
                    <td className={tdNum}>{num(r.entries)}</td>
                    <td className={tdNum}>{num(r.items)}</td>
                    <td className={tdNum}>{r.consumed === null ? <span className="text-ink-3">—</span> : pkr(r.consumed)}</td>
                    <td className={`py-1.5 text-right font-medium ${varianceTone(r.variance, r.amount)}`} title="issued value minus the value consumed in production; small differences come from valuation rates">
                      {r.variance === null ? "—" : pkr(r.variance, { sign: true })}
                    </td>
                    <td className={`py-1.5 text-right ${varianceTone(r.variance_qty, r.qty)}`} title="issued quantity minus consumed quantity">{r.variance_qty === null ? "—" : num(r.variance_qty, 2)}</td>
                    <td className={tdNum}>{pkr(r.balance_now)}</td>
                    <td className={tdNum}>{pkr(r.prev_amount)}</td>
                    <td className="py-1.5 text-right"><DeltaText value={r.delta_pct} invert /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <WeekdayFilter value={days} onChange={setDays} />

          {view === "daily" && (
            <div className="flex flex-col gap-3">
              <StackedColumns
                rows={dayRows}
                keys={keys}
                height={260}
                tickEvery={tickEvery}
                labelFormat={(label, e) => `${label}${e?.payload?.weekday ? ` (${e.payload.weekday})` : ""} · issued ${pkr(Number(e?.payload?.total ?? 0))} · consumed ${pkr(Number(e?.payload?.consumed ?? 0))} · ${num(Number(e?.payload?.entries ?? 0))} entries`}
              />
              <div className="max-h-[360px] overflow-auto">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>{gran === "month" ? "Month" : "Date"}</th>
                      {keys.map((k) => (
                        <th key={k} className={`${th} text-right`}>{k}</th>
                      ))}
                      <th className={`${th} text-right`}>Total PKR</th>
                      <th className={`${th} text-right`}>Consumed</th>
                      <th className={`${th} text-right`}>Issued − used</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {d.daily.map((r) => (
                      <tr key={r.period} className={`border-b border-line/60 ${r.total === 0 ? "text-ink-3" : ""}`}>
                        <td className="whitespace-nowrap py-1 text-ink">
                          {fmtPeriod(r.period, gran)} <span className="text-[10px] text-ink-3">{gran === "day" ? r.weekday : ""}</span>
                        </td>
                        {targets.map((k) => (
                          <td key={k} className={tdNum}>{r.by_target[k] ? num(r.by_target[k]) : <span className="text-ink-3">—</span>}</td>
                        ))}
                        <td className={`py-1 text-right font-medium ${r.total ? "text-ink" : "text-ink-3"}`} title={`${num(r.entries)} entries`}>{r.total ? num(r.total) : "no issue"}</td>
                        <td className={tdNum}>{r.consumed ? num(r.consumed) : "—"}</td>
                        <td className={`py-1 text-right ${varianceTone(r.total || r.consumed ? r.variance : null, r.to_departments)}`}>{r.total || r.consumed ? pkr(r.variance, { sign: true }).replace("PKR ", "") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Figures in PKR. Issued − used compares what went to the production departments that {gran === "month" ? "month" : "day"} with what production consumed; issues straight to the outlet are not part of it.</p>
            </div>
          )}

          {view === "items" && active && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <ViewToggle value={active} options={targets.map((k) => ({ id: k, label: short(k) }))} onChange={setTarget} />
                <span className="text-xs text-ink-3">
                  All {num(targetItems.length)} items issued to {active} · {pkr(activeInfo?.amount)}
                </span>
              </div>
              <TableFilter query={itemQuery} onQuery={setItemQuery} shown={shownItems.length} total={targetItems.length} />
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className={thead}>
                      <th className={th}>Item</th>
                      <th className={th}>Group</th>
                      <th className={`${th} text-right`}>Issued qty</th>
                      <th className={`${th} text-right`}>Avg rate</th>
                      <th className={`${th} text-right`}>Issued</th>
                      <th className={`${th} text-right`}>Share</th>
                      <th className={`${th} text-right`}>Consumed qty</th>
                      <th className={`${th} text-right`}>Qty diff</th>
                      <th className={`${th} text-right`}>Entries</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {shownItems.map((r) => (
                      <tr key={r.item_code} className="border-b border-line/60">
                        <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name}</td>
                        <td className="py-1.5 text-ink-3">{r.item_group}</td>
                        <td className={tdNum}>{num(r.qty, 2)} <span className="text-ink-3">{r.uom}</span></td>
                        <td className={tdNum}>{pkr(r.rate, { decimals: true })}</td>
                        <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                        <td className={tdNum}>{r.share_pct}%</td>
                        <td className={tdNum}>{r.consumed_qty === null ? <span className="text-ink-3">—</span> : num(r.consumed_qty, 2)}</td>
                        <td className={`py-1.5 text-right font-medium ${varianceTone(r.variance_qty, r.qty)}`}>{r.variance_qty === null ? "—" : num(r.variance_qty, 2)}</td>
                        <td className={tdNum}>{num(r.entries)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {view === "entries" && (
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full min-w-[720px] text-xs">
                <thead className="sticky top-0 z-10 bg-surface">
                  <tr className={thead}>
                    <th className={th}>Date</th>
                    <th className={th}>Entry</th>
                    <th className={th}>Issued to</th>
                    <th className={`${th} text-right`}>Issued</th>
                    <th className={`${th} text-right`}>Qty</th>
                    <th className={`${th} text-right`}>Items</th>
                    <th className={th}>Groups</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.entries.map((r) => (
                    <tr key={`${r.name}-${r.target}`} className="border-b border-line/60">
                      <td className="whitespace-nowrap py-1.5 text-ink">
                        {fmtDate(r.date)} <span className="text-[10px] text-ink-3">{r.weekday}</span>
                      </td>
                      <td className="py-1.5 text-ink-2">{r.name}</td>
                      <td className="py-1.5 text-ink">{short(r.target)}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(r.amount)}</td>
                      <td className={tdNum}>{num(r.qty, 1)}</td>
                      <td className={tdNum}>{num(r.items)}</td>
                      <td className="max-w-[260px] truncate py-1.5 pl-3 text-ink-3" title={r.groups}>{r.groups}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.entries_total > d.entries.length && <p className="mt-2 text-[11px] text-ink-3">Showing the latest {num(d.entries.length)} of {num(d.entries_total)} entries. Narrow the date range to see the rest.</p>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
