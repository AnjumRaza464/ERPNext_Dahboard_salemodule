"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { login, type LoginState } from "./actions";
import BakeryScene from "./BakeryScene";
import { MODES, type SceneMode } from "./sceneData";

// ---------------------------------------------------------------------------------------------
// Sign-in form
// ---------------------------------------------------------------------------------------------
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="group relative mt-2 flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-[#3987e5] via-[#5a7cf0] to-[#ff8a4c] text-sm font-semibold text-white shadow-[0_12px_30px_-10px_rgba(57,135,229,0.8)] transition hover:shadow-[0_16px_40px_-10px_rgba(255,138,76,0.7)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-wait disabled:opacity-80"
    >
      <span className="login-sheen pointer-events-none absolute inset-0" />
      {pending ? (
        <>
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
            <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          Signing in…
        </>
      ) : (
        <>
          Sign in to dashboard
          <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </>
      )}
    </button>
  );
}

const fieldCls =
  "peer h-12 w-full rounded-xl border border-white/10 bg-white/[0.04] pl-11 pr-11 text-[15px] text-white placeholder-white/30 outline-none transition focus:border-[#4f97f0] focus:bg-white/[0.06] focus:ring-4 focus:ring-[#4f97f0]/15";

function SignInCard({ next, configured }: { next: string; configured: boolean }) {
  const [state, action] = useActionState<LoginState, FormData>(login, { error: null, attempt: 0, username: "" });
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  // Shake the card on every failed attempt.
  useEffect(() => {
    if (!state.attempt || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    card.current?.animate(
      [0, -7, 7, -7, 7, -4, 2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 450, easing: "cubic-bezier(0.36, 0.07, 0.19, 0.97)" },
    );
  }, [state.attempt]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);

  return (
    <div ref={card} className="login-rise relative w-full max-w-[440px]">
      <div className="absolute -inset-px rounded-[22px] bg-gradient-to-b from-white/20 via-white/[0.04] to-[#ff8a4c]/25" aria-hidden />
      <div className="relative rounded-[21px] bg-[#0c0e14]/90 p-7 shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-9">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#3987e5] to-[#ff8a4c] shadow-[0_10px_30px_-8px_rgba(57,135,229,0.8)]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        </div>
        <h2 className="mt-6 text-[28px] font-semibold tracking-tight text-white">Welcome back</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-white/50">Sign in to see today&apos;s sales, costing and production numbers.</p>

        <form action={action} className="mt-7 flex flex-col gap-4" noValidate>
          <input type="hidden" name="next" value={next} />

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-white/80">Username</span>
            <span className="relative">
              <svg className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-white/35 peer-focus:text-[#4f97f0]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
              </svg>
              <input key={state.attempt} name="username" defaultValue={state.username} autoComplete="username" autoFocus={!state.attempt} required placeholder="e.g. admin" className={fieldCls} aria-invalid={!!state.error} />
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-[13px] font-medium text-white/80">
              Password
              {caps && <span className="rounded-md bg-[#f5b14c]/15 px-1.5 py-0.5 text-[11px] font-medium text-[#f5b14c]">Caps Lock is on</span>}
            </span>
            <span className="relative">
              <svg className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-white/35" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
                <path d="M8 10.5V7.5a4 4 0 018 0v3" />
              </svg>
              <input
                name="password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                required
                placeholder="••••••••••"
                onKeyDown={onKey}
                onKeyUp={onKey}
                className={fieldCls}
                aria-invalid={!!state.error}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/[0.06] hover:text-white"
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.2A10 10 0 0112 5c5 0 9 4.5 10 7-0.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.4 4.4-1.1" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </span>
          </label>

          <label className="flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-white/60">
            <input type="checkbox" name="remember" className="h-4 w-4 rounded border-white/20 bg-white/5 accent-[#4f97f0]" />
            Keep me signed in for 7 days
          </label>

          {(state.error || !configured) && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-[#e66767]/30 bg-[#e66767]/10 px-3 py-2.5 text-[13px] text-[#ffb3b3]">
              <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4m0 4h.01" />
              </svg>
              {state.error ?? "Sign-in is not configured on this server. Set DASHBOARD_USERS and AUTH_SECRET."}
            </div>
          )}

          <SubmitButton />
        </form>

        <div className="mt-6 flex items-center gap-2 border-t border-white/[0.06] pt-5 text-[12px] text-white/40">
          <svg className="h-3.5 w-3.5 text-[#22c58b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
            <path d="M8 10.5V7.5a4 4 0 018 0v3" />
          </svg>
          Authorised staff only · session ends after 12 hours
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 3D tilt for the sign-in card
// ---------------------------------------------------------------------------------------------
function TiltCard({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.setProperty("--rx", `${(0.5 - py) * 7}deg`);
    el.style.setProperty("--ry", `${(px - 0.5) * 9}deg`);
    el.style.setProperty("--gx", `${px * 100}%`);
    el.style.setProperty("--gy", `${py * 100}%`);
  };
  const leave = () => {
    ref.current?.style.setProperty("--rx", "0deg");
    ref.current?.style.setProperty("--ry", "0deg");
  };
  return (
    <div className="login-tilt-wrap w-full max-w-[440px]" onPointerMove={move} onPointerLeave={leave}>
      <div ref={ref} className="login-tilt relative">
        {children}
        <div className="login-glare pointer-events-none absolute inset-0 rounded-[22px]" aria-hidden />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Feature tabs: each one reshapes the 3D board
// ---------------------------------------------------------------------------------------------
const CYCLE_MS = 6000;

function FeatureTabs({ mode, onPick, cycling }: { mode: SceneMode; onPick: (m: SceneMode) => void; cycling: boolean }) {
  return (
    <div role="tablist" aria-label="What is inside the dashboard" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {MODES.map((m) => {
        const active = m.id === mode;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onPick(m.id)}
            onPointerEnter={(e) => e.pointerType === "mouse" && onPick(m.id)}
            onFocus={() => onPick(m.id)}
            className={`group relative flex items-center gap-2.5 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition ${
              active ? "border-white/20 bg-white/[0.07]" : "border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
            }`}
            style={active ? { boxShadow: `0 0 0 1px ${m.color}55, 0 12px 30px -14px ${m.color}` } : undefined}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition"
              style={{ background: active ? `${m.color}26` : "rgba(255,255,255,0.05)", color: active ? m.color : "rgba(255,255,255,0.55)" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d={m.icon} />
              </svg>
            </span>
            <span className={`truncate text-[13px] font-semibold ${active ? "text-white" : "text-white/65"}`}>{m.tab}</span>
            {active && cycling && (
              <span key={m.id} className="login-progress absolute inset-x-0 bottom-0 h-[2px] origin-left" style={{ background: m.color, animationDuration: `${CYCLE_MS}ms` }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------
export default function LoginView({ next, configured }: { next: string; configured: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SceneMode>("sales");
  const [cycling, setCycling] = useState(true);
  const info = MODES.find((m) => m.id === mode)!;

  // Walk through the features until the visitor picks one.
  useEffect(() => {
    if (!cycling || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setTimeout(() => {
      const i = MODES.findIndex((m) => m.id === mode);
      setMode(MODES[(i + 1) % MODES.length].id);
    }, CYCLE_MS);
    return () => clearTimeout(t);
  }, [mode, cycling]);

  const pick = (m: SceneMode) => {
    setCycling(false);
    setMode(m);
  };

  const onMove = (e: React.PointerEvent) => {
    root.current?.style.setProperty("--mx", `${e.clientX}px`);
    root.current?.style.setProperty("--my", `${e.clientY}px`);
  };

  return (
    <div ref={root} onPointerMove={onMove} className="login-root relative min-h-screen overflow-clip bg-[#05060a] text-white">
      {/* backdrop: grid, glows and a spotlight that follows the pointer */}
      <div className="login-grid pointer-events-none absolute inset-0" aria-hidden />
      <div className="login-float pointer-events-none absolute -left-40 top-[-10%] h-[520px] w-[520px] rounded-full bg-[#3987e5]/20 blur-[120px]" aria-hidden />
      <div className="login-float pointer-events-none absolute -right-32 bottom-[-15%] h-[560px] w-[560px] rounded-full bg-[#ff8a4c]/15 blur-[130px]" style={{ animationDelay: "-6s" }} aria-hidden />
      <div
        className="pointer-events-none absolute left-[30%] top-[45%] h-[460px] w-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[140px] transition-colors duration-1000"
        style={{ background: `${info.color}1f` }}
        aria-hidden
      />
      <div className="login-spot pointer-events-none absolute inset-0" aria-hidden />

      <div className="relative mx-auto flex min-h-screen max-w-[1360px] flex-col px-4 py-6 sm:px-8 lg:py-8">
        <header className="login-rise flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#3987e5] to-[#ff8a4c] text-[15px] font-bold tracking-tight shadow-[0_8px_24px_-8px_rgba(57,135,229,0.9)]">
              SB
            </div>
            <div>
              <div className="text-[17px] font-semibold leading-tight">Sindh Bakery</div>
              <div className="text-xs text-white/45">Sales, Costing &amp; Production Intelligence</div>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-xs text-white/60 backdrop-blur sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#22c58b]" />
            Powered by ERPNext · PKR
          </div>
        </header>

        <main className="grid flex-1 items-center gap-8 py-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:gap-10">
          <section className="order-2 flex min-w-0 flex-col gap-5 lg:order-1">
            <div className="login-rise flex flex-col gap-4" style={{ animationDelay: "60ms" }}>
              <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#4f97f0]/30 bg-[#4f97f0]/10 px-3 py-1 text-xs font-medium text-[#9cc5ff]">
                <span className="live-dot live-dot-on" style={{ width: 6, height: 6 }} />
                Sales · Costing · Forecast · Stock — one board
              </span>
              <h1 className="text-[36px] font-semibold leading-[1.04] tracking-[-0.03em] sm:text-5xl xl:text-[56px]">
                Every sale, every cost,
                <br />
                <span className="bg-gradient-to-r from-[#6aa8ff] via-[#f5b14c] to-[#ff8a4c] bg-clip-text text-transparent">baked into one view.</span>
              </h1>
              <p className="max-w-[580px] text-[15px] leading-relaxed text-white/55 sm:text-base">
                Follow the counter live, see what each loaf and cake really costs to make, and know tomorrow&apos;s bake before the ovens are on.
              </p>
            </div>

            {/* the 3D board */}
            <div className="login-rise relative" style={{ animationDelay: "140ms" }}>
              <div className="relative h-[280px] sm:h-[400px] lg:h-[440px]">
                <BakeryScene mode={mode} className="login-scene-mask absolute -inset-x-6 -inset-y-4 sm:-inset-x-10" />

                <div className="pointer-events-none absolute right-0 top-0 hidden items-center gap-1.5 rounded-full border border-white/[0.08] bg-[#0b0d12]/70 px-2.5 py-1 text-[11px] text-white/45 backdrop-blur sm:flex">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M9 11V5a2 2 0 014 0v6m0-2a2 2 0 014 0v4a6 6 0 01-6 6h-1a6 6 0 01-5.2-3L3 14a2 2 0 013.4-2l2.6 3" />
                  </svg>
                  Move &amp; hover the bars · illustrative data
                </div>
              </div>

              <div
                key={info.id}
                className="login-swap relative mt-2 w-full rounded-2xl sm:absolute sm:bottom-0 sm:left-0 sm:mt-0 sm:w-[340px] border border-white/[0.08] bg-[#0b0d12]/80 p-3.5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)] backdrop-blur-xl"
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <span className="h-2 w-2 rounded-full" style={{ background: info.color, boxShadow: `0 0 12px ${info.color}` }} />
                  {info.title}
                </div>
                <p className="mt-1 text-[12px] leading-snug text-white/50">{info.body}</p>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  {info.kpis.map((k) => (
                    <div key={k.label} className="min-w-0 rounded-lg bg-white/[0.04] px-2 py-1.5">
                      <div className="truncate text-[10px] text-white/40">{k.label}</div>
                      <div className="tnum truncate text-[13px] font-semibold text-white">{k.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="login-rise" style={{ animationDelay: "220ms" }}>
              <FeatureTabs mode={mode} onPick={pick} cycling={cycling} />
            </div>
          </section>

          <section className="order-1 flex justify-center lg:sticky lg:top-8 lg:order-2 lg:justify-end">
            <TiltCard>
              <SignInCard next={next} configured={configured} />
            </TiltCard>
          </section>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-5 text-xs text-white/35">
          <span>© {new Date().getFullYear()} Sindh Bakery · Confidential company data</span>
          <span>No real figures are shown until you sign in</span>
        </footer>
      </div>
    </div>
  );
}
