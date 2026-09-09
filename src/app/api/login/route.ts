import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSessionToken,
  getConfiguredCredentials,
} from "@/lib/auth";

export const runtime = "nodejs";

/** Validate credentials and, on success, set the signed session cookie. */
export async function POST(req: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const expected = getConfiguredCredentials();

  if (username !== expected.username || password !== expected.password) {
    return NextResponse.json(
      { error: "Invalid username or password." },
      { status: 401 }
    );
  }

  const token = await createSessionToken(username);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return res;
}

/** Sign out by clearing the session cookie. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
