// Signed session cookie for the dashboard sign-in. Uses Web Crypto only, so the same code runs in
// proxy.ts and in server actions. Token = base64url(payload) + "." + base64url(HMAC-SHA256).

export const SESSION_COOKIE = "sb_session";
export const SESSION_HOURS = 12;
export const REMEMBER_DAYS = 7;

export interface Session {
  u: string; // username
  exp: number; // expiry, epoch seconds
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function secret(): string | null {
  const s = process.env.AUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

async function hmacKey(s: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(s), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Users from DASHBOARD_USERS, e.g. "admin:s3cret,owner:other". Passwords may contain ':'. */
export function configuredUsers(): Map<string, string> {
  const users = new Map<string, string>();
  for (const part of (process.env.DASHBOARD_USERS ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i > 0) users.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return users;
}

export function authConfigured(): boolean {
  return secret() !== null && configuredUsers().size > 0;
}

/** Constant-time string comparison (both sides hashed first so lengths match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function createSession(username: string, maxAgeSec: number): Promise<string> {
  const s = secret();
  if (!s) throw new Error("AUTH_SECRET is not set");
  const payload: Session = { u: username, exp: Math.floor(Date.now() / 1000) + maxAgeSec };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(s), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function readSession(token: string | undefined): Promise<Session | null> {
  const s = secret();
  if (!s || !token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(s), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    return typeof payload.u === "string" && payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

/** Only same-site paths are allowed as a post-login destination. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}
