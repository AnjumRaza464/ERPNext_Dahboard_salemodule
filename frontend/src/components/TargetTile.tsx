"use client";

import { useState } from "react";
import { num, pkr } from "@/lib/format";
import type { RunRate, TargetStatus } from "@/lib/types";
import { Skeleton } from "./States";

const STATUS: Record<TargetStatus, { label: string; tone: string; bar: string }> = {
  achieved: { label: "Target done", tone: "bg-good/10 text-good", bar: "bg-good" },
  on_track: { label: "On track", tone: "bg-good/10 text-good", bar: "bg-good" },
  at_risk: { label: "At risk", tone: "bg-warn/10 text-warn", bar: "bg-warn" },
  behind: { label: "Behind", tone: "bg-bad/10 text-bad", bar: "bg-bad" },
};

interface Props {
  /** run-rate payload; its month.target reflects the browser's target (sent as ?target=) or MONTHLY_TARGETS */
  pace: { data: RunRate | null; loading: boolean; refreshing: boolean; error: string | null };
  onTargetChange: (value: number | null) => void;
}

/**
 * Monthly target tile: how much of the month's target is done, what each remaining trading day
 * has to bring in, and where the month is heading on the current pace. The target is typed
 * inline (pencil) and remembered per month in this browser; MONTHLY_TARGETS on the server is
 * the fallback.
 */
export default function TargetTile({ pace, onTargetChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const m = pace.data?.month;
  const t = m?.target ?? null;

  const startEdit = () => {
    setDraft(t ? String(Math.round(t.amount)) : "");
    setEditing(true);
  };
  const commit = () => {
    const v = Number(draft.replace(/[^0-9.]/g, ""));
    onTargetChange(Number.isFinite(v) && v > 0 ? v : null);
    setEditing(false);
  };

  const editor = (
    <form
      className="mt-1 flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <input
        autoFocus
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. 4000000"
        className="w-32 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
        aria-label="Monthly target in PKR"
      />
      <button type="submit" className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white">Save</button>
      <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-line px-2 py-1 text-xs text-ink-2">Cancel</button>
      {t && (
        <button type="button" onClick={() => { onTargetChange(null); setEditing(false); }} className="text-[11px] text-ink-3 underline">clear</button>
      )}
    </form>
  );

  return (
    <div className={`card flex flex-col gap-1 p-4 transition-opacity ${pace.refreshing ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-3">{m ? `${m.label} target` : "Monthly target"}</span>
        {m && !editing && (
          <button onClick={startEdit} className="text-[11px] text-ink-3 hover:text-ink" title={t ? `Target ${pkr(t.amount)} (${t.source === "client" ? "set here" : "from server config"}) · click to change` : "Set a target for this month"} aria-label="Edit monthly target">
            ✎ {t ? "change" : "set"}
          </button>
        )}
      </div>
      {pace.loading ? (
        <>
          <Skeleton className="mt-1 h-7 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </>
      ) : pace.error || !m ? (
        <span className="text-lg font-semibold text-ink-3">—</span>
      ) : !t ? (
        <>
          <span className="tnum text-2xl font-semibold leading-tight text-ink">{pkr(m.mtd)}</span>
          <span className="text-xs text-ink-3">
            {m.is_complete ? `${num(m.active_days)} trading din` : `so far · projected ${pkr(m.projected)} · ${num(m.remaining_trading_days)} trading din baqi`}
          </span>
          {editing ? editor : (
            <button onClick={startEdit} className="mt-1 self-start rounded-md border border-dashed border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2">
              Target set karein
            </button>
          )}
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="tnum text-2xl font-semibold leading-tight text-ink" title={`${pkr(m.mtd)} of ${pkr(t.amount)}`}>
              {Math.min(999, Math.round(t.attainment_pct))}%
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS[t.status].tone}`}>{STATUS[t.status].label}</span>
          </div>
          <div className="relative mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
            <div className={`h-full rounded-full ${STATUS[t.status].bar}`} style={{ width: `${Math.min(100, t.attainment_pct)}%` }} />
            {!m.is_complete && t.status !== "achieved" && (
              <div className="absolute top-0 h-full w-px bg-ink-3" style={{ left: `${Math.min(100, (m.projected / t.amount) * 100)}%` }} title={`projected ${pkr(m.projected)}`} />
            )}
          </div>
          <span className="tnum text-xs text-ink-3">
            {pkr(m.mtd)} of {pkr(t.amount)}
            {m.is_complete
              ? ""
              : t.status === "achieved"
                ? ` · done with ${num(m.remaining_days)} din to spare`
                : t.required_per_trading_day
                  ? ` · ${pkr(t.required_per_trading_day)}/din chahiye · ${num(m.remaining_trading_days)} trading din baqi · projected ${pkr(m.projected)}`
                  : ` · projected ${pkr(m.projected)}`}
          </span>
          {editing && editor}
        </>
      )}
    </div>
  );
}
