"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Countdown that calls `onTick` every `intervalSec` seconds (0 = off).
 * Ticks are skipped while the tab is hidden and one fires as soon as it is visible
 * again, so a dashboard left open overnight does not poll the backend for nobody.
 * `restart()` begins a fresh countdown (after a manual refresh or an interval change).
 * `onTick` should be a stable callback (useCallback) so the timer is not rebuilt each render.
 */
export function useAutoRefresh(intervalSec: number, onTick: () => void): { nextAt: number | null; restart: () => void } {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const restart = useCallback(() => setStartedAt(Date.now()), []);

  useEffect(() => {
    if (!intervalSec) return;
    const delay = Math.max(0, startedAt + intervalSec * 1000 - Date.now());
    const id = window.setTimeout(() => {
      if (document.visibilityState === "visible") onTick();
      setStartedAt(Date.now());
    }, delay);
    return () => window.clearTimeout(id);
  }, [intervalSec, startedAt, onTick]);

  useEffect(() => {
    if (!intervalSec) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        onTick();
        setStartedAt(Date.now());
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [intervalSec, onTick]);

  return { nextAt: intervalSec ? startedAt + intervalSec * 1000 : null, restart };
}
