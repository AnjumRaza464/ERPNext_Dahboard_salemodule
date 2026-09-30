import { API_BASE, ApiError } from "./api";
import { toIso } from "./dates";
import type { CompareMode, Range } from "./types";

/** Dashboard sections the voice assistant can scroll to (ids match backend/app/routers/voice.py). */
export type VoiceSection =
  | "live" | "kpis" | "pace" | "comparison" | "monthly" | "item_groups" | "payment_modes" | "top_items" | "pareto"
  | "outlets" | "composition" | "heatmap" | "by_hour" | "by_weekday" | "customers" | "invoices";

export const sectionId = (s: VoiceSection) => `sec-${s}`;

export interface VoiceActions {
  range?: Range;
  /** date for the live comparison board (it has its own date, separate from the dashboard range) */
  live_range?: Range;
  section?: VoiceSection;
  compare?: { mode: CompareMode; range?: Range };
  refresh?: boolean;
  theme?: "dark" | "light";
}

export interface VoiceResult {
  transcript: string;
  understood: boolean;
  reply: string;
  summary?: string;
  actions: VoiceActions;
}

/** Comparison command handed from the voice assistant to SalesComparison. */
export interface CompareCommand {
  mode: CompareMode;
  range?: Range;
  nonce: number;
}

/** Date command handed from the voice assistant to the live comparison board. */
export interface LiveCommand {
  range: Range;
  nonce: number;
}

export interface VoiceContext {
  range: Range;
  cmpMode: CompareMode;
  cmpRange?: Range;
  /** what the live comparison board is currently showing */
  liveRange?: Range;
}

function contextParams(ctx: VoiceContext): Record<string, string> {
  const p: Record<string, string> = { today: toIso(new Date()), start: ctx.range.start, end: ctx.range.end, cmp_mode: ctx.cmpMode };
  if (ctx.cmpMode === "custom" && ctx.cmpRange) {
    p.cmp_start = ctx.cmpRange.start;
    p.cmp_end = ctx.cmpRange.end;
  }
  if (ctx.liveRange) {
    p.live_start = ctx.liveRange.start;
    p.live_end = ctx.liveRange.end;
  }
  return p;
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

async function post(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, { method: "POST", ...init });
  } catch {
    throw new ApiError("Backend se rabta nahi ho saka. Kya FastAPI server chal raha hai?", 0);
  }
}

/** Recorded speech -> transcript + dashboard actions. */
export async function sendVoice(audio: Blob, ctx: VoiceContext): Promise<VoiceResult> {
  const qs = new URLSearchParams(contextParams(ctx)).toString();
  const res = await post(`/api/voice/command?${qs}`, { body: audio, headers: { "Content-Type": audio.type || "audio/webm" } });
  return parse<VoiceResult>(res);
}

/** Typed sentence -> dashboard actions (same pipeline without the microphone). */
export async function sendText(text: string, ctx: VoiceContext): Promise<VoiceResult> {
  const res = await post("/api/voice/text", {
    body: JSON.stringify({ text, ...contextParams(ctx) }),
    headers: { "Content-Type": "application/json" },
  });
  return parse<VoiceResult>(res);
}

/** Reply text -> MP3 blob. */
export async function speakText(text: string): Promise<Blob> {
  const res = await post("/api/voice/speak", { body: JSON.stringify({ text }), headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new ApiError("speech failed", res.status);
  return res.blob();
}

/** Best recording format this browser supports (Chrome/Edge/Firefox: webm/opus, Safari: mp4). */
export function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
}
