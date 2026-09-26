"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, buildUrl, fetchJson } from "@/lib/api";
import type { Range } from "@/lib/types";

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  /** first load, nothing to show yet */
  loading: boolean;
  /** refetching while previous data is still displayed */
  refreshing: boolean;
  fetchedAt: Date | null;
}

interface Resolved<T> {
  key: string;
  data: T | null;
  error: string | null;
  fetchedAt: Date | null;
}

/**
 * Fetches `path` for the given date range. Bumping `refreshKey` refetches with
 * `refresh=1`, which tells the backend to bypass its cache. Previous data is
 * held on screen while refetching (no skeleton flash).
 */
export function useApi<T>(path: string, range: Range, refreshKey: number, extra: Record<string, string | number> = {}): QueryState<T> {
  const extraKey = JSON.stringify(extra);
  const requestKey = `${path}|${range.start}|${range.end}|${extraKey}|${refreshKey}`;
  const [resolved, setResolved] = useState<Resolved<T>>({ key: "", data: null, error: null, fetchedAt: null });
  const lastRefresh = useRef(refreshKey);

  useEffect(() => {
    const controller = new AbortController();
    const bypass = refreshKey !== lastRefresh.current;
    lastRefresh.current = refreshKey;
    const url = buildUrl(path, range, { ...JSON.parse(extraKey), ...(bypass ? { refresh: 1 } : {}) });

    fetchJson<T>(url, controller.signal)
      .then((data) => setResolved({ key: requestKey, data, error: null, fetchedAt: new Date() }))
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        const msg = e instanceof ApiError ? e.message : (e as Error).message || "Request failed";
        setResolved((s) => ({ key: requestKey, data: s.data, error: msg, fetchedAt: s.fetchedAt }));
      });

    return () => controller.abort();
    // `range` is covered by requestKey (start/end); extra by extraKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  return useMemo(() => {
    const pending = resolved.key !== requestKey;
    return {
      data: resolved.data,
      error: pending ? null : resolved.error,
      loading: pending && resolved.data === null,
      refreshing: pending && resolved.data !== null,
      fetchedAt: resolved.fetchedAt,
    };
  }, [resolved, requestKey]);
}
