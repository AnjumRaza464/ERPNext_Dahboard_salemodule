"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Countdown that calls `onTick` every `intervalSec` seconds (0 = off).
 * Ticks are skipped while the tab is hidden; when it becomes visible again a tick fires at once
 * only if a full interval has passed since the last one (so a page left open overnight refreshes
 * on return, but a tab that flips in and out of view does not hammer the backend).
 * `restart()` begins a fresh countdown (after a manual refresh or an interval change).
 * `onTick` should be a stable callback (useCallback) so the timer is not rebuilt each render.
 */
export function useAutoRefresh(intervalSec: number, onTick: () => void): { nextAt: number | null; restart: () => void } {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const startedRef = useRef(startedAt);
  const restart = useCallback(() => setStartedAt(Date.now()), []);

  useEffect(() => {
    startedRef.current = startedAt;
  }, [startedAt]);

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
      if (document.visibilityState !== "visible") return;
      // a tick was missed while hidden only if the countdown has already run out
      if (Date.now() - startedRef.current < intervalSec * 1000) return;
      onTick();
      setStartedAt(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [intervalSec, onTick]);

  return { nextAt: intervalSec ? startedAt + intervalSec * 1000 : null, restart };
}
