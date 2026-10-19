"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { PASSWORD_MAX, PASSWORD_MIN, passwordSchema } from "@workfolio/shared";
import { buttonClass, Field, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

export default function SetupPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "pending" | "done">("idle");

  useEffect(() => {
    // The token travels in the URL fragment, which browsers never send to any server.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading browser-only state once
    setToken(new URLSearchParams(window.location.hash.slice(1)).get("token"));
    history.replaceState(null, "", window.location.pathname);
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password !== form.get("confirm")) return setError("Passwords do not match.");
    const check = passwordSchema.safeParse(password);
    if (!check.success) return setError(check.error.issues[0]!.message);
    setState("pending");
    setError(null);
    try {
      await api("/auth/setup-password", { method: "POST", body: { token, password } });
      setState("done");
    } catch (err) {
      setError(errorMessage(err));
      setState("idle");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-semibold">Set your password</h1>
        {state === "done" ? (
          <Notice tone="success">
            Password set. Sign in to the Insight Workfolio desktop app
            {" "}(administrators: <Link href="/login" className="underline">dashboard sign-in</Link>).
          </Notice>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6">
            {error && <Notice tone="error">{error}</Notice>}
            {token === null && <Notice tone="warning">Open the full setup link you were given; it contains a one-time code.</Notice>}
            <Field label="New password" hint={`${PASSWORD_MIN}–${PASSWORD_MAX} characters. A short sentence works well.`}>
              <input name="password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} className={inputClass} />
            </Field>
            <Field label="Confirm password">
              <input name="confirm" type="password" autoComplete="new-password" required className={inputClass} />
            </Field>
            <button type="submit" disabled={!token || state === "pending"} className={buttonClass}>
              {state === "pending" ? "Saving…" : "Set password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
