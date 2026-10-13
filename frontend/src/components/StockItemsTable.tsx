"use client";

import { useState } from "react";
import type { QueryState } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { fmtDate, fmtRange, num, pkr } from "@/lib/format";
import type { Range, StockStatus, StockTracking, StockTrackRow } from "@/lib/types";
import Card from "./Card";
import ExportButtons from "./ExportButtons";
import TableFilter from "./TableFilter";

interface Props {
  q: QueryState<StockTracking>;
  range: Range;
  onRetry: () => void;
}

type Show = "all" | StockStatus;
type Sort = "value" | "in" | "out" | "cover" | "idle";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

export const STATUS_LABEL: Record<StockStatus, string> = { ok: "OK", low: "Running low", out: "Out of stock", idle: "Idle", empty: "Empty" };
const STATUS_TONE: Record<StockStatus, string> = {
  ok: "bg-good/10 text-good", low: "bg-warn/10 text-warn", out: "bg-bad/10 text-bad", idle: "bg-surface-2 text-ink-2", empty: "bg-surface-2 text-ink-3",
};
const STATUS_HINT: Record<StockStatus, string> = {
  ok: "In stock and moved in this range",
  low: "Less than 7 days of cover at this range's average daily usage",
  out: "Nothing left now, although it had stock or movement in this range",
  idle: "In stock but nothing moved in this range",
  empty: "No stock and no movement",
};

export function StatusChip({ status }: { status: StockStatus }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`} title={STATUS_HINT[status]}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function qty(v: number, uom: string) {
  return (
    <>
      {num(v, 2)} <span className="text-ink-3">{uom}</span>
    </>
  );
}

/** Every item in every warehouse: opening, in, out, closing and current balance, days of cover, last movement and status. */
export default function StockItemsTable({ q, range, onRetry }: Props) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [sort, setSort] = useState<Sort>("value");
  const d = q.data;
  const all = d?.items ?? [];
  const groups = Array.from(new Set(all.map((r) => r.item_group))).sort();
  const warehouses = Array.from(new Set(all.map((r) => r.warehouse))).sort();
  const needle = query.trim().toLowerCase();
  const rows = all
    .filter(
      (r) =>
        (!group || r.item_group === group) &&
        (!warehouse || r.warehouse === warehouse) &&
        (show === "all" || r.status === show) &&
        (!needle || r.item_name.toLowerCase().includes(needle) || r.item_code.toLowerCase().includes(needle)),
    )
    .sort((a, b) => {
      if (sort === "in") return b.in_value - a.in_value;
      if (sort === "out") return b.out_value - a.out_value;
      if (sort === "cover") return (a.days_cover ?? Infinity) - (b.days_cover ?? Infinity);
      if (sort === "idle") return (b.idle_days ?? -1) - (a.idle_days ?? -1);
      return b.current_value - a.current_value;
    });
  const counts = all.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

  const cols: CsvColumn<StockTrackRow>[] = [
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "warehouse", header: "Warehouse", value: (r) => r.warehouse },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "opening_qty", header: "Opening qty", value: (r) => r.opening_qty },
    { key: "in_qty", header: "In qty", value: (r) => r.in_qty },
    { key: "out_qty", header: "Out qty", value: (r) => r.out_qty },
    { key: "closing_qty", header: "Closing qty", value: (r) => r.closing_qty },
    { key: "current_qty", header: "Qty now", value: (r) => r.current_qty },
    { key: "rate", header: "Valuation rate", value: (r) => r.rate },
    { key: "opening_value", header: "Opening (PKR)", value: (r) => r.opening_value },
    { key: "in_value", header: "In (PKR)", value: (r) => r.in_value },
    { key: "out_value", header: "Out (PKR)", value: (r) => r.out_value },
    { key: "closing_value", header: "Closing (PKR)", value: (r) => r.closing_value },
    { key: "current_value", header: "Value now (PKR)", value: (r) => r.current_value },
    { key: "daily_out", header: "Avg out per day", value: (r) => r.daily_out },
    { key: "days_cover", header: "Days of cover", value: (r) => r.days_cover },
    { key: "last_movement", header: "Last movement", value: (r) => r.last_movement },
    { key: "idle_days", header: "Days since movement", value: (r) => r.idle_days },
    { key: "status", header: "Status", value: (r) => STATUS_LABEL[r.status] },
  ];
  const onExport = (fmt: ExportFormat) => exportTable(fmt, `stock-items-${range.start}-${range.end}`, rows, cols);

  const chips: { id: Show; label: string }[] = [
    { id: "all", label: "All" },
    { id: "low", label: "Running low" },
    { id: "out", label: "Out of stock" },
    { id: "idle", label: "Idle" },
    { id: "ok", label: "OK" },
  ];

  return (
    <Card
      title="Item-wise Stock"
      subtitle={
        d
          ? `${fmtRange(range.start, range.end)} · ${num(all.length)} item × warehouse lines · ${num(counts.low ?? 0)} running low · ${num(counts.out ?? 0)} out of stock · ${num(counts.idle ?? 0)} idle · days of cover = qty now ÷ average daily out in this range`
          : undefined
      }
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && all.length === 0}
      emptyHint="No stock balances or movements were found."
      onRetry={onRetry}
      height={200}
      action={d && all.length > 0 ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {d && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <TableFilter query={query} onQuery={setQuery} group={group} onGroup={setGroup} groups={groups} shown={rows.length} total={all.length} />
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Warehouse" className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink">
              <option value="">All warehouses</option>
              {warehouses.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink">
              <option value="value">Sort: value now</option>
              <option value="in">Sort: most in</option>
              <option value="out">Sort: most out</option>
              <option value="cover">Sort: fewest days of cover</option>
              <option value="idle">Sort: longest idle</option>
            </select>
            <div role="tablist" className="flex rounded-md border border-line bg-surface p-0.5">
              {chips.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={show === c.id}
                  onClick={() => setShow(c.id)}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium ${show === c.id ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`}
                >
                  {c.label}
                  {c.id !== "all" && <span className="ml-1 text-ink-3">{num(counts[c.id] ?? 0)}</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[1180px] text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className={thead}>
                  <th className={th}>Item</th>
                  <th className={th}>Group</th>
                  <th className={th}>Warehouse</th>
                  <th className={`${th} text-right`}>Opening</th>
                  <th className={`${th} text-right`}>In</th>
                  <th className={`${th} text-right`}>Out</th>
                  <th className={`${th} text-right`}>Closing</th>
                  <th className={`${th} text-right`}>Now</th>
                  <th className={`${th} text-right`}>Rate</th>
                  <th className={`${th} text-right`}>Value now</th>
                  <th className={`${th} text-right`}>Days cover</th>
                  <th className={th}>Last moved</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {rows.map((r) => (
                  <tr key={`${r.item_code}|${r.warehouse}`} className="border-b border-line/60">
                    <td className="py-1.5 text-ink" title={r.item_code}>
                      {r.item_name}
                    </td>
                    <td className="py-1.5 text-ink-3">{r.item_group}</td>
                    <td className="py-1.5 text-ink-2">{r.warehouse}</td>
                    <td className={tdNum}>{qty(r.opening_qty, r.uom)}</td>
                    <td className={`py-1.5 text-right ${r.in_qty ? "text-good" : "text-ink-3"}`}>{r.in_qty ? `+${num(r.in_qty, 2)}` : "—"}</td>
                    <td className={`py-1.5 text-right ${r.out_qty ? "text-bad" : "text-ink-3"}`}>{r.out_qty ? `−${num(r.out_qty, 2)}` : "—"}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{qty(r.closing_qty, r.uom)}</td>
                    <td className={`py-1.5 text-right font-medium ${r.current_qty <= 0 ? "text-bad" : "text-ink"}`}>{qty(r.current_qty, r.uom)}</td>
                    <td className={tdNum}>{pkr(r.rate, { decimals: true })}</td>
                    <td className={tdNum}>{pkr(r.current_value)}</td>
                    <td className={`py-1.5 text-right ${r.days_cover !== null && r.days_cover < 7 ? "font-medium text-warn" : "text-ink-2"}`} title={r.daily_out ? `${num(r.daily_out, 2)} ${r.uom} out per day` : "Nothing went out in this range"}>
                      {r.days_cover === null ? "—" : `${num(r.days_cover, 1)} d`}
                    </td>
                    <td className="whitespace-nowrap py-1.5 text-ink-2" title={r.idle_days !== null ? `${num(r.idle_days)} days ago` : undefined}>
                      {fmtDate(r.last_movement)}
                      {r.idle_days !== null && r.idle_days > 0 && <span className="ml-1 text-ink-3">({num(r.idle_days)}d)</span>}
                    </td>
                    <td className="py-1.5">
                      <StatusChip status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
