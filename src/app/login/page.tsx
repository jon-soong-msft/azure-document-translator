"use client";

import { useState } from "react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Sign in failed.");
      }
      // Return to the page the user was trying to reach (defaults to home).
      const from = new URLSearchParams(window.location.search).get("from");
      window.location.href = from && from.startsWith("/") ? from : "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900/60 p-7 shadow-2xl backdrop-blur">
        <div className="mb-6 text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Secure access
          </div>
          <h1 className="bg-gradient-to-r from-white via-blue-100 to-purple-200 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
            Document Translator
          </h1>
          <p className="mt-2 text-sm text-slate-400">Sign in to continue.</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-slate-300">Username</span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              className="w-full rounded-lg border border-white/10 bg-slate-800/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-slate-300">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-white/10 bg-slate-800/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30"
            />
          </label>

          {error ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
