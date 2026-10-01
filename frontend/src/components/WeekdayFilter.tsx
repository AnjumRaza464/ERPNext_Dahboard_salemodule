"use client";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  /** selected weekday names; empty = every day */
  value: string[];
  onChange: (days: string[]) => void;
}

/** Day chips (Mon … Sun) that narrow a detail section to the chosen weekdays; "All" clears the filter. */
export default function WeekdayFilter({ value, onChange }: Props) {
  const toggle = (d: string) => onChange(value.includes(d) ? value.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || value.includes(x)));
  const chip = (active: boolean) => `rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${active ? "bg-accent text-white" : "text-ink-2 hover:bg-surface-2"}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-3">Days</span>
      <div role="group" aria-label="Weekday filter" className="flex rounded-lg border border-line bg-surface p-0.5">
        <button onClick={() => onChange([])} className={chip(value.length === 0)} aria-pressed={value.length === 0}>
          All
        </button>
        {WEEKDAYS.map((d) => (
          <button key={d} onClick={() => toggle(d)} className={chip(value.includes(d))} aria-pressed={value.includes(d)}>
            {d}
          </button>
        ))}
      </div>
      {value.length > 0 && <span className="text-ink-3">only {value.join(", ")} · totals, averages and lists below use these days</span>}
    </div>
  );
}
