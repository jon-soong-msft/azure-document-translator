import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Paths reachable without a session (the login screen + its API).
const PUBLIC_PATHS = ["/login", "/api/login"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);

  // Already signed in but visiting /login -> send to the app.
  if (session && pathname === "/login") {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Not signed in and the path isn't public -> block it.
  if (!session && !isPublic(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search =
      pathname && pathname !== "/" ? `?from=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals, the favicon and the public PDF
  // worker (which the comparison view fetches client-side).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pdf.worker.min.mjs).*)"],
};
