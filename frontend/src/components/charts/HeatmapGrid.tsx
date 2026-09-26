"use client";

import { useState } from "react";
import { num, pkr } from "@/lib/format";
import type { HeatmapCell, SalesHeatmap } from "@/lib/types";

const RAMP = ["var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)", "var(--heat-5)"];

/** Weekday x hour grid; one sequential hue, five steps, zero cells stay on the surface colour. */
export default function HeatmapGrid({ data }: { data: SalesHeatmap }) {
  const [hover, setHover] = useState<HeatmapCell | null>(null);
  const hours: number[] = [];
  for (let h = data.hour_min; h <= data.hour_max; h++) hours.push(h);
  const byKey = new Map(data.cells.map((c) => [`${c.weekday_index}-${c.hour}`, c]));
  const step = (c: HeatmapCell) => (c.avg_per_day <= 0 || !data.max_avg ? -1 : Math.min(4, Math.floor((c.avg_per_day / data.max_avg) * 5)));
  const fill = (c: HeatmapCell) => (step(c) < 0 ? "var(--surface-2)" : RAMP[step(c)]);
  const isPeak = (c: HeatmapCell) => !!data.peak && data.peak.weekday === c.weekday && data.peak.hour === c.hour;
  const labelEvery = hours.length > 14 ? 2 : 1;
  const shown = hover ?? (data.peak ? byKey.get(`${data.weekdays.indexOf(data.peak.weekday)}-${data.peak.hour}`) ?? null : null);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `36px repeat(${hours.length}, minmax(0, 1fr))` }} onMouseLeave={() => setHover(null)}>
        <div />
        {hours.map((h, i) => (
          <div key={h} className="tnum text-center text-[10px] text-ink-3">
            {i % labelEvery === 0 ? `${String(h).padStart(2, "0")}` : ""}
          </div>
        ))}
        {data.weekdays.map((wd, wi) => (
          <div key={wd} className="contents">
            <div className="flex items-center text-[11px] text-ink-2">{wd}</div>
            {hours.map((h) => {
              const c = byKey.get(`${wi}-${h}`);
              if (!c) return <div key={h} />;
              return (
                <div
                  key={h}
                  role="img"
                  aria-label={`${wd} ${h}:00, ${pkr(c.avg_per_day)} per day`}
                  title={`${wd} ${String(h).padStart(2, "0")}:00 · ${pkr(c.avg_per_day)}/day`}
                  onMouseEnter={() => setHover(c)}
                  className={`h-6 rounded-[4px] transition-transform hover:scale-110 ${isPeak(c) ? "ring-2 ring-ink ring-offset-1 ring-offset-surface" : ""}`}
                  style={{ background: fill(c) }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
        <span className="tnum">
          {shown ? (
            <>
              <span className="font-medium text-ink">
                {shown.weekday} {String(shown.hour).padStart(2, "0")}:00
              </span>{" "}
              · {pkr(shown.avg_per_day)} avg/day · {pkr(shown.total)} over {num(shown.occurrences)} {shown.weekday}s · {num(shown.invoice_count)} inv
              {isPeak(shown) ? " · peak" : ""}
            </>
          ) : (
            "Hover a cell for details"
          )}
        </span>
        <span className="flex items-center gap-1">
          Low
          {RAMP.map((c) => (
            <span key={c} className="inline-block h-2.5 w-4 rounded-sm" style={{ background: c }} />
          ))}
          High
        </span>
      </div>
    </div>
  );
}
