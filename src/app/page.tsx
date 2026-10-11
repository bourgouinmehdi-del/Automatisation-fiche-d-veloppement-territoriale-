"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Candidate {
  code: string;
  nom: string;
  codesPostaux: string[];
  departement: string;
  departementNom: string;
  population: number | null;
}

interface Listed {
  id: string;
  nom: string;
  departement: string;
  scope: string;
  updatedAt: string;
  version: number;
}

const SCOPES = [
  { id: "commune", label: "Commune", help: "Analyse centrée sur la commune, comparée à son intercommunalité, son département, sa région et la France." },
  { id: "epci", label: "Intercommunalité", help: "Indicateurs de l'intercommunalité, tableau de ses communes membres." },
  { id: "departement", label: "Département (ciblage)", help: "Compare toutes les communes du département et propose les territoires où concentrer l'effort militant, comme la fiche Yonne." },
  { id: "custom", label: "Territoire personnalisé", help: "Liste de communes choisies (codes INSEE)." },
];

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cands, setCands] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState("commune");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Listed[]>([]);

  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.json())
      .then((d) => setRecent(d.reports ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || (/^\d+$/.test(query) && query.length < 5)) {
      setCands([]);
      setSelected(null);
      return;
    }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/communes?q=${encodeURIComponent(query)}`);
      const d = await r.json().catch(() => ({ error: `Erreur serveur (HTTP ${r.status})` }));
      setError(r.ok ? null : d.error ?? `Erreur serveur (HTTP ${r.status})`);
      setCands(d.communes ?? []);
      setSelected(d.communes?.length === 1 ? d.communes[0].code : null);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  async function generate() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codeInsee: selected,
        codePostal: /^\d{5}$/.test(q.trim()) ? q.trim() : undefined,
        scope,
        customCommunes: scope === "custom" ? custom.split(/[\s,;]+/).filter(Boolean) : undefined,
      }),
    });
    const d = await res.json();
    if (!res.ok) {
      setError(d.error ?? "Erreur");
      setBusy(false);
      return;
    }
    router.push(`/generation/${d.id}`);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-1 text-xs font-semibold uppercase tracking-[.12em] text-[var(--fiche)]">Développement territorial</div>
      <h1 className="mb-2 text-3xl font-bold text-[var(--accent-strong)]">Fiche d&apos;action et diagnostic territorial</h1>
      <p className="mb-5 text-[var(--ink-2)]">
        Saisissez un code postal ou le nom d&apos;une commune : l&apos;application collecte les données publiques (INSEE, élections par bureau de vote,
        OpenStreetMap, SNCF, éducation…), les compare au département et produit une fiche d&apos;action sourcée, suivie du diagnostic complet.
      </p>
      <ul className="mb-8 grid gap-2 text-sm sm:grid-cols-2">
        {[
          ["Profil sociodémographique", "écarts significatifs au département, âges, logement, emploi"],
          ["Profil politique", "vote LFI, parrainages, abstention, forces de gauche et RN"],
          ["Où agir", "cartes et classement des bureaux de vote prioritaires"],
          ["Actions recommandées", "porte-à-porte, marchés, gares, commerces, accessibilité"],
        ].map(([t, d]) => (
          <li key={t} className="rounded-lg border border-[var(--line)] bg-white px-3 py-2">
            <span className="font-semibold">{t}</span> <span className="text-[var(--ink-2)]">— {d}</span>
          </li>
        ))}
      </ul>

      <div className="card p-5">
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-[#f1f0ec] p-1 text-sm font-semibold" role="tablist">
          {[
            ["commune", "Fiche d'une commune"],
            ["departement", "Ciblage d'un département"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={scope === id || (id === "commune" && scope !== "departement")}
              onClick={() => setScope(id)}
              className={`rounded-md px-3 py-2 ${scope === id || (id === "commune" && scope !== "departement") ? "bg-white shadow-sm" : "text-[var(--ink-2)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label htmlFor="q" className="mb-1 block text-sm font-semibold">
          {scope === "departement" ? "Une commune du département (code postal ou nom)" : "Code postal ou commune"}
        </label>
        <input
          id="q"
          autoFocus
          inputMode="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && selected && generate()}
          placeholder="ex. 60200 ou Compiègne"
          className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-lg outline-none focus:border-[var(--accent)]"
        />

        {cands.length > 1 && (
          <fieldset className="mt-4">
            <legend className="mb-2 text-sm font-semibold">
              {cands.length} communes correspondent : choisissez la bonne
            </legend>
            <div className="max-h-72 space-y-1 overflow-auto">
              {cands.map((c) => (
                <label key={c.code} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${selected === c.code ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)]"}`}>
                  <input type="radio" name="commune" checked={selected === c.code} onChange={() => setSelected(c.code)} />
                  <span className="font-semibold">{c.nom}</span>
                  <span className="text-[var(--ink-2)]">
                    {c.departementNom} ({c.departement}) · INSEE {c.code} · {c.population != null ? `${c.population.toLocaleString("fr-FR")} hab.` : "population n.d."}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {cands.length === 1 && (
          <p className="mt-3 text-sm">
            <span className="font-semibold">{cands[0].nom}</span> — {cands[0].departementNom} ({cands[0].departement}), code INSEE {cands[0].code},{" "}
            {cands[0].population?.toLocaleString("fr-FR")} habitants
          </p>
        )}
        {q.trim().length >= 5 && cands.length === 0 && !error && <p className="mt-3 text-sm text-[#a12a29]">Aucune commune trouvée.</p>}

        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-semibold text-[var(--ink-2)]">Réglages avancés (facultatif) : périmètre d&apos;analyse</summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {SCOPES.map((s) => (
              <label key={s.id} className={`cursor-pointer rounded-lg border p-3 text-sm ${scope === s.id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)]"}`}>
                <input type="radio" name="scope" className="mr-2" checked={scope === s.id} onChange={() => setScope(s.id)} />
                <span className="font-semibold">{s.label}</span>
                <span className="mt-1 block text-[var(--ink-2)]">{s.help}</span>
              </label>
            ))}
          </div>
          {scope === "custom" && (
            <textarea
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Codes INSEE séparés par des virgules (ex. 60159, 60382, 60338)"
              className="mt-3 w-full rounded-lg border border-[var(--line)] p-2 text-sm"
              rows={3}
            />
          )}
        </details>

        <button className="btn btn-primary mt-5 w-full justify-center py-3 text-base" disabled={!selected || busy} onClick={generate}>
          {busy ? "Lancement…" : scope === "departement" ? "Générer le ciblage départemental" : "Générer la fiche"}
        </button>
        {error && <p className="mt-2 text-sm text-[#a12a29]">{error}</p>}
      </div>

      {recent.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg font-semibold">Fiches déjà générées</h2>
          <ul className="card divide-y divide-[var(--line)]">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <a href={`/rapport/${r.id}`} className="font-semibold">
                  {r.nom} <span className="font-normal text-[var(--ink-2)]">({r.departement}) — {r.scope}</span>
                </a>
                <span className="flex items-center gap-3 text-[var(--muted)]">
                  <a href={`/api/reports/${r.id}/export/pdf?fiche=1`} className="text-xs font-normal">
                    PDF fiche
                  </a>
                  v{r.version} · {new Date(r.updatedAt).toLocaleDateString("fr-FR")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
