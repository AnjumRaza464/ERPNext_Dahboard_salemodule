import type { Range } from "./types";

// Local dev talks to uvicorn on :8010 (see .env.local). In production (Vercel services)
// the API is served from the same origin under /api, so the base is empty.
const DEFAULT_API_BASE = process.env.NODE_ENV === "production" ? "" : "http://localhost:8010";
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function buildUrl(path: string, range: Range, extra: Record<string, string | number | boolean> = {}): string {
  const params = new URLSearchParams({ start: range.start, end: range.end });
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== false) params.set(k, String(v));
  }
  return `${API_BASE}${path}?${params.toString()}`;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Backend unreachable. Is the FastAPI server running on " + (API_BASE || "this origin") + "?", 0);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      const d = body.detail;
      if (typeof d === "string") detail = d;
      else if (Array.isArray(d)) detail = d.map((x: { loc?: unknown[]; msg?: string }) => `${(x.loc ?? []).slice(-1)[0] ?? "request"}: ${x.msg ?? "invalid"}`).join("; ");
      else if (d) detail = JSON.stringify(d);
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}
