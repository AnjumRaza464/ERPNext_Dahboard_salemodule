"use client";

import { useState } from "react";
import type { QueryState } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { fmtDate, fmtRange, num, pkr } from "@/lib/format";
import type { Range, StockEntryRow, StockTracking } from "@/lib/types";
import Card from "./Card";
import ExportButtons from "./ExportButtons";
import TableFilter from "./TableFilter";

interface Props {
  q: QueryState<StockTracking>;
  range: Range;
  onRetry: () => void;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

/** Every stock ledger line posted in the range, newest first: what moved, where, how much, and the balance it left. */
export default function StockEntriesTable({ q, range, onRetry }: Props) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [kind, setKind] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const d = q.data;
  const all = d?.entries ?? [];
  const groups = Array.from(new Set(all.map((r) => r.item_group))).sort();
  const kinds = Array.from(new Set(all.map((r) => r.kind))).sort();
  const warehouses = Array.from(new Set(all.map((r) => r.warehouse))).sort();
  const needle = query.trim().toLowerCase();
  const rows = all.filter(
    (r) =>
      (!group || r.item_group === group) &&
      (!kind || r.kind === kind) &&
      (!warehouse || r.warehouse === warehouse) &&
      (!needle || r.item_name.toLowerCase().includes(needle) || r.item_code.toLowerCase().includes(needle) || r.voucher_no.toLowerCase().includes(needle)),
  );

  const cols: CsvColumn<StockEntryRow>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    { key: "time", header: "Time", value: (r) => r.time },
    { key: "kind", header: "Movement", value: (r) => r.kind },
    { key: "voucher_no", header: "Voucher", value: (r) => r.voucher_no },
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "warehouse", header: "Warehouse", value: (r) => r.warehouse },
    { key: "qty", header: "Qty (+in / -out)", value: (r) => r.qty },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "qty_after", header: "Balance after", value: (r) => r.qty_after },
    { key: "rate", header: "Valuation rate", value: (r) => r.rate },
    { key: "value", header: "Value change (PKR)", value: (r) => r.value },
  ];
  const onExport = (fmt: ExportFormat) => exportTable(fmt, `stock-entries-${range.start}-${range.end}`, rows, cols);

  return (
    <Card
      title="Stock Ledger Entries"
      subtitle={d ? `${fmtRange(range.start, range.end)} · ${num(all.length)} ledger lines from ${num(d.summary.entries)} vouchers, newest first · search by item or voucher number` : undefined}
      source="stock_entry"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && all.length === 0}
      emptyHint="Nothing was posted to the stock ledger in this range."
      onRetry={onRetry}
      height={200}
      action={d && all.length > 0 ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {d && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <TableFilter query={query} onQuery={setQuery} group={group} onGroup={setGroup} groups={groups} shown={rows.length} total={all.length} placeholder="Search item, code or voucher…" />
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Movement type" className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink">
              <option value="">All movements</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Warehouse" className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink">
              <option value="">All warehouses</option>
              {warehouses.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full min-w-[980px] text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className={thead}>
                  <th className={th}>Date</th>
                  <th className={th}>Movement</th>
                  <th className={th}>Voucher</th>
                  <th className={th}>Item</th>
                  <th className={th}>Group</th>
                  <th className={th}>Warehouse</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Balance after</th>
                  <th className={`${th} text-right`}>Rate</th>
                  <th className={`${th} text-right`}>Value</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {rows.map((r, i) => (
                  <tr key={`${r.voucher_no}-${r.item_code}-${r.warehouse}-${i}`} className="border-b border-line/60">
                    <td className="whitespace-nowrap py-1.5 text-ink">
                      {fmtDate(r.date)} <span className="text-ink-3">{r.time}</span>
                    </td>
                    <td className="py-1.5 text-ink-2">{r.kind}</td>
                    <td className="whitespace-nowrap py-1.5 text-ink-3">{r.voucher_no}</td>
                    <td className="py-1.5 text-ink" title={r.item_code}>
                      {r.item_name}
                    </td>
                    <td className="py-1.5 text-ink-3">{r.item_group}</td>
                    <td className="py-1.5 text-ink-2">{r.warehouse}</td>
                    <td className={`py-1.5 text-right font-medium ${r.qty > 0 ? "text-good" : r.qty < 0 ? "text-bad" : "text-ink-3"}`}>
                      {r.qty > 0 ? "+" : r.qty < 0 ? "−" : ""}
                      {num(Math.abs(r.qty), 2)} <span className="font-normal text-ink-3">{r.uom}</span>
                    </td>
                    <td className={tdNum}>{num(r.qty_after, 2)}</td>
                    <td className={tdNum}>{pkr(r.rate, { decimals: true })}</td>
                    <td className={`py-1.5 text-right ${r.value > 0 ? "text-good" : r.value < 0 ? "text-bad" : "text-ink-3"}`}>{pkr(r.value, { sign: true })}</td>
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
