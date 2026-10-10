"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Ev {
  step: string;
  label: string;
  done: number;
  total: number;
  status: string;
  at: string;
}

export default function Generation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState("running");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/reports/${id}/progress`, { cache: "no-store" });
        const d = await r.json();
        if (stop) return;
        setEvents(d.events ?? []);
        setStatus(d.status);
        if (d.status === "done") {
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
  }, [id, router]);

  const last = events[events.length - 1];
  const pct = last ? Math.round((100 * last.done) / last.total) : 0;
  const start = events[0] ? new Date(events[0].at).getTime() : 0;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold text-[var(--accent-strong)]">Génération de la fiche</h1>
      <p className="mb-6 text-sm text-[var(--ink-2)]">
        La première génération interroge une dizaine de sources publiques (quelques minutes, l&apos;API de l&apos;INSEE limitant le débit). Les
        générations suivantes utilisent le cache.
      </p>
      <div className="card p-5">
        <div className="mb-2 flex justify-between text-sm">
          <span className="font-semibold">{last?.label ?? "Démarrage…"}</span>
          <span>{pct} %</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-[#e7e6e2]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
        </div>
        <ol className="mt-5 space-y-1 text-sm">
          {events.map((e, i) => (
            <li key={i} className="flex justify-between gap-4">
              <span className={i === events.length - 1 && status === "running" ? "font-semibold" : "text-[var(--ink-2)]"}>
                {i < events.length - 1 || status !== "running" ? "✓ " : "… "}
                {e.label}
              </span>
              <span className="tabular-nums text-[var(--muted)]">{((new Date(e.at).getTime() - start) / 1000).toFixed(0)} s</span>
            </li>
          ))}
        </ol>
        {error && (
          <p className="mt-4 rounded bg-[#fdecea] p-3 text-sm text-[#a12a29]">
            Échec de la génération : {error}. <a href="/">Revenir à l&apos;accueil</a>
          </p>
        )}
      </div>
    </main>
  );
}
