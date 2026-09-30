"use client";

import { useEffect, useState } from "react";
import { API_BASE, ApiError, fetchJson } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { Brief } from "@/lib/types";
import { sectionId } from "@/lib/voice";

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A few Roman Urdu lines about the last trading day, the month's pace and tomorrow's plan,
 * with a Copy button so the owner can paste it into WhatsApp. Collapsible; remembers its state.
 */
export default function MorningBrief({ refreshKey, target }: { refreshKey: number; target: number | null }) {
  const [open, setOpen] = useState<boolean>(() => readStored<boolean>("sb-brief", true));
  const [data, setData] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("sb-brief", JSON.stringify(open));
    } catch {
      /* ignore */
    }
  }, [open]);

  useEffect(() => {
    const controller = new AbortController();
    const qs = new URLSearchParams();
    if (target) qs.set("target", String(target));
    if (refreshKey) qs.set("refresh", "1");
    fetchJson<Brief>(`${API_BASE}/api/sales/brief?${qs.toString()}`, controller.signal)
      .then((b) => {
        setData(b);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof ApiError ? e.message : (e as Error).message || "Request failed");
      });
    return () => controller.abort();
  }, [refreshKey, target]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section id={sectionId("brief")} className="card scroll-mt-4 px-4 py-3 sm:px-5">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-left text-sm font-semibold text-ink" aria-expanded={open}>
          <span className="text-ink-3">{open ? "▾" : "▸"}</span>
          Subah ka brief
          {data && <span className="text-xs font-normal text-ink-3">· {fmtDate(data.date)}</span>}
        </button>
        {open && data && (
          <button onClick={copy} className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-surface-2" title="Copy the text to paste into WhatsApp">
            {copied ? "Copied ✓" : "Copy"}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 text-sm leading-relaxed text-ink-2">
          {error ? (
            <span className="text-xs text-bad">{error}</span>
          ) : !data ? (
            <span className="text-xs text-ink-3">Loading…</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.lines.map((line, i) => (
                <li key={i} className={`tnum ${line.startsWith("Note:") ? "text-warn" : ""}`}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
