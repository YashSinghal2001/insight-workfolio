"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { buttonClass, Field, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

export default function LoginPage() {
  const { auth, reload } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (auth.status === "authenticated") router.replace("/");
  }, [auth.status, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", body: { email: form.get("email"), password: form.get("password") } });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-semibold">
          Insight <span className="text-brand">Workfolio</span>
        </h1>
        <p className="mb-6 text-center text-sm text-muted">Sign in to the admin dashboard</p>
        <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6">
          {error && <Notice tone="error">{error}</Notice>}
          <Field label="Email">
            <input name="email" type="email" autoComplete="username" required className={inputClass} />
          </Field>
          <Field label="Password">
            <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
          </Field>
          <button type="submit" disabled={pending} className={buttonClass}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-muted">
          New accounts are activated with a one-time setup link from your administrator.
        </p>
      </div>
    </main>
  );
}
