"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { scoreOf } from "@/lib/national/score";
import { useRole } from "@/components/useRole";

type Ligne = {
  code: string;
  nom: string;
  dep: string;
  depNom: string;
  reg: string;
  regNom: string;
  inscrits: number;
  circo: string | null;
  melPct: number;
  eu24Pct: number | null;
  abst22Pct: number;
  reservoir: number;
  reservoirPct: number;
  ga: number | null;
  actions: number | null;
  soutiens: number | null;
  actionsPour1000: number | null;
  soutiensPour1000: number | null;
  ecartCirco: number | null;
  ecartSource: "negos" | "lg24" | null;
  melExpPct: number;
  noteVote: number;
  noteReserve: number;
  raisons: string[];
  f1: number;
  f2: number | null;
  f3: number | null;
};
type Job = { running: boolean; done: number; total: number; current: string | null; errors: string[]; startedAt: string | null; finishedAt: string | null };
type Data = { job: Job; builtAt: string | null; communes?: number; bilan?: boolean; negos?: boolean; mobilisables?: number; lignes: Ligne[] };

const fr = (v: number, d = 0) => v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const signe = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fr(Math.abs(v), 1)}`;

function Note({ v }: { v: number | null }) {
  if (v == null) return <span className="text-[var(--ink-3)]">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-1.5 w-10 rounded bg-[var(--line)]">
        <span className="block h-1.5 rounded bg-[var(--accent)]" style={{ width: `${v}%` }} />
      </span>
      <span className="tabular-nums">{fr(v)}</span>
    </span>
  );
}

export default function ClassementNational() {
  const [data, setData] = useState<Data | null>(null);
  const [min, setMin] = useState(3500);
  const [w, setW] = useState({ p: 45, m: 35, c: 20 });
  const [reg, setReg] = useState("");
  const [dep, setDep] = useState("");
  const [top, setTop] = useState(50);
  // Outre-mer : abstention très forte et vote Mélenchon élevé en 2022, sans groupe d'action recensé ; ils
  // montent mécaniquement en tête. Masqués par défaut.
  const [metro, setMetro] = useState(true);
  const admin = useRole() === "admin";
  const estMetro = (dep: string) => !/^(97|98)/.test(dep);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/interne/classement?min=${min}`)
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.error ?? `HTTP ${r.status}`)))))
      .then((d: Data) => {
        setData(d);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message));
  }, [min]);
  useEffect(load, [load]);
  // Suivi de la construction en cours.
  useEffect(() => {
    if (!data?.job.running) return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [data?.job.running, load]);

  const construire = async () => {
    await fetch("/api/interne/classement", { method: "POST" });
    load();
  };

  const poids = { p: w.p, m: data?.bilan ? w.m : 0, c: w.c };
  const tot = poids.p + poids.m + poids.c || 1;
  const regions = useMemo(() => [...new Map((data?.lignes ?? []).filter((l) => !metro || estMetro(l.dep)).map((l) => [l.reg, l.regNom])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [data]);
  const deps = useMemo(
    () => [...new Map((data?.lignes ?? []).filter((l) => (!metro || estMetro(l.dep)) && (!reg || l.reg === reg)).map((l) => [l.dep, l.depNom])).entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [data, reg, metro],
  );
  const classees = useMemo(
    () =>
      (data?.lignes ?? [])
        .filter((l) => (!metro || estMetro(l.dep)) && (!reg || l.reg === reg) && (!dep || l.dep === dep))
        .map((l) => ({ l, s: scoreOf(l, poids) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, top),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, reg, dep, top, metro, poids.p, poids.m, poids.c],
  );

  const exporter = () => {
    const head = ["rang", "code_insee", "commune", "departement", "inscrits", "score", "note_potentiel", "note_militante", "note_circo", "note_vote_lfi", "note_reserve", "reservoir_voix", "reservoir_pct_inscrits", "melenchon_2022_pct_exprimes", "melenchon_2022_pct_inscrits", "ga_actifs", "actions", "soutiens", "circo", "ecart_circo_points", "ecart_source", "pourquoi"];
    const rows = classees.map(({ l, s }, i) =>
      [i + 1, l.code, l.nom, l.depNom, l.inscrits, s.toFixed(1), l.f1.toFixed(0), l.f2?.toFixed(0) ?? "", l.f3?.toFixed(0) ?? "", l.noteVote.toFixed(0), l.noteReserve.toFixed(0), l.reservoir, l.reservoirPct.toFixed(1), l.melExpPct.toFixed(1), l.melPct.toFixed(1), l.ga ?? "", l.actions ?? "", l.soutiens ?? "", l.circo ?? "", l.ecartCirco?.toFixed(1) ?? "", l.ecartSource ?? "", l.raisons.join(", ")].join(";"),
    );
    const blob = new Blob(["﻿" + [head.join(";"), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Classement national - top ${top}.csv`;
    a.click();
  };

  // Fiche d'action de la commune, en un clic depuis le classement.
  const [fiche, setFiche] = useState<string | null>(null);
  const ouvrirFiche = async (code: string) => {
    setFiche(code);
    const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codeInsee: code, scope: "commune" }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.id) window.location.href = `/generation/${d.id}`;
    else {
      setErr(d.error ?? `HTTP ${r.status}`);
      setFiche(null);
    }
  };

  const job = data?.job;
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="mb-1 text-3xl font-bold text-[var(--accent-strong)]">Classement national des communes</h1>
      <p className="mb-6 text-sm text-[var(--ink-2)]">Les poids se règlent ci-dessous ; le classement se recalcule aussitôt.</p>
      {err && <p className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{err}</p>}

      <section className="mb-6 rounded-lg border border-[var(--line)] p-4 text-sm">
        {job?.running ? (
          <p>
            Construction du jeu de données national : {job.done} départements sur {job.total}
            {job.current ? ` (en cours : ${job.current})` : ""}. La page se met à jour toute seule.
          </p>
        ) : data?.builtAt ? (
          <p>
            Données du {new Date(data.builtAt).toLocaleDateString("fr-FR")} : {fr(data.communes ?? 0)} communes de 1 000 inscrits et plus. Bilan militant : {data.bilan ? "oui" : "absent (facteur 2 désactivé)"}. Fichier des négos : {data.negos ? "oui" : "absent (écart des législatives 2024 à la place)"}. Modèle de Damien : {data.mobilisables ? `${fr(data.mobilisables)} communes (seules celles-ci sont classées)` : "absent (potentiel provisoire)"}.{" "}
            {admin && (
              <button className="underline" onClick={construire}>
                Reconstruire
              </button>
            )}
          </p>
        ) : (
          <p>
            Pas encore de jeu de données national.{" "}
            {admin ? (
              <>
                <button className="rounded bg-[var(--accent)] px-3 py-1 font-semibold text-white" onClick={construire}>
                  Construire
                </button>{" "}
                (résultats de toutes les communes et circonscriptions : une à deux heures la première fois).
              </>
            ) : (
              "Un administrateur doit le construire."
            )}
          </p>
        )}
        {!!job?.errors.length && <p className="mt-2 text-xs text-[var(--ink-3)]">Avertissements : {job.errors.join(" · ")}</p>}
      </section>

      {!!data?.lignes.length && (
        <>
          <section className="mb-6 grid gap-4 md:grid-cols-3">
            {(
              [
                ["p", "Potentiel électoral", `À parts égales : le vote insoumis (2022, 2024) et ${data.mobilisables ? "les électeurs mobilisables du modèle de Damien" : "une réserve de voix provisoire"}.`],
                ["m", "Disponibilité militante", data.bilan ? "Peu d'actions et de soutiens JLM2027 pour 1 000 voix Mélenchon, pas de groupe d'action actif." : "Bilan militant absent : facteur désactivé."],
                ["c", "Circonscription serrée", data.negos ? "Écart projeté (fichier des négos) : plus il est faible, plus la note est haute." : "Provisoire : écart du 1er tour des législatives 2024 entre l'union de la gauche et le premier adversaire."],
              ] as const
            ).map(([k, t, d]) => (
              <label key={k} className="block rounded-lg border border-[var(--line)] p-3">
                <span className="flex justify-between font-semibold">
                  <span>{t}</span>
                  <span className="tabular-nums">{fr((100 * poids[k]) / tot)} %</span>
                </span>
                <input type="range" min={0} max={100} value={w[k]} disabled={k === "m" && !data.bilan} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} className="my-2 w-full" />
                <span className="text-xs text-[var(--ink-2)]">{d}</span>
              </label>
            ))}
          </section>

          <section className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={metro}
                onChange={(e) => {
                  setMetro(e.target.checked);
                  setReg("");
                  setDep("");
                }}
              />
              France métropolitaine seulement
            </label>
            <select value={min} onChange={(e) => setMin(Number(e.target.value))} className="rounded border border-[var(--line)] px-2 py-1">
              {[2000, 3500, 5000, 10000, 20000].map((v) => (
                <option key={v} value={v}>
                  {fr(v)} inscrits et plus
                </option>
              ))}
            </select>
            <select
              value={reg}
              onChange={(e) => {
                setReg(e.target.value);
                setDep("");
              }}
              className="rounded border border-[var(--line)] px-2 py-1"
            >
              <option value="">Toutes les régions</option>
              {regions.map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
            </select>
            <select value={dep} onChange={(e) => setDep(e.target.value)} className="rounded border border-[var(--line)] px-2 py-1">
              <option value="">Tous les départements</option>
              {deps.map(([k, n]) => (
                <option key={k} value={k}>
                  {k} {n}
                </option>
              ))}
            </select>
            <select value={top} onChange={(e) => setTop(Number(e.target.value))} className="rounded border border-[var(--line)] px-2 py-1">
              {[30, 50, 100, 200].map((v) => (
                <option key={v} value={v}>
                  {v} premières
                </option>
              ))}
            </select>
            <button onClick={exporter} className="rounded border border-[var(--line)] px-3 py-1">
              Exporter (CSV)
            </button>
          </section>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--ink-2)]">
                <tr className="border-b border-[var(--line)]">
                  <th className="py-2 pr-2">#</th>
                  <th className="pr-2">Commune</th>
                  <th className="pr-2 text-right">Score</th>
                  <th className="pr-2">Potentiel</th>
                  <th className="pr-2">Militant</th>
                  <th className="pr-2">Circo</th>
                  <th className="pr-2 text-right">{data.mobilisables ? "Mobilisables" : "Réservoir de voix"}</th>
                  <th className="pr-2 text-right">Mélenchon 2022</th>
                  <th className="pr-2 text-right">GA · actions · soutiens</th>
                  <th className="pr-2 text-right">Écart circo</th>
                  <th>Pourquoi</th>
                </tr>
              </thead>
              <tbody>
                {classees.map(({ l, s }, i) => (
                  <tr key={l.code} className="border-b border-[var(--line)] align-top">
                    <td className="py-1.5 pr-2 tabular-nums">{i + 1}</td>
                    <td className="pr-2">
                      <span className="font-semibold">{l.nom}</span> <span className="text-xs text-[var(--ink-2)]">({l.depNom}, {fr(l.inscrits)} inscrits)</span>{" "}
                      <button className="text-xs text-[var(--accent)] underline" disabled={!!fiche} onClick={() => ouvrirFiche(l.code)}>
                        {fiche === l.code ? "fiche en cours…" : "fiche"}
                      </button>
                    </td>
                    <td className="pr-2 text-right font-semibold tabular-nums">{fr(s, 1)}</td>
                    <td className="pr-2" title={`Vote insoumis : ${fr(l.noteVote)} · réserve de voix : ${fr(l.noteReserve)}`}>
                      <Note v={l.f1} />
                    </td>
                    <td className="pr-2">
                      <Note v={data.bilan ? l.f2 : null} />
                    </td>
                    <td className="pr-2">
                      <Note v={l.f3} />
                    </td>
                    <td className="pr-2 text-right tabular-nums">
                      {fr(l.reservoir)} <span className="text-xs text-[var(--ink-2)]">({fr(l.reservoirPct, 1)} %)</span>
                    </td>
                    <td className="pr-2 text-right tabular-nums" title={`${fr(l.melPct, 1)} % des inscrits`}>
                      {fr(l.melExpPct, 1)} %
                    </td>
                    <td className="pr-2 text-right tabular-nums">{l.ga == null ? "—" : `${l.ga} · ${l.actions} · ${l.soutiens}`}</td>
                    <td className="pr-2 text-right tabular-nums" title={l.ecartSource === "negos" ? "Fichier des négos" : "Législatives 2024, 1er tour"}>
                      {l.ecartCirco == null ? "—" : `${signe(l.ecartCirco)} pt${l.circo ? ` (${l.circo})` : ""}`}
                    </td>
                    <td className="text-xs text-[var(--ink-2)]">{l.raisons.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="mt-8 space-y-2 text-sm text-[var(--ink-2)]">
            <h2 className="text-base font-semibold text-[var(--ink)]">Méthode</h2>
            <p>
              Chaque facteur est une note de 0 à 100 : le rang de la commune parmi les communes classées (50 = au milieu). Le score est la moyenne des notes pondérée par les curseurs ; un facteur sans données ne compte pas.
            </p>
            <p>
              <b>Potentiel électoral</b>, à parts égales. D&apos;une part le vote insoumis : Mélenchon 2022 (60 %) et européennes 2024 (40 %), en part des exprimés, comme sur les fiches. D&apos;autre part la réserve de voix : si l&apos;export de Damien est déposé, ses électeurs mobilisables (électeurs qui votent d&apos;habitude et penchent à gauche, mais risquent de s&apos;abstenir en 2027) ; sinon, à titre provisoire, abstentionnistes de la présidentielle 2022 × part de Mélenchon chez les votants de la commune, plus la moitié des voix Roussel, Hidalgo et Jadot. La réserve compte pour 60 % en volume (échelle logarithmique : il faut assez de portes pour une journée de convoi, sans laisser gagner toujours les plus grandes villes) et 40 % en part des inscrits. Une commune où LFI est faible ne passe donc plus en tête sur sa seule réserve.
            </p>
            <p>
              <b>Disponibilité militante</b> : actions recensées (50 %) et soutiens JLM2027 (30 %) pour 1 000 voix Mélenchon 2022, moins il y en a plus la note est haute ; pas de groupe d&apos;action actif (20 %).
            </p>
            <p>
              <b>Circonscription serrée</b> : écart projeté par circonscription (fichier des négos, à déposer dans Données internes) ; à défaut, écart du 1er tour des législatives 2024 entre l&apos;union de la gauche et le premier adversaire. Une commune partagée entre plusieurs circonscriptions prend celle qui couvre la plus grande partie de son territoire. Deux communes proches se départagent ainsi selon leur circonscription.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
