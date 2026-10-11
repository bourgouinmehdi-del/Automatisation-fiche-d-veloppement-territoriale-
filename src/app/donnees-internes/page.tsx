"use client";

import { useEffect, useState } from "react";

interface Summary {
  files: { name: string; size: number; updatedAt: string }[];
  parrains: number;
  groupes: number;
  unmatched: number;
}

const KINDS = [
  {
    id: "action-populaire",
    title: "Export Action Populaire (groupes d'action)",
    help: "Export CSV brut des groupes : les colonnes sont reconnues par leur intitulé (nom, code postal, ville, membres, date de création, type, certification, description, nombre d'actions). La commune est retrouvée par code postal et ville ; les colonnes nominatives (animateurs, contacts) sont ignorées.",
  },
  { id: "groupes", title: "Groupes d'action (format simple)", help: "Colonnes : code_commune ; nom ; membres ; statut ; description." },
  { id: "parrains", title: "Parrainages par commune", help: "Colonnes : code_commune ; parrains (nombre de parrainages, ex. JLM27)." },
];

export default function DonneesInternes() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/interne")
      .then((r) => r.json())
      .then(setSum)
      .catch(() => {});
  }, []);

  async function upload(kind: string, file: File) {
    setBusy(kind);
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("file", file);
    const res = await fetch("/api/interne", { method: "POST", body: fd });
    const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    setMsg((m) => ({ ...m, [kind]: res.ok ? { ok: true, text: `Fichier enregistré : ${d.info}.` } : { ok: false, text: d.error } }));
    if (d.summary) setSum(d.summary);
    setBusy(null);
  }

  async function remove(kind: string) {
    const res = await fetch(`/api/interne?kind=${kind}`, { method: "DELETE" });
    const d = await res.json();
    if (d.summary) setSum(d.summary);
    setMsg((m) => ({ ...m, [kind]: { ok: true, text: "Fichier supprimé." } }));
  }

  const present = (kind: string) => sum?.files.find((f) => f.name === `${kind}.csv`);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-2 text-3xl font-bold text-[var(--accent-strong)]">Données internes</h1>
      <p className="mb-6 text-[var(--ink-2)]">
        Fichiers facultatifs qui complètent les fiches : implantation militante (groupes d&apos;action) et parrainages. Ils restent sur le serveur
        (dossier <code>data/interne/</code>) et ne sont jamais publiés ; placez l&apos;application derrière une authentification si elle est en ligne.
        Les fiches déjà générées les prennent en compte après « Régénérer ».
      </p>
      {sum && (
        <div className="card mb-6 grid grid-cols-3 gap-3 p-4 text-center">
          <div>
            <div className="text-2xl font-bold">{sum.groupes}</div>
            <div className="text-xs text-[var(--ink-2)]">groupes rattachés à une commune</div>
          </div>
          <div>
            <div className="text-2xl font-bold">{sum.parrains}</div>
            <div className="text-xs text-[var(--ink-2)]">communes avec parrainages</div>
          </div>
          <div>
            <div className="text-2xl font-bold">{sum.unmatched}</div>
            <div className="text-xs text-[var(--ink-2)]">groupes sans commune reconnue</div>
          </div>
        </div>
      )}
      <div className="space-y-4">
        {KINDS.map((k) => {
          const f = present(k.id);
          return (
            <section key={k.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{k.title}</h2>
                  <p className="mt-1 text-sm text-[var(--ink-2)]">{k.help}</p>
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    {f ? `Présent — ${Math.round(f.size / 1024)} Ko, mis à jour le ${new Date(f.updatedAt).toLocaleDateString("fr-FR")}` : "Aucun fichier déposé"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <label className={`btn ${busy === k.id ? "opacity-60" : ""} cursor-pointer`}>
                    {busy === k.id ? "Envoi…" : f ? "Remplacer" : "Déposer un CSV"}
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      disabled={!!busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) upload(k.id, file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {f && (
                    <button className="btn" onClick={() => remove(k.id)}>
                      Supprimer
                    </button>
                  )}
                </div>
              </div>
              {msg[k.id] && <p className={`mt-3 text-sm ${msg[k.id].ok ? "text-[#0b6b47]" : "text-[#a12a29]"}`}>{msg[k.id].text}</p>}
            </section>
          );
        })}
      </div>
    </main>
  );
}
