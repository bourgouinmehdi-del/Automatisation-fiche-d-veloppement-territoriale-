"use client";

import { use, useEffect, useState } from "react";
import { playChime } from "@/lib/chime";
import { useRouter } from "next/navigation";

interface Ev {
  step: string;
  label: string;
  done: number;
  total: number;
  status: string;
  mem?: number;
  at: string;
}

/** Étapes séquentielles : terminées dès qu'un événement plus récent arrive. */
const SEQUENTIAL = new Set(["identite", "attente", "collecte", "assemblage", "analyse", "redaction"]);

interface Row {
  step: string;
  label: string;
  start: number;
  end: number | null;
}

/** Regroupe les événements par étape (les étapes de collecte tournent en parallèle). */
function rows(events: Ev[], jobDone: boolean): Row[] {
  const out = new Map<string, Row>();
  events.forEach((e, i) => {
    const t = new Date(e.at).getTime();
    const r = out.get(e.step) ?? { step: e.step, label: e.label, start: t, end: null };
    if (e.status === "done") r.end = t;
    out.set(e.step, r);
    // Une étape séquentielle se termine quand l'événement suivant arrive.
    const prev = events[i - 1];
    if (prev && SEQUENTIAL.has(prev.step) && prev.step !== e.step) {
      const pr = out.get(prev.step);
      if (pr && pr.end == null) pr.end = t;
    }
  });
  const list = [...out.values()].filter((r) => r.step !== "termine");
  if (jobDone) list.forEach((r) => (r.end ??= r.start));
  return list;
}

export default function Generation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState("running");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<Record<string, unknown> | null>(null);
  const [relaunching, setRelaunching] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stop = false;
    let unknownCount = 0;
    // Carillon seulement si on a vu la génération en cours (pas en rouvrant une fiche déjà prête).
    let sawRunning = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/reports/${id}/progress`, { cache: "no-store" });
        const d = await r.json();
        if (stop) return;
        if (d.status === "unknown") {
          // Laisse quelques secondes au serveur (démarrage de la tâche) avant de conclure.
          if (++unknownCount < 5) {
            setTimeout(tick, 1000);
            return;
          }
        } else unknownCount = 0;
        setEvents(d.events ?? []);
        setStatus(d.status);
        if (d.query) setQuery(d.query);
        if (d.status === "interrupted" || d.status === "unknown") return;
        if (d.status === "running") sawRunning = true;
        if (d.status === "done") {
          if (sawRunning) {
            playChime();
            document.title = "Fiche prête";
          }
          router.replace(`/rapport/${id}`);
          return;
        }
        if (d.status === "error") {
          setError(d.error);
          return;
        }
      } catch {
        /* nouvelle tentative */
      }
      setTimeout(tick, 1000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [id, router, attempt]);

  /** Relance la génération (les données déjà téléchargées sont en cache). */
  const relaunch = async () => {
    setRelaunching(true);
    const [code, scope] = id.split("-");
    const body = query ?? { codeInsee: code, scope };
    try {
      const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setError(null);
      setEvents([]);
      setStatus("running");
      if (d.id !== id) router.replace(`/generation/${d.id}`);
      else setAttempt((a) => a + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRelaunching(false);
    }
  };

  const last = events[events.length - 1];
  const pct = events.length ? Math.round((100 * Math.max(...events.map((e) => e.done))) / last.total) : 0;
  const start = events[0] ? new Date(events[0].at).getTime() : 0;
  const list = rows(events, status === "done");
  const running = list.filter((r) => r.end == null);
  const memNow = [...events].reverse().find((e) => e.mem != null)?.mem;
  const memMax = Math.max(0, ...events.map((e) => e.mem ?? 0));
  const failed = status === "interrupted" || status === "unknown" || status === "error";

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold text-[var(--accent-strong)]">Génération de la fiche</h1>
      <p className="mb-6 text-sm text-[var(--ink-2)]">
        La première génération interroge une dizaine de sources publiques (quelques minutes, l&apos;API de l&apos;INSEE limitant le débit). Les
        générations suivantes utilisent le cache.
      </p>
      <div className="card p-5">
        <div className="mb-2 flex justify-between text-sm">
          <span className="font-semibold">
            {!last ? "Démarrage…" : running.length > 1 ? `${running.length} étapes en cours` : (running[0]?.label ?? last.label)}
          </span>
          <span>{pct} %</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-[var(--line)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
        </div>
        <ol className="mt-5 space-y-1 text-sm">
          {list.map((r) => (
            <li key={r.step} className="flex justify-between gap-4">
              <span className={r.end == null ? "font-semibold" : "text-[var(--ink-2)]"}>
                {r.end != null ? "✓ " : failed ? "✗ " : "… "}
                {r.label}
              </span>
              <span className="tabular-nums text-[var(--muted)]">
                {r.end != null ? `${Math.max(0, (r.end - r.start) / 1000).toFixed(0)} s` : `depuis ${((r.start - start) / 1000).toFixed(0)} s`}
              </span>
            </li>
          ))}
        </ol>
        {memNow != null && (
          <p className="mt-3 text-xs text-[var(--muted)]">
            Mémoire du serveur : {memNow} Mo (maximum pendant la génération : {memMax} Mo)
          </p>
        )}
        {(status === "interrupted" || status === "unknown") && (
          <div className="mt-4 rounded border border-[var(--mark)] bg-[var(--mark-soft)] p-3 text-sm text-[var(--danger)]">
            <p className="mb-2 font-semibold">
              {status === "interrupted" ? "La génération a été interrompue : le serveur a redémarré" : "Cette génération n'est plus suivie par le serveur (redémarrage probable)"}
              {running.length ? ` pendant : ${running.map((r) => `« ${r.label} »`).join(", ")}.` : "."}
            </p>
            <p className="mb-3">
              Cause la plus fréquente : mémoire insuffisante sur l&apos;hébergement. Les données déjà téléchargées sont conservées en cache si un
              volume persistant est monté : une relance va plus vite. Si le problème se répète à la même étape, signalez-la.
            </p>
            <button type="button" className="btn" onClick={relaunch} disabled={relaunching}>
              {relaunching ? "Relance…" : "Relancer la génération"}
            </button>{" "}
            <a href="/">Revenir à l&apos;accueil</a>
          </div>
        )}
        {error && (
          <p className="mt-4 rounded box-err p-3 text-sm">
            Échec de la génération : {error}. <a href="/">Revenir à l&apos;accueil</a>
          </p>
        )}
      </div>
    </main>
  );
}
