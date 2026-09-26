"use client";

import { useState } from "react";
import { PRESETS, type Preset } from "@/lib/dates";
import type { Range } from "@/lib/types";

interface Props {
  preset: Preset;
  range: Range;
  onChange: (preset: Preset, range: Range) => void;
}

export default function DateFilter({ preset, range, onChange }: Props) {
  const [draft, setDraft] = useState<Range>(range);
  const invalid = draft.start > draft.end;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="tablist" aria-label="Date range" className="flex rounded-lg border border-line bg-surface p-0.5">
        {PRESETS.map((p) => {
          const active = p.id === preset;
          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(p.id, p.id === "custom" ? draft : range)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${active ? "bg-accent text-white shadow-sm" : "text-ink-2 hover:bg-surface-2"}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {preset === "custom" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid) onChange("custom", draft);
          }}
        >
          <input
            type="date"
            value={draft.start}
            max={draft.end}
            onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
            aria-label="Start date"
          />
          <span className="text-xs text-ink-3">to</span>
          <input
            type="date"
            value={draft.end}
            min={draft.start}
            onChange={(e) => setDraft({ ...draft, end: e.target.value })}
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
            aria-label="End date"
          />
          <button
            type="submit"
            disabled={invalid || !draft.start || !draft.end}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Apply
          </button>
          {invalid && <span className="text-xs text-bad">Start must be before end</span>}
        </form>
      )}
    </div>
  );
}
