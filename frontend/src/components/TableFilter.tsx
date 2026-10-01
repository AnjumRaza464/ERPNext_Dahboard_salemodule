"use client";

import { num } from "@/lib/format";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  /** optional item-group dropdown */
  group?: string;
  onGroup?: (g: string) => void;
  groups?: string[];
  shown: number;
  total: number;
  placeholder?: string;
}

/** Search box (item name or code) with an optional group dropdown and a "shown of total" counter. */
export default function TableFilter({ query, onQuery, group = "", onGroup, groups, shown, total, placeholder = "Search item or code…" }: Props) {
  const active = query !== "" || group !== "";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <input
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={placeholder}
        aria-label="Search items"
        className="w-56 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3"
      />
      {groups && groups.length > 1 && onGroup && (
        <select value={group} onChange={(e) => onGroup(e.target.value)} aria-label="Item group" className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink">
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      )}
      <span className="tnum text-ink-3">{active ? `${num(shown)} of ${num(total)} items` : `${num(total)} items`}</span>
      {active && (
        <button
          onClick={() => {
            onQuery("");
            onGroup?.("");
          }}
          className="text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
        >
          clear
        </button>
      )}
      {active && shown === 0 && <span className="text-warn">No items match.</span>}
    </div>
  );
}
