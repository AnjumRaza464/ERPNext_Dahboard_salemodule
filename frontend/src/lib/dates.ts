import type { Range } from "./types";

export type Preset = "today" | "week" | "month" | "lastmonth" | "custom";

export function isPreset(v: string | null | undefined): v is Preset {
  return v === "today" || v === "week" || v === "month" || v === "lastmonth" || v === "custom";
}

export const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "lastmonth", label: "Last Month" },
  { id: "custom", label: "Custom Range" },
];

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function presetRange(preset: Preset, now = new Date()): Range {
  const end = toIso(now);
  if (preset === "today") return { start: end, end };
  if (preset === "week") {
    const d = new Date(now);
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
    return { start: toIso(d), end };
  }
  if (preset === "lastmonth") {
    return { start: toIso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), end: toIso(new Date(now.getFullYear(), now.getMonth(), 0)) };
  }
  // month (custom falls back to month until the user picks dates)
  return { start: toIso(new Date(now.getFullYear(), now.getMonth(), 1)), end };
}
