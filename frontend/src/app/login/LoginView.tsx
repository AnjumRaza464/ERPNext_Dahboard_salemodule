"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { login, type LoginState } from "./actions";

// ---------------------------------------------------------------------------------------------
// Preview data for the hero. Deliberately synthetic: nothing from ERPNext is shown before sign-in.
// Seeded so server and client render the same figures.
// ---------------------------------------------------------------------------------------------
interface Day {
  label: string;
  sales: number;
  cost: number;
  bills: number;
}

function buildDays(): Day[] {
  let seed = 20261031;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const weekday = [1.18, 0.88, 0.9, 0.93, 0.97, 1.12, 1.24]; // Sun..Sat
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const start = new Date(2026, 9, 2);
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const trend = 1 + i * 0.006;
    const sales = Math.round(132000 * weekday[d.getDay()] * trend * (0.92 + rand() * 0.16));
    const cost = Math.round(sales * (0.55 + rand() * 0.09));
    return { label: `${names[d.getDay()]} ${d.getDate()} Oct`, sales, cost, bills: Math.round(sales / (235 + rand() * 40)) };
  });
}

const COST_MIX = [
  { name: "Flour & grains", share: 34 },
  { name: "Dairy & butter", share: 22 },
  { name: "Sugar & sweeteners", share: 14 },
  { name: "Packaging", share: 11 },
  { name: "Fuel & power", share: 10 },
  { name: "Other inputs", share: 9 },
];

type Mode = "sales" | "costing" | "margin";
const MODES: { id: Mode; label: string }[] = [
  { id: "sales", label: "Sales" },
  { id: "costing", label: "Costing" },
  { id: "margin", label: "Margin" },
];

const pkr = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);

/** Animates from 0 to `value` once on mount, then follows `value` directly. */
function useCountUp(value: number, ms = 1400) {
  const [shown, setShown] = useState(0);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      done.current = true;
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setShown(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else done.current = true;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

// ---------------------------------------------------------------------------------------------
// Interactive sales & costing preview
// ---------------------------------------------------------------------------------------------
const W = 600;
const H = 210;
const PAD = { l: 8, r: 8, t: 14, b: 22 };

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-white/50">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
        {label}
      </div>
      <div className="tnum mt-1 truncate text-lg font-semibold tracking-tight text-white">{value}</div>
      <div className="tnum truncate text-[11px] text-white/40">{sub}</div>
    </div>
  );
}

function PreviewBoard() {
  const days = useMemo(() => buildDays(), []);
  const [mode, setMode] = useState<Mode>("sales");
  const [hover, setHover] = useState<number | null>(null);
  const [mixHover, setMixHover] = useState<number | null>(null);

  const totals = useMemo(() => {
    const sales = days.reduce((a, d) => a + d.sales, 0);
    const cost = days.reduce((a, d) => a + d.cost, 0);
    return { sales, cost, bills: days.reduce((a, d) => a + d.bills, 0) };
  }, [days]);

  const animSales = useCountUp(totals.sales);
  const animCost = useCountUp(totals.cost);
  const animBills = useCountUp(totals.bills);

  const d = hover !== null ? days[hover] : null;
  const sales = d ? d.sales : animSales;
  const cost = d ? d.cost : animCost;
  const bills = d ? d.bills : animBills;
  const marginPct = sales > 0 ? ((sales - cost) / sales) * 100 : 0;

  const max = Math.max(...days.map((x) => x.sales)) * 1.08;
  const x = (i: number) => PAD.l + (i / (days.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const line = (key: "sales" | "cost") => days.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = (key: "sales" | "cost") => `${line(key)} L${x(days.length - 1)},${H - PAD.b} L${x(0)},${H - PAD.b} Z`;

  const mPct = days.map((p) => ((p.sales - p.cost) / p.sales) * 100);
  const mMin = 30;
  const mMax = 50;
  const my = (v: number) => PAD.t + (1 - (v - mMin) / (mMax - mMin)) * (H - PAD.t - PAD.b);
  const marginLine = mPct.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${my(v).toFixed(1)}`).join(" ");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((rel - PAD.l) / (W - PAD.l - PAD.r)) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  const salesOn = mode !== "margin";
  const costOn = mode !== "margin";
  const tipLeft = hover !== null ? (x(hover) / W) * 100 : 0;

  return (
    <div className="login-rise relative rounded-2xl border border-white/[0.08] bg-[#0b0d12]/80 p-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)] backdrop-blur-xl sm:p-5" style={{ animationDelay: "120ms" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="live-dot live-dot-on" />
            Live board preview
          </div>
          <div className="text-[11px] text-white/40">{d ? d.label : "Last 30 days"} · illustrative figures, PKR</div>
        </div>
        <div role="tablist" aria-label="Preview metric" className="flex rounded-lg border border-white/[0.08] bg-white/[0.03] p-0.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => setMode(m.id)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${mode === m.id ? "bg-white text-[#0b0d12] shadow" : "text-white/60 hover:text-white"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Net sales" value={`Rs ${pkr(sales)}`} sub={d ? `${bills.toFixed(0)} bills` : `${Math.round(bills).toLocaleString("en-US")} bills`} tone="#4f97f0" />
        <Kpi label="Cost of goods" value={`Rs ${pkr(cost)}`} sub={`${sales ? ((cost / sales) * 100).toFixed(1) : "0.0"}% of sales`} tone="#ff8a4c" />
        <Kpi label="Gross margin" value={`${marginPct.toFixed(1)}%`} sub={`Rs ${pkr(sales - cost)} kept`} tone="#22c58b" />
        <Kpi label="Avg bill" value={`Rs ${bills > 0 ? Math.round(sales / bills).toLocaleString("en-US") : "0"}`} sub="per customer" tone="#f5b14c" />
      </div>

      <div className="relative mt-4">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full cursor-crosshair touch-none select-none"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label="Illustrative 30-day chart of sales, cost of goods and gross margin"
        >
          <defs>
            <linearGradient id="lg-sales" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f97f0" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#4f97f0" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="lg-cost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff8a4c" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#ff8a4c" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * (H - PAD.t - PAD.b)} y2={PAD.t + f * (H - PAD.t - PAD.b)} stroke="rgba(255,255,255,0.06)" strokeDasharray="3 5" />
          ))}

          {/* margin bars (sales - cost per day) */}
          {mode === "margin" &&
            days.map((p, i) => {
              const bw = ((W - PAD.l - PAD.r) / days.length) * 0.62;
              const top = my(mPct[i]);
              return (
                <rect
                  key={p.label}
                  className="login-bar"
                  style={{ animationDelay: `${i * 18}ms` }}
                  x={x(i) - bw / 2}
                  y={top}
                  width={bw}
                  height={H - PAD.b - top}
                  rx={2}
                  fill={hover === i ? "#22c58b" : "rgba(34,197,139,0.35)"}
                />
              );
            })}

          <g style={{ opacity: salesOn ? (mode === "costing" ? 0.35 : 1) : 0, transition: "opacity .4s" }}>
            <path d={area("sales")} fill="url(#lg-sales)" />
            <path key={`s-${mode}`} className="login-draw" d={line("sales")} fill="none" stroke="#4f97f0" strokeWidth="2.2" strokeLinejoin="round" pathLength={1} />
          </g>
          <g style={{ opacity: costOn ? (mode === "sales" ? 0.45 : 1) : 0, transition: "opacity .4s" }}>
            <path d={area("cost")} fill="url(#lg-cost)" />
            <path key={`c-${mode}`} className="login-draw" d={line("cost")} fill="none" stroke="#ff8a4c" strokeWidth="2" strokeLinejoin="round" pathLength={1} style={{ animationDelay: "150ms" }} />
          </g>
          {mode === "margin" && <path key="m" className="login-draw" d={marginLine} fill="none" stroke="#5ff0b8" strokeWidth="2" strokeLinejoin="round" pathLength={1} />}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t - 6} y2={H - PAD.b} stroke="rgba(255,255,255,0.35)" strokeDasharray="2 3" />
              {mode !== "margin" ? (
                <>
                  <circle cx={x(hover)} cy={y(days[hover].sales)} r="4.5" fill="#0b0d12" stroke="#4f97f0" strokeWidth="2" />
                  <circle cx={x(hover)} cy={y(days[hover].cost)} r="4.5" fill="#0b0d12" stroke="#ff8a4c" strokeWidth="2" />
                </>
              ) : (
                <circle cx={x(hover)} cy={my(mPct[hover])} r="4.5" fill="#0b0d12" stroke="#5ff0b8" strokeWidth="2" />
              )}
            </g>
          )}
          {[0, 7, 14, 21, 29].map((i) => (
            <text key={i} x={x(i)} y={H - 5} textAnchor={i === 0 ? "start" : i === 29 ? "end" : "middle"} fill="rgba(255,255,255,0.35)" fontSize="10">
              {days[i].label.slice(4)}
            </text>
          ))}
        </svg>

        {d && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-white/10 bg-[#11141b]/95 px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur"
            style={{ left: `${tipLeft}%`, transform: `translateX(${tipLeft > 70 ? "calc(-100% - 10px)" : "10px"})` }}
          >
            <div className="font-semibold text-white">{d.label}</div>
            <div className="tnum mt-0.5 flex gap-3 text-white/60">
              <span><span className="text-[#4f97f0]">●</span> Rs {pkr(d.sales)}</span>
              <span><span className="text-[#ff8a4c]">●</span> Rs {pkr(d.cost)}</span>
              <span><span className="text-[#22c58b]">●</span> {(((d.sales - d.cost) / d.sales) * 100).toFixed(1)}%</span>
            </div>
          </div>
        )}
      </div>

      {/* cost head mix */}
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-white/45">
          <span>Where the cost goes</span>
          <span className="tnum text-white/70">{mixHover !== null ? `${COST_MIX[mixHover].name} · ${COST_MIX[mixHover].share}%` : "hover a segment"}</span>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.04]" onPointerLeave={() => setMixHover(null)}>
          {COST_MIX.map((c, i) => (
            <div
              key={c.name}
              onPointerEnter={() => setMixHover(i)}
              className="login-grow h-full cursor-pointer transition-opacity"
              style={{
                width: `${c.share}%`,
                animationDelay: `${300 + i * 80}ms`,
                background: `color-mix(in srgb, #ff8a4c ${100 - i * 13}%, #f5b14c)`,
                opacity: mixHover === null || mixHover === i ? 1 : 0.3,
                marginRight: i < COST_MIX.length - 1 ? 2 : 0,
              }}
              title={`${c.name} · ${c.share}%`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

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
// Page
// ---------------------------------------------------------------------------------------------
const FEATURES = [
  { title: "Live sales board", body: "Today against the usual weekday, hour by hour", icon: "M3 17l5-5 4 4 8-8M15 8h5v5" },
  { title: "Costing per item", body: "Recipe cost, food cost % and margin", icon: "M4 19V9m6 10V5m6 14v-7m4 7H2" },
  { title: "Production forecast", body: "Tomorrow's bake plan from real demand", icon: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" },
  { title: "Ask by voice", body: "“Aaj ki sale kitni hai?” — answered on screen", icon: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3" },
];

export default function LoginView({ next, configured }: { next: string; configured: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  const onMove = (e: React.PointerEvent) => {
    const el = root.current;
    if (!el) return;
    el.style.setProperty("--mx", `${e.clientX}px`);
    el.style.setProperty("--my", `${e.clientY}px`);
  };

  return (
    <div ref={root} onPointerMove={onMove} className="login-root relative min-h-screen overflow-hidden bg-[#06070a] text-white">
      {/* backdrop: grid, glows and a spotlight that follows the pointer */}
      <div className="login-grid pointer-events-none absolute inset-0" aria-hidden />
      <div className="login-float pointer-events-none absolute -left-40 top-[-10%] h-[520px] w-[520px] rounded-full bg-[#3987e5]/25 blur-[120px]" aria-hidden />
      <div className="login-float pointer-events-none absolute -right-32 bottom-[-15%] h-[560px] w-[560px] rounded-full bg-[#ff8a4c]/20 blur-[130px]" style={{ animationDelay: "-6s" }} aria-hidden />
      <div className="login-spot pointer-events-none absolute inset-0" aria-hidden />

      <div className="relative mx-auto flex min-h-screen max-w-[1320px] flex-col px-4 py-6 sm:px-8 lg:py-8">
        <header className="login-rise flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#3987e5] to-[#ff8a4c] text-[15px] font-bold tracking-tight shadow-[0_8px_24px_-8px_rgba(57,135,229,0.9)]">
              SB
            </div>
            <div>
              <div className="text-[17px] font-semibold leading-tight">Sindh Bakery</div>
              <div className="text-xs text-white/45">Sales &amp; Costing Intelligence</div>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-xs text-white/60 backdrop-blur sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#22c58b]" />
            Powered by ERPNext · PKR
          </div>
        </header>

        <main className="grid flex-1 items-center gap-10 py-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
          <section className="order-2 flex min-w-0 flex-col gap-7 lg:order-1">
            <div className="login-rise flex flex-col gap-5" style={{ animationDelay: "60ms" }}>
              <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#4f97f0]/30 bg-[#4f97f0]/10 px-3 py-1 text-xs font-medium text-[#9cc5ff]">
                <span className="live-dot live-dot-on" style={{ width: 6, height: 6 }} />
                Sales · Costing · Forecast — one board
              </span>
              <h1 className="text-[38px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-5xl xl:text-[58px]">
                Every sale, every cost,
                <br />
                <span className="bg-gradient-to-r from-[#6aa8ff] via-[#f5b14c] to-[#ff8a4c] bg-clip-text text-transparent">baked into one view.</span>
              </h1>
              <p className="max-w-[560px] text-[15px] leading-relaxed text-white/55 sm:text-base">
                Follow the counter live, see what each loaf and cake really costs to make, and know tomorrow&apos;s bake before the ovens are on.
              </p>
            </div>

            <PreviewBoard />

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {FEATURES.map((f, i) => (
                <div
                  key={f.title}
                  className="login-rise group flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 transition hover:border-white/15 hover:bg-white/[0.04]"
                  style={{ animationDelay: `${240 + i * 70}ms` }}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-[#9cc5ff] transition group-hover:text-[#f5b14c]">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d={f.icon} />
                    </svg>
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-white">{f.title}</span>
                    <span className="block text-[12.5px] leading-snug text-white/45">{f.body}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="order-1 flex justify-center lg:sticky lg:top-8 lg:order-2 lg:justify-end">
            <SignInCard next={next} configured={configured} />
          </section>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-5 text-xs text-white/35">
          <span>© {new Date().getFullYear()} Sindh Bakery · Confidential company data</span>
          <span>No figures are shown until you sign in</span>
        </footer>
      </div>
    </div>
  );
}
