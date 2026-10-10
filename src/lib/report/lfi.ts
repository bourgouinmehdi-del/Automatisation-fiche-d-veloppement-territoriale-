import * as turf from "@turf/turf";
import { referentiel } from "../collectors/admin";
import type { BureauResult, ElectionResult } from "../collectors/elections";
import { abstention, BV_TYPE_LABELS, BvRow, familyPerformance, frenchHours, lfiOverperformance, prettyBvLabel, rankBureaux, score } from "../analysis/political";
import { gap, haversineKm, quantileBreaks } from "../analysis/stats";
import { evidenceId } from "../analysis/findings";
import { fmtNumber, fmtSigned, fmtValue } from "../format";
import type { Block, ChartSpec, DataTable, Finding, GeoRef, Indicator, MapSpec, Section, SourceRef } from "../types";
import { MISSING_COLOR, SEQ_COLORS } from "./assemble";
import type { Collected } from "./collect";

/**
 * Fiche d'action « approche LFI », sur le modèle du document de référence :
 *  - profil sociodémographique (puces + tableau comparatif) ;
 *  - profil politique (tableau Inscrits / LFI P22 / LFI E24 / parrains / abstention) ;
 *  - analyse par bureau de vote (classement, carte) ;
 *  - atouts, où, pourquoi (hypothèses), comment ;
 *  - actions recommandées : porte-à-porte, marchés, gares, supermarchés,
 *    sorties d'établissements, accessibilité.
 * Tous les chiffres proviennent des données collectées ; les explications
 * sont présentées comme des hypothèses à confronter au terrain.
 */

export interface LfiOutput {
  section: Section | null;
  tables: DataTable[];
  charts: ChartSpec[];
  maps: MapSpec[];
  findings: Finding[];
  indicators: Indicator[];
}

const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "n.d." : fmtValue(v, "%", d));
const cnt = (n: number | null | undefined, p: number | null | undefined) => (n == null ? "n.d." : `${fmtNumber(n)} (${pct(p)})`);

export function buildLfi(c: Collected, indicators: Indicator[]): LfiOutput {
  const out: LfiOutput = { section: null, tables: [], charts: [], maps: [], findings: [], indicators: [] };
  const { commune, geos } = c;
  const blocks: Block[] = [];
  let fid = 1000;
  const addF = (f: Omit<Finding, "id" | "theme">) => out.findings.push({ ...f, id: `L${++fid}`, theme: "strategie" });
  const get = (id: string, g: GeoRef | null | undefined) => (g ? indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code && i.value != null) : undefined);

  /* ------------------------------------------------------------ socio */
  const socioGeos = [geos.commune, geos.epci, geos.departement, geos.region, geos.france].filter(Boolean) as GeoRef[];
  const rowFor = (g: GeoRef) => {
    const v = (id: string) => get(id, g)?.value ?? null;
    return {
      territoire: g.name,
      revenu: v("revenu_median") != null ? fmtValue(v("revenu_median"), "€") : "n.d.",
      pauvrete: pct(v("taux_pauvrete")),
      jeunes: pct(v("part_moins_25") ?? v("part_moins_30")),
      ages: pct(v("part_65_plus") ?? v("part_60_plus")),
      chomage: pct(v("taux_chomage_rp")),
      locataires: v("part_locataires") != null ? `${pct(v("part_locataires"), 0)} (${pct(v("part_locataires_hlm"), 0)})` : "n.d.",
      diplome: pct(v("part_sans_diplome")),
      ouvriers: pct(v("part_ouvriers")),
    };
  };
  const socioRows = socioGeos.map(rowFor).filter((r) => Object.values(r).some((x, i) => i > 0 && x !== "n.d."));
  const socioSources = [...new Map(indicators.filter((i) => ["revenu_median", "taux_pauvrete", "part_moins_25", "part_65_plus", "taux_chomage_rp", "part_locataires", "part_ouvriers"].includes(i.id)).map((i) => [i.source.dataset ?? i.source.id, i.source])).values()];
  if (socioRows.length) {
    out.tables.push({
      id: "lfi_socio",
      title: "Profil sociodémographique comparé",
      theme: "strategie",
      columns: [
        { key: "territoire", label: "" },
        { key: "revenu", label: "Revenu médian", align: "right" },
        { key: "pauvrete", label: "Taux de pauvreté", align: "right" },
        { key: "jeunes", label: "Moins de 25 ans", align: "right" },
        { key: "ages", label: "65 ans et +", align: "right" },
        { key: "chomage", label: "Taux de chômage", align: "right" },
        { key: "locataires", label: "Locataires (dont HLM)", align: "right" },
        { key: "diplome", label: "Sans diplôme ou brevet seul", align: "right" },
        { key: "ouvriers", label: "Ouvriers", align: "right" },
      ],
      rows: socioRows,
      sources: socioSources,
      note: "Revenu disponible médian par unité de consommation (Filosofi) ; autres indicateurs : recensement de la population.",
    });
  }

  // Puces de profil (formulées à partir des écarts au département).
  const bullets: string[] = [];
  const pop = get("pop_municipale", geos.commune);
  const dens = get("densite", geos.commune);
  if (pop) bullets.push(`Environ ${fmtNumber(Math.round(pop.value! / 100) * 100)} habitants${dens ? `, densité de ${fmtValue(dens.value, "hab/km²")}` : ""}.`);
  // Accord : « Part … supérieure », « Revenu … supérieur ».
  const cmp = (id: string, label: string, unit: "€" | "%") => {
    const fem = /^(part|population)/i.test(label);
    const a = get(id, geos.commune);
    const b = get(id, geos.departement);
    if (!a || !b) return;
    const g = gap(a.value!, b.value!, unit);
    if (g.direction === "proche") bullets.push(`${label} proche de la moyenne départementale (${fmtValue(a.value, unit)} contre ${fmtValue(b.value, unit)}).`);
    else bullets.push(`${label} ${g.direction === "superieur" ? "supérieur" : "inférieur"}${fem ? "e" : ""} à la moyenne départementale : ${fmtValue(a.value, unit)} contre ${fmtValue(b.value, unit)}.`);
  };
  cmp("revenu_median", "Revenu médian", "€");
  cmp("taux_pauvrete", "Taux de pauvreté", "%");
  cmp("part_locataires_hlm", "Part de ménages locataires HLM", "%");
  cmp(get("part_moins_25", geos.commune) ? "part_moins_25" : "part_moins_30", "Part des jeunes", "%");
  cmp(get("part_65_plus", geos.commune) ? "part_65_plus" : "part_60_plus", "Part des personnes âgées", "%");
  cmp("part_ouvriers", "Part des ouvriers", "%");
  cmp("part_cadres", "Part des cadres", "%");
  cmp("taux_chomage_rp", "Taux de chômage", "%");
  const conc = get("concentration_emploi", geos.commune);
  if (conc) bullets.push(conc.value! >= 100 ? `Pôle d'emploi (${fmtNumber(conc.value!, 0)} emplois pour 100 actifs occupés résidents).` : `Commune plutôt résidentielle (${fmtNumber(conc.value!, 0)} emplois pour 100 actifs occupés résidents) : dépendance aux bassins d'emploi voisins.`);
  const nearestBig = (commune.population ?? 0) < 20000 ? c.poles.find((p) => p.population >= 20000) : null;
  if (nearestBig) bullets.push(`Pôle urbain le plus proche : ${nearestBig.nom} (${fmtValue(nearestBig.distanceKm, "km")} à vol d'oiseau).`);
  if (c.parisKm != null) bullets.push(`Paris à ${fmtValue(c.parisKm, "km")} à vol d'oiseau.`);

  /* ------------------------------------------------------------ politique */
  const el = (id: string) => c.elections.find((e) => e.results[0]?.election.id === id);
  const e24 = el("EU24");
  const p22 = el("PR22T1");
  const com = (e?: { results: ElectionResult[] }) => e?.results.find((r) => r.level === "commune");
  const depR = (e?: { results: ElectionResult[] }) => e?.results.find((r) => r.level === "departement");
  const pops = new Map(referentiel().communes.filter((x) => x.departement === commune.departement.code && x.type === "commune-actuelle").map((x) => [x.code, x.population ?? null]));
  const parrains = c.interne.parrains.get(commune.code) ?? null;
  const depParrains = [...c.interne.parrains.entries()].filter(([k]) => k.startsWith(commune.departement.code)).reduce((s, [, v]) => s + v, 0);
  const elecSources: SourceRef[] = c.elections.map((e) => e.source);

  const bvRef = c.bureaux.find((b) => b.election.id === "EU24") ?? c.bureaux.find((b) => b.election.id === "PR22T1");
  const bvSecond = c.bureaux.find((b) => b.election.id === "PR22T1" && b !== bvRef);
  const labels = new Map([...(c.bvGeo?.labels ?? new Map<string, string>())].map(([k, v]) => [k, prettyBvLabel(v)] as [string, string]));
  const ranked: BvRow[] = bvRef ? rankBureaux(bvRef.results, bvSecond?.results ?? null, labels) : [];
  const prio = ranked.filter((b) => b.priorite === 1);

  if (com(e24) || com(p22)) {
    type Row = Record<string, string | number | null>;
    const line = (name: string, ins: number | null, l22: ReturnType<typeof score>, l24: ReturnType<typeof score>, par: number | null, a22: ReturnType<typeof abstention> | null, a24: ReturnType<typeof abstention> | null): Row => ({
      territoire: name,
      inscrits: ins,
      lfi22: l22 ? cnt(l22.voix, l22.pctInscrits) : "",
      lfi24: l24 ? cnt(l24.voix, l24.pctInscrits) : "",
      parrains: par != null && ins ? cnt(par, (100 * par) / ins) : "",
      abst22: a22 ? cnt(a22.n, a22.pct) : "",
      abst24: a24 ? cnt(a24.n, a24.pct) : "",
    });
    const c24 = com(e24);
    const c22 = com(p22);
    const rows: Row[] = [
      line(commune.nom, c24?.inscrits ?? c22?.inscrits ?? null, c22 ? score("PR22T1", c22, "lfi") : null, c24 ? score("EU24", c24, "lfi") : null, parrains, c22 ? abstention(c22) : null, c24 ? abstention(c24) : null),
    ];
    // Bureaux prioritaires regroupés (comme « BV 3 et 7 » dans le document de référence).
    if (prio.length && bvRef) {
      const aggOf = (res: BureauResult[] | undefined) => {
        if (!res) return null;
        const sel = res.filter((b) => prio.some((p) => p.bv === b.bv));
        if (!sel.length) return null;
        const agg = { inscrits: 0, votants: 0, exprimes: 0, abstentions: 0, candidates: [] as { label: string; voix: number }[] };
        const cand = new Map<string, number>();
        for (const b of sel) {
          agg.inscrits += b.inscrits;
          agg.votants += b.votants;
          agg.exprimes += b.exprimes;
          agg.abstentions += b.abstentions;
          for (const x of b.candidates) cand.set(x.label, (cand.get(x.label) ?? 0) + x.voix);
        }
        agg.candidates = [...cand].map(([label, voix]) => ({ label, voix }));
        return agg;
      };
      const a24 = aggOf(c.bureaux.find((b) => b.election.id === "EU24")?.results);
      const a22 = aggOf(c.bureaux.find((b) => b.election.id === "PR22T1")?.results);
      rows.push(
        line(
          `BV ${prio.map((p) => p.bv).join(", ")} (prioritaires)`,
          a24?.inscrits ?? a22?.inscrits ?? null,
          a22 ? score("PR22T1", a22, "lfi") : null,
          a24 ? score("EU24", a24, "lfi") : null,
          null,
          a22 ? abstention(a22) : null,
          a24 ? abstention(a24) : null,
        ),
      );
    }
    const d24 = depR(e24);
    const d22 = depR(p22);
    const ds24 = d24 ? score("EU24", d24, "lfi") : null;
    const ds22 = d22 ? score("PR22T1", d22, "lfi") : null;
    rows.push({
      territoire: "Moyenne départementale",
      inscrits: null,
      lfi22: ds22 ? pct(ds22.pctInscrits) : "",
      lfi24: ds24 ? pct(ds24.pctInscrits) : "",
      parrains: depParrains && d24 ? pct((100 * depParrains) / d24.inscrits, 2) : "",
      abst22: d22 ? pct(abstention(d22).pct) : "",
      abst24: d24 ? pct(abstention(d24).pct) : "",
    });
    out.tables.push({
      id: "lfi_politique",
      title: "Profil politique : LFI et abstention",
      theme: "strategie",
      columns: [
        { key: "territoire", label: "" },
        { key: "inscrits", label: "Inscrits (2024)", align: "right" },
        { key: "lfi22", label: "LFI (P22)", align: "right" },
        { key: "lfi24", label: "LFI (E24)", align: "right" },
        ...(parrains != null || depParrains ? [{ key: "parrains", label: "Parrains", align: "right" as const }] : []),
        { key: "abst22", label: "Abstention (2022)", align: "right" },
        { key: "abst24", label: "Abstention (2024)", align: "right" },
      ],
      rows,
      sources: elecSources,
      note: "Le nombre brut correspond au nombre de voix (ou de signataires) ; le pourcentage entre parenthèses est rapporté aux inscrits. P22 : présidentielle 2022, 1er tour (J.-L. Mélenchon) ; E24 : européennes 2024 (liste LFI).",
    });

    // Indicateurs LFI (pour le tableau de bord et les preuves).
    const lfiInd = (id: string, label: string, value: number, g: GeoRef, src: SourceRef, year: string, method: string): Indicator => ({
      id,
      label,
      theme: "strategie",
      value,
      unit: "%",
      year,
      geo: g,
      source: src,
      status: "ok",
      method,
    });
    for (const [e, eid, y] of [[e24, "EU24", "2024"], [p22, "PR22T1", "2022"]] as const) {
      if (!e) continue;
      for (const r of e.results) {
        const s = score(eid, r, "lfi");
        const g = r.level === "commune" ? geos.commune : geos.departement;
        if (s) out.indicators.push(lfiInd(`lfi_${eid}_ins`, `Vote LFI (${eid === "EU24" ? "européennes 2024" : "présidentielle 2022"}) en % des inscrits`, s.pctInscrits, g, e.source, y, "Voix LFI / inscrits × 100."));
        if (s) out.indicators.push(lfiInd(`lfi_${eid}_exp`, `Vote LFI (${eid === "EU24" ? "européennes 2024" : "présidentielle 2022"}) en % des exprimés`, s.pctExprimes, g, e.source, y, "Voix LFI / suffrages exprimés × 100."));
        out.indicators.push(lfiInd(`abst_${eid}`, `Abstention (${eid === "EU24" ? "européennes 2024" : "présidentielle 2022"}) en % des inscrits`, abstention(r).pct, g, e.source, y, "Abstentions / inscrits × 100."));
      }
    }
    const ind = (id: string, lvl: "commune" | "departement") => out.indicators.find((i) => i.id === id && i.geo.level === lvl);

    // Surperformance vs communes comparables du département.
    for (const [e, eid, name] of [[e24, "EU24", "européennes 2024"], [p22, "PR22T1", "présidentielle 2022"]] as const) {
      const d = depR(e);
      if (!d) continue;
      const o = lfiOverperformance(eid, d, commune.code, pops);
      if (!o) continue;
      const g = gap(o.commune, o.median, "%");
      const ev = [ind(`lfi_${eid}_ins`, "commune")].filter(Boolean).map((i) => evidenceId(i!));
      addF({
        kind: g.direction === "superieur" ? "atout" : "constat",
        text: `${name.charAt(0).toUpperCase() + name.slice(1)} : LFI réunit ${pct(o.commune)} des inscrits, contre une médiane de ${pct(o.median)} dans les ${o.n} communes du département de taille la plus proche (${fmtNumber(o.minPop)} à ${fmtNumber(o.maxPop)} habitants) — ${g.direction === "superieur" ? "surperformance" : g.direction === "inferieur" ? "sous-performance" : "niveau comparable"} (${fmtSigned(g.abs, "points")}).`,
        evidence: ev,
        weight: 90,
      });
    }

    // Parrainages.
    if (parrains != null && c24) {
      const s = score("EU24", c24, "lfi");
      const ds = d24 ? score("EU24", d24, "lfi") : null;
      if (s?.voix && ds?.voix && depParrains) {
        const r1 = parrains / s.voix;
        const r2 = depParrains / ds.voix;
        const src: SourceRef = { id: "interne", name: "Données militantes internes (parrains.csv)", url: "data/interne/parrains.csv", retrievedAt: new Date().toISOString() };
        out.indicators.push({ id: "parrains_pour_100_voix", label: "Parrains pour 100 voix LFI (E24)", theme: "strategie", value: r1 * 100, unit: "nombre", year: "2024", geo: geos.commune, source: src, status: "ok", method: "Parrains / voix LFI aux européennes 2024 × 100." });
        out.indicators.push({ id: "parrains_pour_100_voix", label: "Parrains pour 100 voix LFI (E24)", theme: "strategie", value: r2 * 100, unit: "nombre", year: "2024", geo: geos.departement, source: src, status: "ok", method: "Parrains / voix LFI aux européennes 2024 × 100." });
        addF({
          kind: r1 > r2 * 1.2 ? "atout" : "constat",
          evidence: [`parrains_pour_100_voix@commune:${commune.code}`, `parrains_pour_100_voix@departement:${geos.departement.code}`],
          text: `Ratio parrains / voix LFI (E24) : ${fmtNumber(r1 * 100, 1)} pour 100 électeurs LFI, contre ${fmtNumber(r2 * 100, 1)} dans le département${r1 > r2 * 1.2 ? " : la probabilité de trouver des militants potentiels parmi les électeurs insoumis y est plus forte" : r1 < r2 * 0.8 ? " : vivier militant comparativement faible, encadrement des nouveaux sympathisants à prévoir" : ""}.`,
          weight: 85,
        });
      }
    }

    // Abstention et scrutins intermédiaires (hypothèse du document de référence).
    if (c22 && c24 && d22 && d24) {
      const dc = abstention(c24).pct - abstention(c22).pct;
      const dd = abstention(d24).pct - abstention(d22).pct;
      const lvl = gap(abstention(c24).pct, abstention(d24).pct, "%");
      addF({
        kind: lvl.direction === "superieur" ? "atout" : "constat",
        text: `Abstention de ${pct(abstention(c24).pct)} aux européennes 2024 (département : ${pct(abstention(d24).pct)}) ; elle progresse de ${fmtNumber(dc, 1)} points entre la présidentielle et les européennes, contre ${fmtNumber(dd, 1)} points dans le département.${lvl.direction === "superieur" ? " Marge de progression chez les abstentionnistes." : ""}`,
        evidence: [ind("abst_EU24", "commune"), ind("abst_EU24", "departement"), ind("abst_PR22T1", "commune")].filter(Boolean).map((i) => evidenceId(i!)),
        weight: 80,
      });
      if (dc > dd + 2)
        addF({
          kind: "hypothese",
          text: "La sur-abstention est plus marquée lors du scrutin intermédiaire : ce profil est souvent associé à une abstention intermittente plus forte chez les jeunes et les ménages modestes. Hypothèse à vérifier sur le terrain (listes d'émargement non exploitées).",
          evidence: [ind("abst_EU24", "commune"), ind("abst_PR22T1", "commune"), ind("abst_EU24", "departement"), ind("abst_PR22T1", "departement")].filter(Boolean).map((i) => evidenceId(i!)),
          weight: 60,
        });
    }

    // Autres forces de gauche (sur/sous-performance relative au département).
    if (c24 && d24) {
      const perfAll = familyPerformance("EU24", c24, d24);
      for (const p of perfAll)
        for (const [g, v] of [[geos.commune, p.commune], [geos.departement, p.departement]] as const)
          out.indicators.push({ id: `vote_${p.family}_EU24_exp`, label: `Vote ${p.label} (européennes 2024) en % des exprimés`, theme: "strategie", value: v, unit: "%", year: "2024", geo: g, source: e24!.source, status: "ok" });
      const perf = perfAll.filter((p) => ["pcf", "ps", "eco", "rn", "lfi"].includes(p.family));
      const lfiPerf = perfAll.find((p) => p.family === "lfi");
      if (lfiPerf && lfiPerf.ratio >= 1.2)
        addF({
          kind: "atout",
          text: `Aux européennes 2024, LFI obtient ${pct(lfiPerf.commune)} des exprimés contre ${pct(lfiPerf.departement)} dans le département (indice ${Math.round(lfiPerf.ratio * 100)}) : la commune est un point d'appui relatif dans un département où le RN domine.`,
          evidence: [`vote_lfi_EU24_exp@commune:${commune.code}`, `vote_lfi_EU24_exp@departement:${geos.departement.code}`],
          weight: 92,
        });
      const sur = perf.filter((p) => p.ratio >= 1.1).map((p) => p.label);
      const sous = perf.filter((p) => p.ratio <= 0.9).map((p) => p.label);
      if (sur.length || sous.length)
        addF({
          kind: "constat",
          evidence: perf.filter((p) => p.ratio >= 1.1 || p.ratio <= 0.9).flatMap((p) => [`vote_${p.family}_EU24_exp@commune:${commune.code}`, `vote_${p.family}_EU24_exp@departement:${geos.departement.code}`]),
          text: `Européennes 2024, rapporté au département (% des exprimés) : ${sur.length ? `${sur.join(", ")} surperforme${sur.length > 1 ? "nt" : ""}` : ""}${sur.length && sous.length ? " ; " : ""}${sous.length ? `${sous.join(", ")} sous-performe${sous.length > 1 ? "nt" : ""}` : ""}.`,
          weight: 55,
        });
      out.tables.push({
        id: "lfi_partis",
        title: "Européennes 2024 — forces politiques comparées au département (% des exprimés)",
        theme: "strategie",
        columns: [
          { key: "famille", label: "Liste / famille" },
          { key: "commune", label: commune.nom, align: "right", unit: "%" },
          { key: "departement", label: geos.departement.name, align: "right", unit: "%" },
          { key: "indice", label: "Indice (dép. = 100)", align: "right" },
        ],
        rows: familyPerformance("EU24", c24, d24).map((p) => ({ famille: p.label, commune: Math.round(p.commune * 10) / 10, departement: Math.round(p.departement * 10) / 10, indice: Math.round(p.ratio * 100) })),
        sources: [e24!.source],
      });
    }
  }

  /* ------------------------------------------------------------ bureaux de vote */
  if (ranked.length && bvRef) {
    const second = bvSecond?.election.id === "PR22T1" ? "P22" : "";
    out.tables.push({
      id: "lfi_bureaux",
      title: `Bureaux de vote : vote LFI, abstention et priorité (${bvRef.election.label})`,
      theme: "strategie",
      columns: [
        { key: "priorite", label: "Priorité", align: "right" },
        { key: "bv", label: "BV" },
        { key: "libelle", label: "Lieu / libellé" },
        { key: "inscrits", label: "Inscrits", align: "right" },
        { key: "lfi", label: "LFI (% inscrits)", align: "right", unit: "%" },
        { key: "lfiexp", label: "LFI (% exprimés)", align: "right", unit: "%" },
        ...(second ? [{ key: "lfi2", label: `LFI ${second} (% inscrits)`, align: "right" as const, unit: "%" as const }] : []),
        { key: "abst", label: "Abstention (%)", align: "right", unit: "%" },
        { key: "abstn", label: "Abstentionnistes", align: "right" },
        { key: "type", label: "Profil" },
      ],
      rows: ranked.map((b) => ({
        priorite: b.priorite,
        bv: b.bv,
        libelle: b.label,
        inscrits: b.inscrits,
        lfi: Math.round(b.lfiPctIns * 10) / 10,
        lfiexp: Math.round(b.lfiPctExp * 10) / 10,
        lfi2: b.lfi2PctIns != null ? Math.round(b.lfi2PctIns * 10) / 10 : null,
        abst: Math.round(b.abstPct * 10) / 10,
        abstn: b.abstN,
        type: BV_TYPE_LABELS[b.type],
      })),
      sources: [bvRef.source, ...(c.bvGeo ? [c.bvGeo.source] : [])],
      note: "Priorité : tiers des bureaux classés par potentiel = moyenne des scores z de la part LFI des exprimés et du taux d'abstention, calculés entre les bureaux de la commune. Le découpage des bureaux peut avoir évolué depuis le scrutin.",
    });
    out.charts.push({
      id: "lfi_chart_bureaux",
      title: `Vote LFI et abstention par bureau de vote (${bvRef.election.label}, % des inscrits)`,
      type: "bar",
      xKey: "bv",
      data: [...ranked].sort((a, b) => Number(a.bv) - Number(b.bv)).map((b) => ({ bv: `BV ${b.bv}`, lfi: Math.round(b.lfiPctIns * 10) / 10, abst: Math.round(b.abstPct * 10) / 10 })),
      series: [
        { key: "lfi", label: "Vote LFI (% inscrits)" },
        { key: "abst", label: "Abstention (% inscrits)" },
      ],
      unit: "%",
      sources: [bvRef.source],
    });
    // Indicateurs par bureau (traçabilité des constats).
    const bvGeoRef = (bv: string): GeoRef => ({ level: "bureau_vote", code: `${commune.code}-${bv}`, name: `${commune.nom} — BV ${bv}` });
    const bvInd = (b: BvRow, id: string, label: string, value: number) =>
      ({ id, label, theme: "strategie", value, unit: "%", year: bvRef.election.date.slice(0, 4), geo: bvGeoRef(b.bv), source: bvRef.source, status: "ok", denominator: b.inscrits }) as Indicator;
    for (const b of ranked) {
      out.indicators.push(bvInd(b, "lfi_bv_ins", `Vote LFI (${bvRef.election.label}) en % des inscrits`, b.lfiPctIns));
      out.indicators.push(bvInd(b, "lfi_bv_exp", `Vote LFI (${bvRef.election.label}) en % des exprimés`, b.lfiPctExp));
      out.indicators.push(bvInd(b, "abst_bv", `Abstention (${bvRef.election.label}) en % des inscrits`, b.abstPct));
    }
    const bvEv = (rows: BvRow[], id = "lfi_bv_ins") => rows.map((b) => `${id}@bureau_vote:${commune.code}-${b.bv}`);
    const top = ranked.slice(0, Math.max(1, prio.length));
    const topVoix = top.reduce((s, b) => s + b.lfiVoix, 0);
    const allVoix = ranked.reduce((s, b) => s + b.lfiVoix, 0);
    addF({
      kind: "atout",
      evidence: [...bvEv(top), ...bvEv(top, "abst_bv")],
      text: `Où : les bureaux ${top.map((b) => `${b.bv}${labels.has(b.bv) ? ` (${b.label})` : ""}`).join(", ")} concentrent ${fmtNumber(topVoix)} voix LFI (${pct((100 * topVoix) / (allVoix || 1), 0)} des voix LFI de la commune) et ${fmtNumber(top.reduce((s, b) => s + b.abstN, 0))} abstentionnistes.`,
      weight: 95,
    });
    const best = [...ranked].sort((a, b) => b.lfiPctExp - a.lfiPctExp)[0];
    const worst = [...ranked].sort((a, b) => a.lfiPctExp - b.lfiPctExp)[0];
    if (best && worst && best !== worst)
      addF({
        kind: "constat",
        text: `Écart interne : de ${pct(worst.lfiPctExp)} des exprimés (BV ${worst.bv}) à ${pct(best.lfiPctExp)} (BV ${best.bv}) — les scores se concentrent dans une partie de la commune.`,
        evidence: bvEv([worst, best], "lfi_bv_exp"),
        weight: 70,
      });

    // Cartes par bureau : contours si disponibles, sinon lieux de vote (points).
    const geo = c.bvGeo?.features ?? [];
    const pts = c.bvGeo?.points ?? [];
    if (!geo.length && pts.length) {
      const byBv = new Map(ranked.map((b) => [b.bv, b]));
      const vals = ranked.map((b) => b.lfiPctIns);
      const br = quantileBreaks(vals, Math.min(5, vals.length));
      const classes: { min: number; max: number; color: string }[] = [];
      for (let i = 0; i < br.length - 1; i++) classes.push({ min: br[i], max: br[i + 1], color: SEQ_COLORS[Math.min(4, Math.round((i * 4) / Math.max(1, br.length - 2)))] });
      const colorOf = (v: number | null) => (v == null ? MISSING_COLOR : (classes.find((k) => v <= k.max) ?? classes[classes.length - 1])?.color ?? MISSING_COLOR);
      const features = pts.map((f) => {
        const b = byBv.get(String(f.properties?.bv));
        return { ...f, properties: { ...f.properties, name: `BV ${f.properties?.bv} — ${f.properties?.label} : LFI ${b ? pct(b.lfiPctIns) : "n.d."} des inscrits, abstention ${b ? pct(b.abstPct) : "n.d."}`, color: colorOf(b ? b.lfiPctIns : null) } };
      });
      const contour = commune.contour ? [{ type: "Feature" as const, geometry: commune.contour, properties: { nom: commune.nom } }] : [];
      const all = turf.featureCollection([...features, ...contour] as GeoJSON.Feature[]);
      out.maps.push({
        id: "lfi_map_bv",
        title: `Lieux de vote colorés selon le vote LFI (${bvRef.election.label}, % des inscrits)`,
        theme: "strategie",
        bbox: turf.bbox(turf.buffer(all, 0.3, { units: "kilometers" })!) as [number, number, number, number],
        layers: [
          ...(contour.length ? [{ id: "contour", label: `Limite communale de ${commune.nom}`, kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: contour }, color: "#374151", outlineOnly: true, visible: true, source: c.geoSource ?? c.bvGeo!.source }] : []),
          { id: "lieux", label: "Lieux de vote", kind: "points", data: { type: "FeatureCollection", features }, visible: true, source: c.bvGeo!.source },
        ],
        legend: { title: "Vote LFI (% inscrits)", unit: "%", categories: classes.map((k) => ({ label: `${fmtNumber(k.min, 1)} – ${fmtNumber(k.max, 1)} %`, color: k.color })) },
        note: "Contours des bureaux non disponibles : chaque point est le lieu de vote (adresse du Répertoire électoral unique géocodée par la Base adresse nationale).",
      });
    }
    if (geo.length) {
      const byBv = new Map(ranked.map((b) => [b.bv, b]));
      const fc = (prop: (b: BvRow) => number): GeoJSON.FeatureCollection => ({
        type: "FeatureCollection",
        features: geo.map((f) => {
          const b = byBv.get(String(f.properties?.bv));
          return { ...turf.truncate(f, { precision: 5 }), properties: { ...f.properties, nom: `BV ${f.properties?.bv} — ${f.properties?.label}`, valeur: b ? Math.round(prop(b) * 10) / 10 : null } };
        }),
      });
      const legend = (title: string, vals: number[]) => {
        const br = quantileBreaks(vals, Math.min(5, vals.length));
        const classes = [];
        for (let i = 0; i < br.length - 1; i++) classes.push({ min: br[i], max: br[i + 1], color: SEQ_COLORS[Math.min(4, Math.round((i * 4) / Math.max(1, br.length - 2)))] });
        return { title, unit: "%" as const, classes, missingLabel: "Bureau non apparié" };
      };
      const bbox = turf.bbox(turf.featureCollection(geo)) as [number, number, number, number];
      const src = c.bvGeo!.source;
      const approx =
        c.bvGeo!.method === "enveloppe"
          ? "Contours approximatifs (enveloppe des adresses d'électeurs du REU)."
          : c.bvGeo!.method === "contours"
            ? "Contours proposés par l'INSEE (méthode statistique) : ils peuvent différer du découpage arrêté par la mairie."
            : "";
      out.maps.push({
        id: "lfi_map_bv",
        group: "lfi_bv",
        period: "Vote LFI",
        title: `Vote LFI par bureau de vote (${bvRef.election.label}, % des inscrits)`,
        theme: "strategie",
        bbox,
        layers: [{ id: "bv", label: "Vote LFI (% inscrits)", kind: "polygons", data: fc((b) => b.lfiPctIns), valueProperty: "valeur", visible: true, source: src }],
        legend: legend("Vote LFI (% inscrits)", ranked.map((b) => b.lfiPctIns)),
        note: approx,
      });
      out.maps.push({
        id: "lfi_map_bv_participation",
        group: "lfi_bv",
        period: "Participation",
        title: `Participation par bureau de vote (${bvRef.election.label}, % des inscrits)`,
        theme: "strategie",
        bbox,
        layers: [{ id: "bv", label: "Participation (%)", kind: "polygons", data: fc((b) => 100 - b.abstPct), valueProperty: "valeur", visible: true, source: src }],
        legend: legend("Participation (% inscrits)", ranked.map((b) => 100 - b.abstPct)),
        note: approx,
      });
    }
  }

  /* ------------------------------------------------------------ pourquoi (hypothèses) */
  const pov = get("taux_pauvrete", geos.commune);
  const povDep = get("taux_pauvrete", geos.departement);
  const young = get("part_moins_25", geos.commune);
  const youngDep = get("part_moins_25", geos.departement);
  const hlm = get("part_locataires_hlm", geos.commune);
  const hlmDep = get("part_locataires_hlm", geos.departement);
  const reasons: string[] = [];
  const ev: Indicator[] = [];
  if (pov && povDep && gap(pov.value!, povDep.value!, "%").direction === "superieur") {
    reasons.push(`un taux de pauvreté élevé (${pct(pov.value)} contre ${pct(povDep.value)})`);
    ev.push(pov, povDep);
  }
  if (young && youngDep && gap(young.value!, youngDep.value!, "%").direction === "superieur") {
    reasons.push(`une population jeune (${pct(young.value)} de moins de 25 ans contre ${pct(youngDep.value)})`);
    ev.push(young, youngDep);
  }
  if (hlm && hlmDep && gap(hlm.value!, hlmDep.value!, "%").direction === "superieur") {
    reasons.push(`un parc HLM important (${pct(hlm.value)} des ménages contre ${pct(hlmDep.value)})`);
    ev.push(hlm, hlmDep);
  }
  if (reasons.length)
    addF({
      kind: "hypothese",
      text: `Pourquoi : la commune combine ${reasons.join(", ")}. Ces caractéristiques sont, à l'échelle nationale, associées à un vote LFI plus élevé mais aussi à une abstention plus forte ; elles pourraient expliquer à la fois le potentiel et la marge de mobilisation. Corrélation territoriale, pas causalité : à confirmer par la connaissance du terrain.`,
      evidence: ev.map(evidenceId),
      weight: 75,
    });

  // Hétérogénéité interne : piste d'explication par les quartiers.
  if (ranked.length >= 3) {
    const sorted = [...ranked].sort((x, y) => y.lfiPctExp - x.lfiPctExp);
    const spread = sorted[0].lfiPctExp - sorted[sorted.length - 1].lfiPctExp;
    if (spread >= 10)
      addF({
        kind: "hypothese",
        text: `Pourquoi les écarts entre bureaux (${fmtNumber(spread, 1)} points de part LFI des exprimés entre le BV ${sorted[0].bv} et le BV ${sorted[sorted.length - 1].bv}) : ils reflètent probablement des différences de composition sociale entre quartiers (habitat social, population étudiante, âge). Hypothèse à confirmer par les données infracommunales (IRIS, quartiers prioritaires) et la connaissance du terrain.`,
        evidence: [`lfi_bv_exp@bureau_vote:${commune.code}-${sorted[0].bv}`, `lfi_bv_exp@bureau_vote:${commune.code}-${sorted[sorted.length - 1].bv}`],
        weight: 65,
      });
  }
  if (!reasons.length && out.findings.some((f) => f.kind === "atout" && /surperformance/.test(f.text)))
    addF({
      kind: "hypothese",
      text: "La surperformance LFI ne s'explique pas par les indicateurs sociodémographiques communaux disponibles (revenus, âge, logement social proches de la moyenne) : d'autres facteurs pourraient jouer (implantation militante, quartiers spécifiques, électorat néo-résident). À confirmer avec les retours de terrain.",
      evidence: out.indicators.filter((i) => i.id === "lfi_EU24_ins").map(evidenceId),
      weight: 60,
    });

  /* ------------------------------------------------------------ comment : lieux d'action */
  const centroids = new Map<string, [number, number]>();
  // Lieu de vote en priorité (repère concret), sinon centre du contour.
  for (const f of c.bvGeo?.points ?? []) centroids.set(String(f.properties?.bv), f.geometry.coordinates as [number, number]);
  for (const f of c.bvGeo?.features ?? []) {
    if (centroids.has(String(f.properties?.bv))) continue;
    try {
      centroids.set(String(f.properties?.bv), turf.centroid(f).geometry.coordinates as [number, number]);
    } catch {
      /* géométrie invalide */
    }
  }
  const polys = c.bvGeo?.features ?? [];
  const nearestBv = (lon: number | null, lat: number | null) => {
    if (lon == null || lat == null || !centroids.size) return null;
    // Bureau dont le contour contient le lieu, sinon lieu de vote le plus proche.
    for (const f of polys) {
      try {
        if (turf.booleanPointInPolygon([lon, lat], f)) return { bv: String(f.properties?.bv), d: 0 };
      } catch {
        /* géométrie invalide */
      }
    }
    let best: { bv: string; d: number } | null = null;
    for (const [bv, cc] of centroids) {
      const d = haversineKm([lon, lat], cc);
      if (!best || d < best.d) best = { bv, d };
    }
    return best;
  };
  const prioSet = new Set(prio.map((p) => p.bv));
  type Lieu = { type: string; nom: string; infos: string; bv: string; prioritaire: string; lon: number | null; lat: number | null };
  const lieux: Lieu[] = [];
  const pushLieu = (type: string, nom: string, infos: string, lon: number | null, lat: number | null) => {
    const nb = nearestBv(lon, lat);
    lieux.push({ type, nom, infos, bv: nb ? `BV ${nb.bv}` : "", prioritaire: nb && prioSet.has(nb.bv) ? "oui" : "", lon, lat });
  };
  const eq = c.equipments?.features ?? [];
  for (const f of eq.filter((f) => f.properties?.category === "marche")) {
    const [lon, lat] = f.geometry.coordinates;
    pushLieu("Marché", String(f.properties?.name ?? "Marché"), frenchHours(f.properties?.opening_hours as string) || "horaires non renseignés dans OSM", lon, lat);
  }
  for (const s of c.stations?.stations ?? []) {
    const last = s.frequentation[s.frequentation.length - 1];
    pushLieu("Gare", s.nom, last ? `${fmtNumber(last.voyageurs)} voyageurs en ${last.year}` : "fréquentation n.d.", s.lon, s.lat);
  }
  // Supermarchés (pas les supérettes de stations-service) ; établissements : collèges et
  // lycées principaux (sans les sections SEGPA/SEP rattachées), dédoublonnés.
  for (const f of eq.filter((f) => f.properties?.category === "alimentaire" && (f.properties?.shop === "supermarket" || f.properties?.shop == null))) {
    const [lon, lat] = f.geometry.coordinates;
    if (!f.properties?.name || /^(total|esso|bp|shell|avia)\b/i.test(String(f.properties.name))) continue;
    pushLieu("Supermarché", String(f.properties.name), frenchHours(f.properties?.opening_hours as string), lon, lat);
  }
  const seenSchools = new Set<string>();
  for (const s of (c.schools?.schools ?? []).filter((s) => /coll[èe]ge|lyc[ée]e/i.test(s.type) && !/^section/i.test(s.nom))) {
    if (seenSchools.has(s.nom)) continue;
    seenSchools.add(s.nom);
    pushLieu(`Sortie de ${s.type.toLowerCase()}`, s.nom, s.priorite && !/^non$/i.test(s.priorite) ? `éducation prioritaire (${s.priorite})` : s.statut, s.lon, s.lat);
  }
  // Lorsque les bureaux sont localisés, on ne garde que les lieux des bureaux prioritaires,
  // plus les marchés et gares (lieux de passage à l'échelle de la commune).
  if (centroids.size && prioSet.size) {
    const keep = lieux.filter((l) => l.prioritaire || l.type === "Marché" || l.type === "Gare");
    lieux.length = 0;
    lieux.push(...keep);
  }
  if (lieux.length) {
    const order = ["Marché", "Gare", "Supermarché", "Sortie de collège", "Sortie de lycée"];
    lieux.sort((a, b) => (b.prioritaire ? 1 : 0) - (a.prioritaire ? 1 : 0) || order.indexOf(a.type) - order.indexOf(b.type) || a.bv.localeCompare(b.bv));
    out.tables.push({
      id: "lfi_lieux",
      title: "Lieux d'action : marchés, gares, commerces, établissements scolaires",
      theme: "strategie",
      columns: [
        { key: "type", label: "Type" },
        { key: "nom", label: "Nom" },
        { key: "infos", label: "Horaires / fréquentation" },
        ...(centroids.size ? [{ key: "bv", label: "Bureau le plus proche" }, { key: "prioritaire", label: "BV prioritaire" }] : []),
      ],
      rows: lieux.slice(0, 30).map(({ type, nom, infos, bv, prioritaire }) => ({ type, nom, infos, bv, prioritaire })),
      sources: [c.equipments?.source, c.stations?.source, c.schools?.source].filter(Boolean) as SourceRef[],
      note: "Horaires issus d'OpenStreetMap lorsqu'ils sont renseignés : à vérifier auprès de la mairie. Fréquentation des gares : SNCF Open Data.",
    });
  }

  // Actions recommandées (pistes), ordonnées.
  const actions: { text: string }[] = [];
  if (prio.length) {
    const near = (bv: string) =>
      (c.schools?.schools ?? [])
        .filter((s) => s.lon != null && centroids.has(bv))
        .map((s) => ({ s, d: haversineKm([s.lon!, s.lat!], centroids.get(bv)!) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
        .map((x) => x.s.nom);
    actions.push({
      text: `Porte-à-porte (priorité) : bureaux ${prio
        .map((p) => {
          const adr = c.bvGeo?.points.find((f) => String(f.properties?.bv) === p.bv)?.properties?.adresse;
          return `${p.bv}${labels.has(p.bv) ? ` — ${p.label}` : ""}${adr ? ` (${adr})` : near(p.bv).length ? ` (près de ${near(p.bv).join(", ")})` : ""}`;
        })
        .join(" ; ")}.`,
    });
    const reservoir = ranked.filter((b) => b.type === "reservoir_abstention").slice(0, 3);
    if (reservoir.length) actions.push({ text: `Mobilisation des abstentionnistes et inscription sur les listes électorales : bureaux ${reservoir.map((b) => b.bv).join(", ")} (abstention élevée).` });
  }
  const markets = lieux.filter((l) => l.type === "Marché");
  if (markets.length) actions.push({ text: `Marchés : ${markets.slice(0, 4).map((m) => `${m.nom}${m.infos ? ` (${m.infos})` : ""}`).join(" ; ")}.` });
  const gares = lieux.filter((l) => l.type === "Gare");
  if (gares.length)
    actions.push({
      text: `Gares : ${gares.map((g) => `${g.nom} (${g.infos})`).join(" ; ")}. Privilégier les heures de pointe (7 h-9 h, 17 h-19 h, à confirmer avec les fiches horaires TER).`,
    });
  const sup = lieux.filter((l) => l.type === "Supermarché");
  if (sup.length) actions.push({ text: `Supermarchés${sup.some((s) => s.prioritaire) ? " dans les bureaux prioritaires" : ""} : ${sup.slice(0, 5).map((s) => `${s.nom}${s.bv ? ` (${s.bv})` : ""}${s.infos ? `, ${s.infos}` : ""}`).join(" ; ")}.` });
  const ecoles = lieux.filter((l) => l.type.startsWith("Sortie"));
  if (ecoles.length) actions.push({ text: `Sorties de collèges et lycées (parents, jeunes) : ${ecoles.slice(0, 4).map((s) => s.nom).join(", ")}.` });
  const groupes = c.interne.groupes.filter((g) => g.code === commune.code || (commune.epci && referentiel().epcis.find((e) => e.code === commune.epci!.code)?.membres.some((m) => m.code === g.code)));
  if (!groupes.length) actions.push({ text: "Aucun groupe d'action référencé dans les données fournies : envisager la création d'un groupe local, encadré par un groupe voisin actif." });
  for (const a of actions) addF({ kind: "piste", text: a.text, evidence: [], weight: 70 });

  /* ------------------------------------------------------------ accessibilité */
  const access: string[] = [];
  if (c.stations?.stations.length) access.push(`gare${c.stations.stations.length > 1 ? "s" : ""} : ${c.stations.stations.map((s) => s.nom).join(", ")}`);
  if (nearestBig) access.push(`${nearestBig.nom} à ${fmtValue(nearestBig.distanceKm, "km")}`);
  if (c.parisKm != null) access.push(`Paris à ${fmtValue(c.parisKm, "km")} à vol d'oiseau`);
  const cy = get("km_amenagements_cyclables", geos.commune);
  if (cy) access.push(`${fmtValue(cy.value, "km")} d'aménagements cyclables`);

  /* ------------------------------------------------------------ section */
  if (!out.tables.length && !bullets.length) return out;
  blocks.push({
    type: "note",
    text: "Fiche établie à partir de données statistiques et électorales publiques agrégées (commune, bureau de vote), par des personnes qui ne connaissent pas forcément le terrain : ses propositions doivent être confrontées à la connaissance des militantes et militants locaux. Aucune donnée individuelle n'est utilisée.",
  });
  blocks.push({ type: "list", title: "Profil sociodémographique du territoire", items: bullets.map((text) => ({ text })) });
  if (out.tables.some((t) => t.id === "lfi_socio")) blocks.push({ type: "table", tableId: "lfi_socio" });
  // Profil politique
  if (groupes.length)
    blocks.push({ type: "list", title: "Implantation militante (données internes)", items: groupes.map((g) => ({ text: `${g.nom}${g.membres != null ? ` — ${g.membres} membres` : ""}${g.statut ? ` — ${g.statut}` : ""}${g.description ? ` : ${g.description}` : ""}` })) });
  else
    blocks.push({ type: "note", text: "Données internes non fournies (groupes d'action, parrainages) : déposer groupes.csv et parrains.csv dans data/interne/ pour les intégrer (voir README)." });
  if (out.tables.some((t) => t.id === "lfi_politique")) blocks.push({ type: "table", tableId: "lfi_politique" });
  blocks.push({ type: "findings", themes: ["strategie"], kinds: ["atout", "constat"], title: "Atouts et constats" });
  if (out.tables.some((t) => t.id === "lfi_partis")) blocks.push({ type: "table", tableId: "lfi_partis" });
  if (out.tables.some((t) => t.id === "lfi_bureaux")) {
    blocks.push({ type: "map", mapId: "lfi_map_bv" });
    if (out.maps.some((m) => m.id === "lfi_map_bv_participation")) blocks.push({ type: "map", mapId: "lfi_map_bv_participation" });
    blocks.push({ type: "chart", chartId: "lfi_chart_bureaux" }, { type: "table", tableId: "lfi_bureaux" });
  } else blocks.push({ type: "note", text: "Résultats par bureau de vote indisponibles lors de la génération." });
  blocks.push({ type: "findings", themes: ["strategie"], kinds: ["hypothese"], title: "Pourquoi : hypothèses à vérifier" });
  blocks.push({ type: "findings", themes: ["strategie"], kinds: ["piste"], title: "Actions recommandées" });
  if (out.tables.some((t) => t.id === "lfi_lieux")) blocks.push({ type: "table", tableId: "lfi_lieux" });
  if (access.length) blocks.push({ type: "note", text: `Accessibilité : ${access.join(" ; ")}.` });
  out.section = { id: "LFI", letter: "", title: "Fiche d'action — approche LFI", blocks };
  return out;
}

export { MISSING_COLOR };
