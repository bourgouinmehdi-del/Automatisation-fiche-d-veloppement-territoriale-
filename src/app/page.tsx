"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRole } from "@/components/useRole";

interface Candidate {
  via?: "insee" | "postal";
  code: string;
  nom: string;
  codesPostaux: string[];
  departement: string;
  departementNom: string;
  population: number | null;
  interco?: { nom: string; communes: number } | null;
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
  { id: "commune", label: "Commune", field: "Code postal, code INSEE ou nom de la commune", go: "Générer la fiche" },
  { id: "epci", label: "Intercommunalité", field: "Une commune de l'intercommunalité", go: "Générer le ciblage de l'intercommunalité" },
  { id: "circonscription", label: "Circonscription", field: "Une commune de la circonscription", go: "Générer le ciblage de la circonscription" },
  { id: "departement", label: "Département", field: "Une commune du département", go: "Générer le ciblage du département" },
  { id: "custom", label: "Territoire personnalisé", field: "Commune principale du territoire", go: "Générer la fiche" },
] as const;

interface CircoChoice {
  num: number;
  label: string;
  share: number;
}

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cands, setCands] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<(typeof SCOPES)[number]["id"]>("commune");
  const [circos, setCircos] = useState<CircoChoice[] | null>(null);
  const [circo, setCirco] = useState<number | null>(null);
  const [circoErr, setCircoErr] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Listed[]>([]);
  const role = useRole();
  const cfg = SCOPES.find((x) => x.id === scope)!;
  const [refus, setRefus] = useState<string | null>(null);
  useEffect(() => setRefus(new URLSearchParams(window.location.search).get("refus")), []);

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
      const list: Candidate[] = d.communes ?? [];
      setCands(list);
      // Une seule commune pour ce code postal : sélection directe (la commune de même code INSEE reste proposée).
      const postal = list.filter((c) => c.via === "postal");
      setSelected(list.length === 1 ? list[0].code : postal.length === 1 ? postal[0].code : null);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  // Circonscriptions couvrant la commune choisie (périmètre « circonscription »).
  useEffect(() => {
    setCircos(null);
    setCirco(null);
    setCircoErr(null);
    if (scope !== "circonscription" || !selected) return;
    let stop = false;
    fetch(`/api/circonscriptions?commune=${selected}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({ error: `Erreur serveur (HTTP ${r.status})` }));
        if (stop) return;
        if (!r.ok) return setCircoErr(d.error ?? `HTTP ${r.status}`);
        setCircos(d.circos ?? []);
        if (d.circos?.length) setCirco(d.circos[0].num);
      })
      .catch((e) => !stop && setCircoErr(String(e)));
    return () => {
      stop = true;
    };
  }, [scope, selected]);

  async function generate() {
    if (!selected) return;
    if (scope === "circonscription" && !circo) return;
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
        circo: scope === "circonscription" ? circo : undefined,
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
      <h1 className="sr-only">Fiches Territoires</h1>
      {refus && <p className="mb-4 rounded-lg box-err p-3 text-sm">{refus}.</p>}
      {role === "lecteur" ? (
        <p className="card mt-6 p-5 text-[var(--ink-2)]">Votre compte permet de consulter et de télécharger les fiches déjà générées, ci-dessous. Pour en générer de nouvelles, demandez un accès « éditeur » aux administrateurs.</p>
      ) : (
      <div className="card mt-6 p-5">
        <div className="scope-tabs mb-5" role="group" aria-label="Périmètre">
          {SCOPES.map((x) => (
            <button key={x.id} type="button" className="scope-tab" aria-pressed={scope === x.id} onClick={() => setScope(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <label htmlFor="q" className="mb-1 block text-sm font-semibold">
          {cfg.field}
        </label>
        <input
          id="q"
          inputMode="search"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && selected && generate()}
          placeholder="ex. 60200, 60159 ou Compiègne"
          className="field px-3 py-2 text-lg"
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
                    {c.via === "insee" ? "code INSEE " + c.code + ", " : ""}
                    {c.departementNom} ({c.departement}){c.via === "insee" ? "" : `, INSEE ${c.code}`}, {c.population != null ? `${c.population.toLocaleString("fr-FR")} hab.` : "population n.d."}
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
        {q.trim().length >= 5 && cands.length === 0 && !error && <p className="mt-3 text-sm msg-err">Aucune commune trouvée.</p>}

        {scope === "epci" && selected && (() => {
          const i = cands.find((c) => c.code === selected)?.interco;
          return (
            <p className={`mt-4 text-sm ${i ? "" : "msg-err"}`}>
              {i ? (
                <>
                  Intercommunalité : <span className="font-semibold">{i.nom}</span> ({i.communes} communes)
                </>
              ) : (
                "Cette commune n'appartient à aucune intercommunalité."
              )}
            </p>
          );
        })()}

        {scope === "circonscription" && selected && (
          <div className="mt-4 text-sm">
            {circoErr ? (
              <p className="msg-err">{circoErr}</p>
            ) : !circos ? (
              <p className="text-[var(--ink-2)]">Recherche des circonscriptions de la commune… (la première fois pour un département, jusqu&apos;à une minute)</p>
            ) : circos.length === 0 ? (
              <p className="msg-err">Aucune circonscription trouvée pour cette commune.</p>
            ) : circos.length === 1 ? (
              <p>
                <span className="font-semibold">{circos[0].label.replace(/^./, (x) => x.toUpperCase())}</span>
              </p>
            ) : (
              <fieldset>
                <legend className="mb-2 font-semibold">La commune est partagée entre plusieurs circonscriptions : laquelle ?</legend>
                <div className="space-y-1">
                  {circos.map((x) => (
                    <label key={x.num} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${circo === x.num ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)]"}`}>
                      <input type="radio" name="circo" checked={circo === x.num} onChange={() => setCirco(x.num)} />
                      <span className="font-semibold">{x.label.replace(/^./, (y) => y.toUpperCase())}</span>
                      <span className="text-[var(--ink-2)]">{Math.round(x.share * 100)} % de la surface de la commune</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        )}

        {scope === "custom" && (
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Autres communes du territoire : codes INSEE séparés par des virgules (ex. 60382, 60338)"
            className="field mt-3 p-2 text-sm"
            rows={3}
          />
        )}

        <button className="btn btn-primary mt-5 w-full justify-center py-3 text-base" disabled={!selected || busy || (scope === "circonscription" && !circo) || (scope === "epci" && !cands.find((c) => c.code === selected)?.interco)} onClick={generate}>
          {busy ? "Lancement…" : cfg.go}
        </button>
        {error && <p className="mt-2 text-sm msg-err">{error}</p>}
      </div>
      )}

      {recent.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg font-semibold">Fiches déjà générées</h2>
          <ul className="card divide-y divide-[var(--line)]">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <a href={`/rapport/${r.id}`} className="font-semibold">
                  {r.nom} <span className="font-normal text-[var(--ink-2)]">({r.departement}), {(SCOPES.find((x) => x.id === r.scope)?.label ?? r.scope).toLowerCase()}</span>
                </a>
                <span className="flex items-center gap-3 text-[var(--muted)]">
                  <a href={`/api/reports/${r.id}/export/pdf?fiche=1`} className="text-xs font-normal">
                    PDF fiche
                  </a>
                  v{r.version}, {new Date(r.updatedAt).toLocaleDateString("fr-FR")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
