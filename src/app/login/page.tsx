"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function LoginForm() {
  const next = useSearchParams().get("next") || "/";
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login, password }) });
    if (res.ok) {
      // Retour à la page demandée (chemin interne uniquement).
      window.location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/";
      return;
    }
    const d = await res.json().catch(() => ({}));
    setError(d.error ?? "Connexion impossible");
    setBusy(false);
  }
  return (
    <form onSubmit={submit} className="card mx-auto mt-16 max-w-sm space-y-4 p-6">
      <h1 className="text-3xl">Connexion</h1>
      <p className="text-sm text-[var(--ink-2)]">Accès réservé aux membres du pôle. Demandez un identifiant au responsable de l&apos;outil.</p>
      <label className="block text-sm font-semibold">
        Identifiant
        <input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--surface)] p-2 font-normal" required />
      </label>
      <label className="block text-sm font-semibold">
        Mot de passe
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--surface)] p-2 font-normal" required />
      </label>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      <button className="btn btn-primary w-full justify-center" disabled={busy}>
        {busy ? "Connexion…" : "Se connecter"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
