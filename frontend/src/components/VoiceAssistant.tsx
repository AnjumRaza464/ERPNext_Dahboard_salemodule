"use client";

import { useEffect, useRef, useState } from "react";
import { recorderMimeType, sendText, sendVoice, speakText, type VoiceActions, type VoiceContext, type VoiceResult } from "@/lib/voice";

type Status = "idle" | "listening" | "thinking" | "speaking";

interface Props {
  /** false when the backend has no OPENAI_API_KEY */
  enabled: boolean;
  /** current dashboard state, read at the moment a command is sent */
  getContext: () => VoiceContext;
  onActions: (actions: VoiceActions) => void;
}

const SPEECH_RMS = 0.02; // above this counts as speaking
const END_SILENCE_MS = 1300; // stop this long after the last speech
const NO_SPEECH_MS = 7000; // give up if nothing was said
const MAX_RECORD_MS = 20000;
const EXAMPLES = ["yesterday sale", "comparison", "is mahine ka last year se comparison", "top items dikhao", "kal aur parson ka muqabla"];

function readMuted(): boolean {
  try {
    return localStorage.getItem("sb-voice-muted") === "1";
  } catch {
    return false;
  }
}

/**
 * Microphone button + small panel. Click the mic, speak ("yesterday sale", "comparison", ...);
 * recording stops by itself after a short pause, the backend turns the speech into dashboard
 * actions, the dashboard applies them and the reply is read aloud.
 */
export default function VoiceAssistant({ enabled, getContext, onActions }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState<VoiceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [muted, setMuted] = useState(readMuted);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const cancelledRef = useRef(false);
  const stopRecordingRef = useRef<() => void>(() => {});
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopSpeaking = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  };

  useEffect(() => () => {
    cancelledRef.current = true;
    stopRecordingRef.current();
    stopSpeaking();
  }, []);

  const speak = async (text: string) => {
    if (muted || !text) return;
    setStatus("speaking");
    try {
      const blob = await speakText(text);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      await new Promise<void>((resolve) => {
        audio.onended = audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch {
      // OpenAI speech unavailable: fall back to the browser's own voice
      if (window.speechSynthesis) {
        await new Promise<void>((resolve) => {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = "en-IN";
          u.onend = u.onerror = () => resolve();
          window.speechSynthesis.speak(u);
        });
      }
    } finally {
      audioRef.current = null;
      setStatus((s) => (s === "speaking" ? "idle" : s));
    }
  };

  const handle = async (request: Promise<VoiceResult>) => {
    setStatus("thinking");
    setError(null);
    try {
      const r = await request;
      setResult(r);
      if (r.understood) onActions(r.actions);
      setStatus("idle");
      await speak([r.reply, r.summary].filter(Boolean).join(" "));
    } catch (e) {
      setError((e as Error).message || "Kuch ghalat ho gaya");
      setStatus("idle");
    }
  };

  const startListening = async () => {
    setOpen(true);
    setError(null);
    stopSpeaking();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Is browser mein mic nahi chal sakta. Mic sirf localhost ya https par chalta hai. Neeche likh kar command dein.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("Mic ki ijazat nahi mili. Browser ke address bar mein mic icon se allow karein.");
      return;
    }

    const mime = recorderMimeType();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorderRef.current = recorder;
    cancelledRef.current = false;

    // Simple voice-activity detection so the user does not have to click stop.
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const began = Date.now();
    let spoke = false;
    let lastLoud = began;

    const cleanup = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      audioCtx.close().catch(() => {});
      setLevel(0);
    };
    const stop = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    stopRecordingRef.current = () => {
      cancelledRef.current = true;
      stop();
    };

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms / 0.15));
      const now = Date.now();
      if (rms > SPEECH_RMS) {
        spoke = true;
        lastLoud = now;
      }
      if (spoke && now - lastLoud > END_SILENCE_MS) stop();
      else if (!spoke && now - began > NO_SPEECH_MS) {
        cancelledRef.current = true;
        setError("Koi awaaz nahi suni. Mic button daba kar dobara boliye.");
        stop();
      } else if (now - began > MAX_RECORD_MS) stop();
    }, 100);

    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      cleanup();
      recorderRef.current = null;
      if (cancelledRef.current) {
        setStatus("idle");
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
      handle(sendVoice(blob, getContext()));
    };

    recorder.start();
    setStatus("listening");
  };

  const onMic = () => {
    if (status === "listening") {
      recorderRef.current?.stop(); // finish now and send what was said
    } else if (status === "speaking") {
      stopSpeaking();
      setStatus("idle");
    } else if (status === "idle") {
      startListening();
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (next) stopSpeaking();
    try {
      localStorage.setItem("sb-voice-muted", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const statusText =
    status === "listening" ? "Sun raha hoon… boliye" : status === "thinking" ? "Samajh raha hoon…" : status === "speaking" ? "Jawab suna raha hoon…" : "Mic dabayein aur boliye";

  const micTitle = !enabled
    ? "Voice band hai: backend/.env mein OPENAI_API_KEY set karein"
    : status === "listening"
      ? "Bas karein (abhi bhejein)"
      : status === "speaking"
        ? "Awaaz band karein"
        : "Awaaz se dashboard chalayein";

  return (
    <div className="relative">
      <button
        onClick={onMic}
        disabled={!enabled || status === "thinking"}
        title={micTitle}
        aria-label={micTitle}
        className={`relative inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
          status === "listening" ? "border-bad bg-bad text-white" : "border-line bg-surface text-ink hover:bg-surface-2"
        }`}
      >
        {status === "listening" && (
          <span className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-bad/60" style={{ transform: `scale(${1 + level * 0.25})`, transition: "transform 90ms linear" }} />
        )}
        {status === "thinking" ? (
          <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 12a9 9 0 11-6.2-8.56" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0014 0M12 18v3" />
          </svg>
        )}
        <span className="hidden sm:inline">{status === "listening" ? "Sun raha hoon" : "Voice"}</span>
      </button>

      {open && (
        // fixed, so the reply stays visible while the dashboard scrolls to the requested section
        <div className="card fixed bottom-4 right-4 z-40 flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2.5 p-3 shadow-lg" role="dialog" aria-label="Voice assistant">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink">Voice Assistant</span>
            <div className="flex items-center gap-1">
              <button onClick={toggleMute} className="rounded px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-surface-2" title={muted ? "Jawab awaaz mein sunayein" : "Jawab ki awaaz band karein"}>
                {muted ? "🔇 Awaaz band" : "🔊 Awaaz on"}
              </button>
              <button onClick={() => setOpen(false)} className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-surface-2" aria-label="Band karein">
                ✕
              </button>
            </div>
          </div>

          <p className={`text-xs ${status === "listening" ? "font-medium text-bad" : "text-ink-3"}`}>{statusText}</p>

          {error && <p className="rounded-md border border-bad/40 px-2 py-1.5 text-xs text-bad">{error}</p>}

          {result && (
            <div className="flex flex-col gap-1.5 text-xs">
              {result.transcript && (
                <p className="text-ink-2">
                  <span className="text-ink-3">Aap ne kaha: </span>“{result.transcript}”
                </p>
              )}
              <div className={`rounded-md px-2.5 py-2 ${result.understood ? "bg-accent-soft text-ink" : "bg-surface-2 text-ink-2"}`}>
                <p className="font-medium">{result.reply}</p>
                {result.summary && <p className="tnum mt-0.5">{result.summary}</p>}
              </div>
            </div>
          )}

          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const t = typed.trim();
              if (!t || status === "thinking" || status === "listening") return;
              stopSpeaking();
              setTyped("");
              handle(sendText(t, getContext()));
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Ya yahan likh kar command dein…"
              disabled={!enabled}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink placeholder:text-ink-3"
              aria-label="Command likhein"
            />
            <button type="submit" disabled={!enabled || !typed.trim() || status === "thinking"} className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40">
              Bhejein
            </button>
          </form>

          {!result && (
            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => {
                    if (status !== "idle") return;
                    handle(sendText(ex, getContext()));
                  }}
                  className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-2"
                >
                  “{ex}”
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
