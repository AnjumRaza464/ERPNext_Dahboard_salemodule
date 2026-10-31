import type { Metadata } from "next";
import { authConfigured, safeNext } from "@/lib/session";
import LoginView from "./LoginView";

export const metadata: Metadata = {
  title: "Sign in · Sindh Bakery Analytics",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <LoginView next={safeNext(next)} configured={authConfigured()} />;
}
