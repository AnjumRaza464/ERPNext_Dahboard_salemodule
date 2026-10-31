"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  authConfigured,
  configuredUsers,
  createSession,
  REMEMBER_DAYS,
  safeEqual,
  safeNext,
  SESSION_COOKIE,
  SESSION_HOURS,
} from "@/lib/session";

export interface LoginState {
  error: string | null;
  attempt: number; // bumps on every failure so the form can replay its shake
  username: string; // echoed back so the field survives React's post-action form reset
}

export async function login(prev: LoginState, form: FormData): Promise<LoginState> {
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const remember = form.get("remember") === "on";
  const fail = (error: string): LoginState => ({ error, attempt: prev.attempt + 1, username });

  if (!authConfigured()) return fail("Sign-in is not configured on this server. Set DASHBOARD_USERS and AUTH_SECRET.");
  if (!username || !password) return fail("Enter your username and password.");

  const expected = configuredUsers().get(username);
  // Compare against a dummy when the user is unknown so both paths take the same time.
  const ok = await safeEqual(password, expected ?? "\u0000no-such-user");
  if (!expected || !ok) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return fail("That username and password don't match.");
  }

  const maxAge = remember ? REMEMBER_DAYS * 86400 : SESSION_HOURS * 3600;
  (await cookies()).set(SESSION_COOKIE, await createSession(username, maxAge), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  redirect(safeNext(form.get("next")));
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
