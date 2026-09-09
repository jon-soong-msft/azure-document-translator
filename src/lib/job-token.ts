/**
 * Stateless signed tokens for async PDF translation jobs.
 *
 * A large PDF is split into page-range chunks translated as parallel batch
 * jobs. Rather than keep that job state on the server (which wouldn't survive
 * Container Apps scaling to another replica), the whole descriptor — which
 * blobs to poll and merge — is encoded into a signed token the client holds:
 *
 *   base64url(json) + "." + hmacSHA256(base64url(json))
 *
 * This reuses the exact scheme and primitives as the auth session cookie
 * (see {@link ./auth}), signed with AUTH_SECRET. Verification recomputes the
 * HMAC, so a client can't tamper with the blob names it asks us to read.
 *
 * Uses only Web Crypto (via the auth helpers), so it works in both the Edge and
 * Node runtimes.
 */

import {
  base64UrlFromBytes,
  stringFromBase64Url,
  hmacSign,
  getAuthSecret,
} from "./auth";

const encoder = new TextEncoder();

/** Thrown when a job token is missing, malformed, tampered with, or unreadable. */
export class JobTokenError extends Error {
  constructor(message = "Invalid or expired translation job token.") {
    super(message);
    this.name = "JobTokenError";
  }
}

/** Length-stable comparison to avoid leaking via early exit. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signs a job descriptor into a `payload.signature` token. */
export async function signJob<T>(payload: T): Promise<string> {
  const encoded = base64UrlFromBytes(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSign(getAuthSecret(), encoded);
  return `${encoded}.${signature}`;
}

/** Verifies a job token's signature and returns its payload, or null if invalid. */
export async function verifyJob<T>(token: string): Promise<T | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await hmacSign(getAuthSecret(), encoded);
  if (!safeEqual(signature, expected)) return null;

  try {
    return JSON.parse(stringFromBase64Url(encoded)) as T;
  } catch {
    return null;
  }
}
