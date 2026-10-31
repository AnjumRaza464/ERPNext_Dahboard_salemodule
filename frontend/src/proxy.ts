import { NextResponse, type NextRequest } from "next/server";
import { readSession, SESSION_COOKIE } from "@/lib/session";

// Every dashboard page needs a signed session; the login page itself and static assets do not.
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login") {
    // Already signed in: skip the form.
    return session ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (session) return NextResponse.next();

  const url = new URL("/login", request.url);
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt)$).*)"],
};
