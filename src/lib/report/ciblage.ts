import * as turf from "@turf/turf";
import { referentiel } from "../collectors/admin";
import { circoLabel, fitAspect } from "../collectors/carto";
import type { ElectionResult } from "../collectors/elections";
import { NUANCES, nuanceFamily } from "../collectors/municipales";
import { abstention, score } from "../analysis/political";
import { median } from "../analysis/stats";
import { fmtNumber, fmtSigned, fmtValue } from "../format";
import type { Block, DataTable, Finding, Indicator, MapSpec, Section, SourceRef } from "../types";
import type { Collected } from "./collect";

/**
 * Ciblage départemental (périmètre « département ») : sur le modèle de la
 * fiche « PEE · Développement territorial · Yonne », l'application compare
 * toutes les communes du département et propose quelques territoires où
 * concentrer l'effort militant, avec pour chacun un tableau de synthèse.
 *
 * Unités proposées :
 *  - les villes et bourgs de 2 500 habitants et plus ;
 *  - des groupements de bourgs (1 000 à 2 500 habitants) d'une même
 *    intercommunalité, comme « Yonne Nord » (focus sur les principaux bourgs).
 *
 * Score de priorité (moyenne pondérée de scores z calculés entre les unités) :
 *  - surperformance LFI (E24, % des inscrits) par rapport aux communes de
 *    taille comparable du département (35 %) ;
 *  - écart d'abstention aux européennes au département (25 %) ;
 *  - ratio parrains / voix LFI (20 %, si les données internes sont fournies) ;
 *  - volume de voix LFI, en logarithme (20 %) ;
 *  - pénalité pour les territoires déjà couverts par un groupe d'action
 *    important (20 membres ou plus).
 * Ce classement est une aide à la décision : il ne remplace ni la
 * connaissance du terrain ni les choix politiques des militants.
 */

export interface CiblageOutput {
  section: Section | null;
  tables: DataTable[];
  maps: MapSpec[];
  findings: Finding[];
  indicators: Indicator[];
}

const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "n.d." : fmtValue(v, "%", d));
const cnt = (n: number | null | undefined, p: number | null | undefined) => (n == null ? "n.d." : `${fmtNumber(n)} **(${pct(p)})**`);
const B = (s: string) => `**${s}**`;
const joinFr = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`);
export const TARGET_COLORS = ["#2f8f4e", "#3f4bb8", "#e3b23c", "#c0503a", "#a35fbf", "#2a9d9b", "#d66f2f"];

interface Agg {
  inscrits: number;
  votants: number;
  exprimes: number;
  abstentions?: number;
  candidates: { label: string; voix: number }[];
}

const merge = (xs: Agg[]): Agg => {
  const cand = new Map<string, number>();
  const a = { inscrits: 0, votants: 0, exprimes: 0, abstentions: 0, candidates: [] as { label: string; voix: number }[] };
  for (const x of xs) {
    a.inscrits += x.inscrits;
    a.votants += x.votants;
    a.exprimes += x.exprimes;
    a.abstentions += x.abstentions ?? x.inscrits - x.votants;
    for (const c of x.candidates) cand.set(c.label, (cand.get(c.label) ?? 0) + c.voix);
  }
  a.candidates = [...cand].map(([label, voix]) => ({ label, voix }));
  return a;
};

function zs(values: (number | null)[]) {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  const m = v.reduce((s, x) => s + x, 0) / (v.length || 1);
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length || 1)) || 1;
  return values.map((x) => (x == null || !Number.isFinite(x) ? 0 : (x - m) / sd));
}

export interface Unit {
  id: string;
  kind: "commune" | "groupement";
  nom: string;
  codes: string[];
  focus: string[];
  epci: string | null;
  population: number;
  e24: Agg | null;
  p22: Agg | null;
  lfi24: number | null;
  lfi22: number | null;
  voix24: number;
  overperf: number | null;
  abst24: number | null;
  abst22: number | null;
  parrains: number | null;
  ratio: number | null;
  groupes: { nom: string; membres: number | null }[];
  mairie: { nuance: string; tete: string } | null;
  score: number;
}

export function buildCiblage(c: Collected): CiblageOutput {
  const out: CiblageOutput = { section: null, tables: [], maps: [], findings: [], indicators: [] };
  const dep = c.commune.departement;
  const ref = referentiel();
  const el = (id: string) => c.elections.find((e) => e.results[0]?.election.id === id);
  const e24 = el("EU24");
  const p22 = el("PR22T1");
  const d24 = e24?.results.find((r) => r.level === "departement");
  const d22 = p22?.results.find((r) => r.level === "departement");
  if (!d24?.byCommune?.length) return out;
  const by24 = new Map(d24.byCommune.map((x) => [x.code, x as Agg]));
  const by22 = new Map((d22?.byCommune ?? []).map((x) => [x.code, x as Agg]));
  // Abstention : législatives 2024 (forte participation, plus représentative) si disponibles.
  const dLg = el("LG24T1")?.results.find((r) => r.level === "departement");
  const byLg = new Map((dLg?.byCommune ?? []).map((x) => [x.code, x as Agg]));
  const abstLabel = dLg?.byCommune?.length ? "législatives 2024" : "européennes 2024";
  const depCommunes = ref.communes.filter((x) => x.departement === dep.code && x.type === "commune-actuelle" && by24.has(x.code));
  // Périmètre « circonscription » : seules les communes de la circonscription sont classées,
  // les comparaisons (communes de taille comparable, moyennes) restent départementales.
  const circo = c.query.scope === "circonscription" ? (c.circos?.list.find((x) => x.num === c.query.circo) ?? null) : null;
  const shares = circo ? c.circoShares : undefined;
  if (c.query.scope === "circonscription" && !shares?.size) return out;
  // Intercommunalité (EPT dans le Grand Paris) : ses communes, éventuellement sur plusieurs départements.
  const interco = c.query.scope === "epci";
  const intercoSet = interco ? new Set(c.perimeter.communes.map((x) => x.code)) : null;
  const communes = intercoSet
    ? ref.communes.filter((x) => intercoSet.has(x.code) && x.type === "commune-actuelle" && by24.has(x.code))
    : shares
      ? depCommunes.filter((x) => shares.has(x.code))
      : depCommunes;
  if (interco && !communes.length) return out;
  const terr = circo ? circoLabel(circo.num, dep.nom) : interco ? c.perimeter.label : dep.nom;
  const dansTerr = circo ? `dans la ${terr}` : interco ? `dans l'intercommunalité ${terr}` : `dans ${dep.nom}`;
  const Terr = terr.replace(/^./, (x) => x.toUpperCase());
  const zoom = circo || interco;
  const zoneBbox = (): [number, number, number, number] | null => {
    if (circo) return turf.bbox(turf.feature(circo.geometry)) as [number, number, number, number];
    const fs = (c.depFeatures?.features ?? []).filter((f) => intercoSet?.has((f.properties as { code: string }).code));
    return fs.length ? (turf.bbox(turf.featureCollection(fs)) as [number, number, number, number]) : null;
  };
  const partagees = shares ? communes.filter((x) => (shares.get(x.code) ?? 1) < 1) : [];
  const pop = (code: string) => ref.byCode.get(code)?.population ?? 0;
  const lfiPct = (a: Agg | null | undefined, eid: string) => (a ? (score(eid, a, "lfi")?.pctInscrits ?? null) : null);
  const lfiVoix = (a: Agg | null | undefined, eid: string) => (a ? (score(eid, a, "lfi")?.voix ?? 0) : 0);
  const depLfi24 = lfiPct(d24, "EU24");
  const depAbst24 = dLg?.byCommune?.length ? abstention(dLg).pct : abstention(d24).pct;
  const depParrains = [...c.interne.parrains.entries()].filter(([k]) => k.startsWith(dep.code)).reduce((s, [, v]) => s + v, 0);
  const hasParrains = depParrains > 0;
  const depRatio = hasParrains ? depParrains / (lfiVoix(d24, "EU24") || 1) : null;
  const chefLieu = ref.departements.get(dep.code)?.chefLieu;

  // Score LFI attendu selon la taille : médiane des communes de population comparable.
  const lfiAll = depCommunes.map((x) => ({ code: x.code, p: x.population ?? 0, v: lfiPct(by24.get(x.code), "EU24") }));
  const expected = (p: number) => {
    let peers = lfiAll.filter((x) => x.p >= p * 0.5 && x.p <= p * 1.5 && x.v != null);
    if (peers.length < 8) peers = [...lfiAll].filter((x) => x.v != null).sort((a, b) => Math.abs(a.p - p) - Math.abs(b.p - p)).slice(0, 10);
    return median(peers.map((x) => x.v!));
  };

  const groupsOf = (codes: string[]) => c.interne.groupes.filter((g) => codes.includes(g.code)).map((g) => ({ nom: g.nom, membres: g.membres }));
  const mkUnit = (id: string, kind: Unit["kind"], nom: string, codes: string[], focus: string[]): Unit => {
    const a24 = merge(codes.map((k) => by24.get(k)).filter((x): x is Agg => !!x));
    const a22s = codes.map((k) => by22.get(k)).filter((x): x is Agg => !!x);
    const a22 = a22s.length ? merge(a22s) : null;
    const population = codes.reduce((s, k) => s + pop(k), 0);
    const l24 = lfiPct(a24, "EU24");
    const exp = kind === "commune" ? expected(population) : median(codes.map((k) => expected(pop(k))).filter((x): x is number => x != null));
    const par = hasParrains ? codes.reduce((s, k) => s + (c.interne.parrains.get(k) ?? 0), 0) : null;
    const v24 = lfiVoix(a24, "EU24");
    const muni = kind === "commune" ? c.municipalDep?.byCommune.get(codes[0]) : null;
    return {
      id,
      kind,
      nom,
      codes,
      focus,
      epci: ref.epciByCommune.get(codes[0])?.code ?? null,
      population,
      e24: a24,
      p22: a22,
      lfi24: l24,
      lfi22: lfiPct(a22, "PR22T1"),
      voix24: v24,
      overperf: l24 != null && exp != null ? l24 - exp : null,
      abst24: byLg.size && codes.every((k) => byLg.has(k)) ? abstention(merge(codes.map((k) => byLg.get(k)!))).pct : abstention(a24).pct,
      abst22: a22 ? abstention(a22).pct : null,
      parrains: par,
      ratio: par != null && v24 ? par / v24 : null,
      groupes: groupsOf(codes),
      mairie: muni ? { nuance: muni.nuance, tete: muni.tete } : null,
      score: 0,
    };
  };

  const units: Unit[] = [];
  // Intercommunalité : chaque commune de 500 habitants et plus (toutes si moins de trois), sans groupement.
  const minPop = interco ? (communes.filter((x) => (x.population ?? 0) >= 500).length >= 3 ? 500 : 0) : 2500;
  for (const x of communes) if ((x.population ?? 0) >= minPop) units.push(mkUnit(x.code, "commune", x.nom, [x.code], [x.nom]));
  // Groupements de bourgs (1 000 à 2 500 habitants) par intercommunalité.
  const bourgs = new Map<string, typeof communes>();
  for (const x of communes) {
    const p = x.population ?? 0;
    if (p < 1000 || p >= 2500) continue;
    const e = ref.epciByCommune.get(x.code);
    if (!e) continue;
    if (!bourgs.has(e.code)) bourgs.set(e.code, []);
    bourgs.get(e.code)!.push(x);
  }
  for (const [code, list] of bourgs) {
    if (list.length < 2 || interco) continue;
    const top = [...list].sort((a, b) => lfiVoix(by24.get(b.code), "EU24") - lfiVoix(by24.get(a.code), "EU24")).slice(0, 4);
    const e = ref.epcis.find((x) => x.code === code)!;
    units.push(mkUnit(`epci-${code}`, "groupement", e.nom, top.map((x) => x.code), top.map((x) => x.nom)));
  }
  if (!units.length) return out;

  // Score de priorité.
  const zO = zs(units.map((u) => u.overperf));
  const zA = zs(units.map((u) => (u.abst24 != null ? u.abst24 - depAbst24 : null)));
  const zR = zs(units.map((u) => u.ratio));
  const zV = zs(units.map((u) => Math.log(1 + u.voix24)));
  const w = hasParrains ? { o: 0.35, a: 0.25, r: 0.2, v: 0.2 } : { o: 0.45, a: 0.3, r: 0, v: 0.25 };
  units.forEach((u, i) => {
    const covered = u.groupes.some((g) => (g.membres ?? 0) >= 20) || (u.codes.includes(chefLieu ?? "") && u.groupes.length > 0);
    u.score = w.o * zO[i] + w.a * zA[i] + w.r * zR[i] + w.v * zV[i] - (covered ? 1 : 0);
  });
  const ranked = [...units].sort((a, b) => b.score - a.score);

  // Sélection : cinq cibles au plus, deux au plus par intercommunalité. Les deux plus grandes
  // villes (souvent chefs-lieux, déjà couvertes) restent hors ciblage, comme dans les fiches de référence.
  // (En circonscription, aucune ville n'est écartée : le territoire est déjà restreint.)
  const bigCities = zoom ? [] : [...communes].sort((a, b) => (b.population ?? 0) - (a.population ?? 0)).slice(0, 2).map((x) => x.code);
  const chosen: Unit[] = [];
  for (const u of ranked) {
    if (u.kind === "commune" && bigCities.includes(u.codes[0])) continue;
    if (chosen.length >= 5) break;
    if (u.score <= 0 && chosen.length >= 3) break;
    if (!interco && u.epci && chosen.filter((x) => x.epci === u.epci).length >= 2) continue;
    chosen.push(u);
  }

  /* --------------------------------------------------------------- sorties */
  const src: SourceRef[] = [e24!.source, ...(p22 ? [p22.source] : [])];
  const interneSrc: SourceRef = { id: "interne", name: "Données militantes internes", url: "data/interne/", retrievedAt: new Date().toISOString() };
  const geoOf = (u: Unit) => ({ level: (u.kind === "commune" ? "commune" : "epci") as "commune" | "epci", code: u.kind === "commune" ? u.codes[0] : u.id.replace(/^epci-/, ""), name: u.nom });
  const indOf = (u: Unit, id: string, label: string, value: number | null, unit: Indicator["unit"], s: SourceRef) => {
    if (value == null || !Number.isFinite(value)) return null;
    const i: Indicator = { id, label, theme: "strategie", value, unit, geo: geoOf(u), source: s, status: "ok", year: "2024" };
    out.indicators.push(i);
    return `${i.id}@${i.geo.level}:${i.geo.code}`;
  };
  const depRow = {
    territoire: "Moyenne départementale",
    inscrits: null,
    lfi22: d22 ? pct(lfiPct(d22, "PR22T1")) : "",
    lfi24: pct(depLfi24),
    parrains: hasParrains ? pct((100 * depParrains) / d24.inscrits, 2) : "",
    abst22: d22 ? pct(abstention(d22).pct) : "",
    abst24: pct(depAbst24),
  };
  const colsPol = [
    { key: "territoire", label: "", wide: true },
    { key: "inscrits", label: "Inscrits (2024)", align: "right" as const },
    { key: "lfi22", label: "LFI (P22)", align: "right" as const },
    { key: "lfi24", label: "LFI (E24)", align: "right" as const },
    ...(hasParrains ? [{ key: "parrains", label: "Parrains", align: "right" as const }] : []),
    { key: "abst22", label: "Abstention (2022)", align: "right" as const },
    { key: "abst24", label: "Abstention (2024)", align: "right" as const },
  ];
  const lineOf = (name: string, u: Pick<Unit, "e24" | "p22" | "parrains">) => {
    const s24 = u.e24 ? score("EU24", u.e24, "lfi") : null;
    const s22 = u.p22 ? score("PR22T1", u.p22, "lfi") : null;
    const a24 = u.e24 ? abstention(u.e24) : null;
    const a22 = u.p22 ? abstention(u.p22) : null;
    return {
      territoire: name,
      inscrits: u.e24?.inscrits ?? null,
      lfi22: s22 ? cnt(s22.voix, s22.pctInscrits) : "",
      lfi24: s24 ? cnt(s24.voix, s24.pctInscrits) : "",
      parrains: u.parrains != null && u.e24 ? cnt(u.parrains, (100 * u.parrains) / u.e24.inscrits) : "",
      abst22: a22 ? cnt(a22.n, a22.pct) : "",
      abst24: a24 ? cnt(a24.n, a24.pct) : "",
    };
  };

  const targets: Extract<Block, { type: "targets" }>["items"] = [];
  chosen.forEach((u, k) => {
    const tid = `ciblage_${k + 1}`;
    const rows: Record<string, string | number | null>[] = [lineOf(u.kind === "commune" ? u.nom : `Communes ciblées (${u.focus.length})`, u)];
    if (u.kind === "groupement" && u.epci) {
      const all = ref.epcis.find((x) => x.code === u.epci)?.membres.map((m) => m.code).filter((m) => by24.has(m)) ?? [];
      const e = merge(all.map((m) => by24.get(m)!));
      const p = all.map((m) => by22.get(m)).filter((x): x is Agg => !!x);
      rows.push(lineOf(u.nom, { e24: e, p22: p.length ? merge(p) : null, parrains: hasParrains ? all.reduce((s, m) => s + (c.interne.parrains.get(m) ?? 0), 0) : null }));
    }
    rows.push(depRow);
    out.tables.push({ id: tid, title: `${u.nom} — vote LFI, parrainages et abstention`, theme: "strategie", columns: colsPol, rows, highlight: [0], sources: [...src, ...(hasParrains ? [interneSrc] : [])], note: "Le nombre brut correspond au nombre de voix (ou de signataires) ; le pourcentage entre parenthèses est rapporté aux inscrits." });

    const ev: string[] = [];
    const raisons: string[] = [];
    if (u.overperf != null) {
      const e1 = indOf(u, "ciblage_surperf", "Écart du vote LFI (E24) aux communes de taille comparable", u.overperf, "points", e24!.source);
      if (e1) ev.push(e1);
      raisons.push(
        u.overperf >= 1
          ? `${B("LFI surperforme")} par rapport aux communes comparables du département (${fmtSigned(u.overperf, "points")}, ${pct(u.lfi24)} des inscrits aux européennes).`
          : u.overperf <= -1
            ? `LFI sous-performe par rapport aux communes comparables (${fmtSigned(u.overperf, "points")}).`
            : `Vote LFI proche des communes comparables (${pct(u.lfi24)} des inscrits aux européennes).`,
      );
    }
    if (u.abst24 != null) {
      const d = u.abst24 - depAbst24;
      if (d >= 3) raisons.push(`${B("Abstention nettement plus élevée")} que dans le département (${pct(u.abst24)} contre ${pct(depAbst24)} aux ${abstLabel}) : marge de progression chez les abstentionnistes.`);
      else if (d <= -3) raisons.push(`Abstention plus faible que dans le département (${pct(u.abst24)}).`);
    }
    if (u.ratio != null && depRatio) {
      const r = u.ratio / depRatio;
      const e2 = indOf(u, "ciblage_ratio_parrains", "Parrains pour 100 voix LFI (E24)", 100 * u.ratio, "nombre", interneSrc);
      if (e2) ev.push(e2);
      if (r >= 1.3) raisons.push(`Ratio parrains / voix ${fmtNumber(r, 1)} fois supérieur à la moyenne départementale : ${B("forte probabilité de trouver des militants potentiels")}.`);
      else if (r <= 0.7) raisons.push(`${B("Très peu de parrains")} au regard du vote LFI (ratio ${fmtNumber(r, 1)} fois la moyenne) : l'encadrement des nouveaux militants sera la question centrale.`);
    }
    if (u.groupes.length) raisons.push(`Groupe${u.groupes.length > 1 ? "s" : ""} d'action : ${u.groupes.map((g) => `« ${g.nom} »${g.membres != null ? ` (${g.membres} membres)` : ""}`).join(", ")}.`);
    else if (c.interne.files.length) raisons.push(`${B("Aucun groupe d'action référencé")} : territoire à implanter.`);
    if (u.mairie) raisons.push(`Majorité municipale issue des élections de 2026 : ${(NUANCES[u.mairie.nuance] ?? u.mairie.nuance).toLowerCase()}${nuanceFamily(u.mairie.nuance) === "gauche" ? " (gauche)" : ""}.`);
    targets.push({ code: u.codes[0], codes: u.codes, nom: u.nom, kind: u.kind, focus: u.kind === "groupement" ? u.focus : undefined, color: TARGET_COLORS[k], raisons, tableId: tid, evidence: ev });
  });

  // Classement complet (communes et groupements).
  out.tables.push({
    id: "ciblage_classement",
    title: interco ? `Classement des communes (${minPop ? "500 habitants et plus" : "toutes"})` : "Classement des territoires (villes de 2 500 habitants et plus, groupements de bourgs)",
    theme: "strategie",
    columns: [
      { key: "rang", label: "Rang", align: "right" },
      { key: "nom", label: "Territoire", wide: true },
      { key: "pop", label: "Population", align: "right" },
      { key: "lfi", label: "LFI E24 (% ins.)", align: "right" },
      { key: "surperf", label: "Écart aux comparables (pts)", align: "right" },
      { key: "abst", label: abstLabel === "législatives 2024" ? "Abstention L24" : "Abstention E24", align: "right" },
      ...(hasParrains ? [{ key: "ratio", label: "Parrains / 100 voix", align: "right" as const }] : []),
      ...(c.interne.files.length ? [{ key: "groupe", label: "Groupe d'action" }] : []),
      ...(c.municipalDep ? [{ key: "mairie", label: "Mairie (2026)" }] : []),
      { key: "score", label: "Score", align: "right" },
    ],
    rows: ranked.slice(0, 20).map((u, i) => ({
      rang: i + 1,
      nom: u.kind === "groupement" ? `${u.nom} (${u.focus.join(", ")})` : u.nom,
      pop: u.population,
      lfi: pct(u.lfi24),
      surperf: u.overperf != null ? fmtSigned(u.overperf, "points") : "n.d.",
      abst: pct(u.abst24),
      ratio: u.ratio != null ? fmtNumber(100 * u.ratio, 1) : "",
      groupe: u.groupes.length ? u.groupes.map((g) => `${g.nom}${g.membres != null ? ` (${g.membres})` : ""}`).join(", ") : "—",
      mairie: u.mairie ? (NUANCES[u.mairie.nuance] ?? u.mairie.nuance) : "",
      score: fmtNumber(u.score, 2),
    })),
    highlight: ranked.slice(0, 20).map((u, i) => (chosen.includes(u) ? i : -1)).filter((i) => i >= 0),
    sources: [...src, ...(hasParrains || c.interne.files.length ? [interneSrc] : []), ...(c.municipalDep ? [c.municipalDep.source] : [])],
    note: `${bigCities.length ? `Les deux communes les plus peuplées (${bigCities.map((k) => ref.byCode.get(k)?.nom).join(", ")}) restent hors ciblage. ` : ""}${partagees.length ? `Communes partagées avec une autre circonscription (résultats de toute la commune) : ${partagees.map((x) => `${x.nom} (${Math.round(100 * (shares!.get(x.code) ?? 0))} % de sa surface)`).join(", ")}. ` : ""}Score : moyenne pondérée de scores z calculés entre les territoires — surperformance LFI par rapport aux communes de taille comparable (${Math.round(w.o * 100)} %), écart d'abstention au département aux ${abstLabel} (${Math.round(w.a * 100)} %)${hasParrains ? `, ratio parrains / voix (${Math.round(w.r * 100)} %)` : ""}, volume de voix LFI (${Math.round(w.v * 100)} %) ; −1 pour les territoires déjà couverts par un groupe de 20 membres ou plus. Groupements : bourgs de 1 000 à 2 500 habitants d'une même intercommunalité.`,
  });

  // Carte des cibles.
  if (c.depFeatures?.features.length) {
    const colorOf = new Map<string, { color: string; label: string }>();
    chosen.forEach((u, k) => u.codes.forEach((code, j) => colorOf.set(code, { color: TARGET_COLORS[k], label: j === 0 ? (u.kind === "groupement" ? u.nom.replace(/^(CC|CA|CU) (de |du |des |de la |d')?/i, "") : u.nom) : "" })));
    const big = bigCities;
    const inTerr = (code: string) => (intercoSet ? intercoSet.has(code) : !shares || shares.has(code));
    const zb = zoneBbox();
    const features = c.depFeatures.features.filter((f) => !zoom || !zb || inTerr((f.properties as { code: string }).code) || turf.booleanIntersects(f, turf.bboxPolygon(zb))).map((f) => {
      const p = f.properties as { code: string; nom: string };
      const t = colorOf.get(p.code);
      const isBig = big.includes(p.code) && !t;
      return { ...turf.truncate(f, { precision: 4 }), properties: { nom: p.nom, color: t?.color ?? (isBig ? "#7a7a7a" : inTerr(p.code) ? "#cfcfcf" : "#efece4"), label: t?.label || (isBig ? p.nom : "") } } as GeoJSON.Feature;
    });
    const circoLayer = circo
      ? [{ id: "circo", label: "Circonscription", kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: [turf.feature(circo.geometry, { nom: "" })] }, outlineOnly: true, color: "#212320", visible: true, source: c.circos!.source }]
      : [];
    out.maps.push({
      id: "ciblage_carte",
      title: `Territoires proposés pour un ciblage militant — ${terr}`,
      theme: "strategie",
      bbox: zb ?? (turf.bbox(c.depFeatures) as [number, number, number, number]),
      layers: [{ id: "communes", label: "Communes", kind: "polygons", data: { type: "FeatureCollection", features }, labelProperty: "label", visible: true, source: c.geoSource ?? src[0] }, ...circoLayer],
      legend: { title: "Propositions de ciblage", categories: [...chosen.map((u, k) => ({ label: `${k + 1}. ${u.nom}`, color: TARGET_COLORS[k] })), ...(bigCities.length ? [{ label: "Principales villes (hors ciblage)", color: "#7a7a7a" }] : [])] },
      note: circo ? "Trait noir : limite de la circonscription ; communes voisines en gris clair." : interco ? "Communes voisines, hors de l'intercommunalité, en gris clair." : "Les deux communes les plus peuplées sont signalées en gris foncé.",
    });
  }

  // Carte « affiche » : groupes d'action et propositions de ciblage, par circonscription.
  if (c.depFeatures?.features.length) {
    const gs = c.interne.groupes;
    // Groupes certifiés et actifs (5 actions ou plus) si l'export le permet ; sinon tous les groupes.
    const detailed = gs.some((g) => g.certifie != null || g.actions != null);
    const active = gs.filter((g) => !detailed || (g.certifie === true && (g.actions ?? 0) >= 5));
    const gaCodes = new Set(active.map((g) => g.code));
    const targetCodes = new Set(chosen.flatMap((u) => u.codes));
    const feat = (f: GeoJSON.Feature, extra: Record<string, unknown> = {}) => ({ ...turf.truncate(f, { precision: 4 }), properties: { nom: (f.properties as { nom: string }).nom, ...extra } }) as GeoJSON.Feature;
    const all = c.depFeatures.features;
    const ga = all.filter((f) => gaCodes.has((f.properties as { code: string }).code) && !targetCodes.has((f.properties as { code: string }).code));
    const cib = all.filter((f) => targetCodes.has((f.properties as { code: string }).code));
    const zb2 = zoom ? zoneBbox() : null;
    const bb = zb2 ? fitAspect(zb2, 0.06) : (c.depVoisins?.bbox ?? (turf.bbox(c.depFeatures) as [number, number, number, number]));
    const circoList = circo ? [circo] : (c.circos?.list ?? []);
    const ord = (n: number) => (n === 1 ? "1ère" : `${n}ème`);
    const geoSrc = c.geoSource ?? src[0];
    const interneSrcMap: SourceRef = { id: "interne", name: "Données militantes internes (groupes d'action)", url: "data/interne", retrievedAt: new Date().toISOString() };
    out.maps.push({
      id: "ciblage_affiche",
      title: `${zoom ? Terr : dep.nom} : état des groupes d'action et propositions de ciblage`,
      theme: "strategie",
      bbox: bb,
      poster: { kicker: zoom ? Terr : dep.nom, title: "État des groupes d'action et propositions de ciblage", source: "Source : Pôle d'études électorales. Fonds : IGN (ADMIN EXPRESS), data.gouv.fr." },
      layers: [
        ...(c.depVoisins?.features.length
          ? [{ id: "voisins", label: "Départements voisins", kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: c.depVoisins.features }, style: { fill: "#ddd8cd", stroke: "#8f897d", strokeWidth: 1.4 }, labelMode: "caps" as const, labelProperty: "nom", visible: true, source: c.depVoisins.source }]
          : []),
        { id: "communes", label: "Communes", kind: "polygons", data: { type: "FeatureCollection", features: all.map((f) => feat(f)) }, style: { fill: "#fffcf4", stroke: "#cfc8ba", strokeWidth: 0.5 }, legendItem: { label: "Commune", swatch: "line" }, visible: true, source: geoSrc },
        ...(ga.length
          ? [{ id: "ga", label: detailed ? "Groupes d'action certifiés actifs" : "Groupes d'action", kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: ga.map((f) => feat(f)) }, style: { fill: "#4c0297", stroke: "#4c0297", strokeWidth: 0.6 }, labelMode: "callout" as const, labelProperty: "nom", labelColor: "#4c0297", legendItem: { label: detailed ? "Groupe d'action certifié actif (5 actions ou plus)" : "Groupe d'action", swatch: "fill" as const }, visible: true, source: interneSrcMap }]
          : []),
        ...(cib.length
          ? [{ id: "cibles", label: "Ciblages proposés", kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: cib.map((f) => feat(f)) }, style: { fill: "#f3b51b", stroke: "#c98a00", strokeWidth: 0.6 }, labelMode: "callout" as const, labelProperty: "nom", labelColor: "#c98a00", legendItem: { label: "Ciblage proposé", swatch: "fill" as const }, visible: true, source: src[0] }]
          : []),
        ...(circoList.length
          ? [
              {
                id: "circos",
                label: "Circonscriptions législatives",
                kind: "polygons" as const,
                data: { type: "FeatureCollection" as const, features: circoList.map((x) => ({ type: "Feature" as const, geometry: x.geometry, properties: { nom: circoList.length > 1 ? `${ord(x.num)} circo.` : "" } })) },
                style: { fill: "none", stroke: "#212320", strokeWidth: 2 },
                labelMode: "caps" as const,
                labelProperty: "nom",
                labelColor: "#4c0297",
                legendItem: { label: "Circonscription législative", swatch: "line" as const },
                visible: true,
                source: c.circos!.source,
              },
            ]
          : c.depContour
            ? [{ id: "contour", label: "Limite départementale", kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: [c.depContour] }, style: { fill: "none", stroke: "#212320", strokeWidth: 2.2 }, visible: true, source: geoSrc }]
            : []),
      ],
      note: `${detailed ? "Groupes d'action certifiés ayant au moins 5 actions référencées (export Action Populaire)." : "Groupes d'action référencés dans les données internes."} Ciblages : territoires proposés ci-dessous.`,
    });
  }

  // Constat de synthèse.
  out.findings.push({
    id: "C1",
    kind: "piste",
    theme: "strategie",
    weight: 95,
    evidence: [],
    text: `Territoires proposés pour un ciblage militant ${dansTerr} : ${joinFr(chosen.map((u) => u.nom))}.`,
  });

  const blocks: Block[] = [
    {
      type: "callout",
      tone: "warning",
      text: `Le ciblage présenté ci-dessous a été réalisé à partir de la seule exploitation de données statistiques et électorales publiques, par des personnes qui ne vivent pas forcément ${circo ? "dans cette circonscription" : interco ? "dans cette intercommunalité" : "dans ce département"}. ${B(`Les informations qui y sont suggérées doivent être confrontées avec la connaissance du terrain des militant·es ${circo ? "de la circonscription" : interco ? "de l'intercommunalité" : `de ${dep.nom}`}.`)}`,
    },
    { type: "list", title: "Territoires proposés pour un ciblage militant", items: chosen.map((u, k) => ({ text: `${B(`${k + 1}. ${u.nom}`)}${u.kind === "groupement" ? ` (focus possibles : ${joinFr(u.focus)})` : ""}` })) },
    ...(out.maps.some((m) => m.id === "ciblage_affiche") ? [{ type: "map" as const, mapId: "ciblage_affiche" }] : []),
    { type: "map", mapId: "ciblage_carte" },
    { type: "targets", items: targets },
    { type: "heading", text: "Classement de l'ensemble des territoires" },
    { type: "table", tableId: "ciblage_classement" },
    { type: "note", text: "Pour chaque territoire, la fiche détaillée (profil sociodémographique, quartiers, bureaux de vote, lieux d'action) se génère depuis l'application : bouton « Générer la fiche » de chaque proposition, ou recherche de la commune." },
  ];
  out.section = { id: "CIBLAGE", letter: "", title: `Développement territorial — ${zoom ? Terr : dep.nom}`, blocks };
  return out;
}
