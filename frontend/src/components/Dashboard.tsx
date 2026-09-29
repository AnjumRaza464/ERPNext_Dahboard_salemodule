"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE, fetchJson } from "@/lib/api";
import { isPreset, PRESETS, presetRange, type Preset } from "@/lib/dates";
import { fmtRange, fmtTime } from "@/lib/format";
import type { CompareMode, Range } from "@/lib/types";
import { sectionId, type CompareCommand, type VoiceActions, type VoiceContext, type VoiceSection } from "@/lib/voice";
import DateFilter from "./DateFilter";
import SalesTab from "./tabs/SalesTab";
import VoiceAssistant from "./VoiceAssistant";

interface Health {
  status: string;
  erpnext_user?: string;
  company?: string;
  voice_enabled?: boolean;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The preset whose dates equal `r` (so "aaj ki sale" lights up the Today tab), else custom. */
function presetFor(r: Range): Preset {
  return PRESETS.find((p) => p.id !== "custom" && presetRange(p.id).start === r.start && presetRange(p.id).end === r.end)?.id ?? "custom";
}

/** Scroll a dashboard section into view and flash it briefly. */
function revealSection(section: VoiceSection) {
  // wait a frame so a range change has re-rendered before measuring
  setTimeout(() => {
    const el = document.getElementById(sectionId(section));
    if (!el) return;
    const go = (behavior: ScrollBehavior) => (section === "kpis" ? window.scrollTo({ top: 0, behavior }) : el.scrollIntoView({ behavior, block: "start" }));
    go("smooth");
    // Charts reloading for a new range can shift the layout mid-scroll (and background tabs skip
    // smooth scrolling), so snap into place if the section did not end up near the top.
    setTimeout(() => {
      if (Math.abs(el.getBoundingClientRect().top) > 60 && !(section === "kpis" && window.scrollY === 0)) go("auto");
    }, 900);
    el.classList.remove("voice-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("voice-flash");
    setTimeout(() => el.classList.remove("voice-flash"), 2200);
  }, 120);
}

export default function Dashboard() {
  // This component is client-only (see DashboardLoader), so per-viewer
  // conveniences can be restored from localStorage in the initial state.
  // URL params (?start=YYYY-MM-DD&end=YYYY-MM-DD or ?preset=month) win over stored preferences.
  const [preset, setPreset] = useState<Preset>(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("start") && q.get("end")) return "custom";
    const p = q.get("preset");
    return isPreset(p) ? p : readStored<Preset>("sb-preset", "month");
  });
  const [range, setRange] = useState<Range>(() => {
    const q = new URLSearchParams(window.location.search);
    const qs = q.get("start");
    const qe = q.get("end");
    if (qs && qe && qs <= qe) return { start: qs, end: qe };
    const qp = q.get("preset");
    if (isPreset(qp) && qp !== "custom") return presetRange(qp);
    const p = readStored<Preset>("sb-preset", "month");
    const r = readStored<Range | null>("sb-range", null);
    return p === "custom" && r ? r : presetRange(p);
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  const [compareCommand, setCompareCommand] = useState<CompareCommand | undefined>(undefined);

  useEffect(() => {
    try {
      localStorage.setItem("sb-preset", JSON.stringify(preset));
      localStorage.setItem("sb-range", JSON.stringify(range));
    } catch {
      /* ignore */
    }
  }, [preset, range]);

  const checkHealth = useCallback(() => {
    fetchJson<Health>(`${API_BASE}/api/health`)
      .then((h) => {
        setHealth(h);
        setHealthError(null);
      })
      .catch((e: Error) => {
        setHealth(null);
        setHealthError(e.message);
      });
  }, []);

  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, 60_000);
    return () => clearInterval(id);
  }, [checkHealth]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setLastRefresh(new Date());
    checkHealth();
  }, [checkHealth]);

  const onRangeChange = (p: Preset, r: Range) => {
    setPreset(p);
    setRange(p === "custom" ? r : presetRange(p));
  };

  const setTheme = (next: boolean) => {
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("sb-theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  };
  const toggleTheme = () => setTheme(!dark);

  // What the voice assistant needs to resolve "comparison" / relative requests.
  const voiceContext = (): VoiceContext => ({
    range,
    cmpMode: readStored<CompareMode>("sb-cmp-mode", "previous"),
    cmpRange: readStored<Range | undefined>("sb-cmp-range", undefined),
  });

  const applyVoice = (a: VoiceActions) => {
    if (a.range) {
      setPreset(presetFor(a.range));
      setRange(a.range);
    }
    if (a.compare) setCompareCommand({ ...a.compare, nonce: Date.now() });
    if (a.theme) setTheme(a.theme === "dark");
    if (a.refresh) refresh();
    if (a.section) revealSection(a.section);
  };

  const tabProps = { range, refreshKey, onRetry: refresh, compareCommand };

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-4 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">SB</div>
          <div>
            <h1 className="text-lg font-semibold leading-tight text-ink">{health?.company ?? "Sindh Bakery"}</h1>
            <p className="text-xs text-ink-3">Sales Analytics · ERPNext live · PKR</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-ink-3 sm:inline-flex" title={healthError ?? (health ? `Connected as ${health.erpnext_user}` : "Checking…")}>
            <span className={`inline-block h-2 w-2 rounded-full ${healthError ? "bg-bad" : health ? "bg-good" : "bg-warn"}`} />
            {healthError ? "Backend offline" : health ? "ERPNext connected" : "Connecting…"}
          </span>
          {lastRefresh && <span className="hidden text-xs text-ink-3 md:inline">Updated {fmtTime(lastRefresh)}</span>}
          <VoiceAssistant enabled={health?.voice_enabled !== false} getContext={voiceContext} onActions={applyVoice} />
          <button
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
            title="Bypass the 2-minute cache and reload every panel"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
            </svg>
            Refresh Now
          </button>
          <button onClick={toggleTheme} className="rounded-md border border-line bg-surface p-1.5 text-ink-2 hover:bg-surface-2" title="Toggle dark mode" aria-label="Toggle dark mode">
            {dark ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4l1.4-1.4" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {healthError && (
        <div className="rounded-lg border border-bad/40 bg-surface px-4 py-2 text-xs text-ink-2">
          <span className="font-medium text-bad">Backend unreachable.</span> {healthError} Start it with <code className="rounded bg-surface-2 px-1">uvicorn app.main:app --port 8010</code> inside the backend folder.
        </div>
      )}

      <div className="card flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <h2 className="px-1 text-sm font-semibold text-ink">Sales</h2>
        <div className="flex flex-wrap items-center gap-3">
          <DateFilter key={`${range.start}|${range.end}`} preset={preset} range={range} onChange={onRangeChange} />
          <span className="tnum text-xs text-ink-3">{fmtRange(range.start, range.end)}</span>
        </div>
      </div>

      <SalesTab {...tabProps} />

      <footer className="pb-4 pt-2 text-center text-[11px] text-ink-3">
        Figures come live from ERPNext via the local FastAPI proxy · cached for 2 minutes · use Refresh Now for the latest numbers
      </footer>
    </div>
  );
}
