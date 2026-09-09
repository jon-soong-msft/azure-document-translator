/**
 * Tiny stateless session helper for the app's username/password gate.
 *
 * A successful login issues a signed cookie: `base64url(payload).hmacSHA256`.
 * The payload carries the username + expiry; the signature is an HMAC over the
 * payload using AUTH_SECRET. Verification recomputes the HMAC and checks expiry,
 * so no server-side session store is needed.
 *
 * IMPORTANT: this module runs in BOTH the Edge runtime (middleware) and the
 * Node runtime (API route), so it uses only Web APIs (Web Crypto, btoa/atob) —
 * no Node `Buffer`.
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE = "dt_session";
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface Session {
  username: string;
  /** Expiry as epoch milliseconds. */
  exp: number;
}

export function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function stringFromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64UrlFromBytes(new Uint8Array(signature));
}

/** HMAC-SHA256 sign `data` with `secret`, returned as base64url. Shared with job tokens. */
export async function hmacSign(secret: string, data: string): Promise<string> {
  return sign(secret, data);
}

/** Length-stable comparison to avoid leaking via early exit. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The sign-in gate has no default credentials — ` +
        `set ${name} in your environment (see .env.example) before starting the app.`
    );
  }
  return value;
}

/** Signing secret. Required — there is deliberately no fallback value. */
export function getAuthSecret(): string {
  const secret = required("AUTH_SECRET");
  if (secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters of high-entropy random data.");
  }
  return secret;
}

/** The single valid credential pair. Both are required — no defaults. */
export function getConfiguredCredentials(): { username: string; password: string } {
  return {
    username: required("APP_USERNAME"),
    password: required("APP_PASSWORD"),
  };
}

export async function createSessionToken(
  username: string,
  secret: string = getAuthSecret(),
  ttlMs: number = DEFAULT_TTL_MS
): Promise<string> {
  const payload: Session = { username, exp: Date.now() + ttlMs };
  const encoded = base64UrlFromBytes(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(secret, encoded);
  return `${encoded}.${signature}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
  secret: string = getAuthSecret()
): Promise<Session | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await sign(secret, encoded);
  if (!safeEqual(signature, expected)) return null;

  try {
    const data = JSON.parse(stringFromBase64Url(encoded)) as Session;
    if (!data || typeof data.username !== "string" || typeof data.exp !== "number") {
      return null;
    }
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
