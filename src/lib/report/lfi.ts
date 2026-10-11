import * as turf from "@turf/turf";
import { referentiel } from "../collectors/admin";
import type { BureauResult, ElectionResult } from "../collectors/elections";
import { abstention, BV_TYPE_LABELS, BvRow, familyPerformance, frenchHours, lfiOverperformance, prettyBvLabel, rankBureaux, score } from "../analysis/political";
import { gap, haversineKm, quantileBreaks } from "../analysis/stats";
import { evidenceId } from "../analysis/findings";
import { fmtNumber, fmtSigned, fmtValue } from "../format";
import type { Block, ChartSpec, DataTable, Finding, GeoRef, Indicator, MapLegend, MapSpec, Section, SourceRef } from "../types";
import { MISSING_COLOR, SEQ_COLORS } from "./assemble";
import { bureauxByQuartier, matchBureaux, quartierLabel, quartierOfBureau } from "../analysis/quartiers";
import type { Quartier } from "../collectors/quartiers";
import { NUANCES, nuanceFamily } from "../collectors/municipales";
import { BPE_TYPES } from "../collectors/bpe";
import { fmtDuration } from "../collectors/routes";
import type { Collected } from "./collect";

/**
 * Fiche d'action « développement territorial », sur le modèle des fiches
 * « PEE · Développement territorial » (proposition de ciblage par territoire) :
 *
 *  0. avertissement + « en bref » (chiffres clés, atout et difficulté principaux) ;
 *  1. profil sociodémographique : puces rédigées, limitées aux écarts
 *     significatifs au département (les autres sont regroupées), tableau
 *     comparatif, répartition par âge ;
 *  2. profil politique : implantation militante (encadré), surperformance,
 *     parrainages, tableau Inscrits / LFI P22 / LFI E24 / Parrains / Abstention,
 *     abstention, forces de gauche et RN ;
 *  3. où agir : cartes vote LFI / participation par bureau, classement ;
 *  4. pourquoi : hypothèses à confronter au terrain ;
 *  5. actions recommandées, regroupées par type de lieu (porte-à-porte,
 *     marchés, gares, supermarchés, sorties d'établissements), et accessibilité.
 *
 * Tous les chiffres proviennent des données collectées ; chaque constat porte
 * ses preuves ; les explications sont présentées comme des hypothèses.
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
/** « 2 809 (9,8 %) » avec le pourcentage en gras, comme dans les fiches de référence. */
const cnt = (n: number | null | undefined, p: number | null | undefined) => (n == null ? "n.d." : `${fmtNumber(n)} **(${pct(p)})**`);
const B = (s: string) => `**${s}**`;
/** Majuscule initiale, y compris derrière un balisage `**…**`. */
const cap = (s: string) => s.replace(/^(\**)(.)/, (_m, a: string, c: string) => a + c.toUpperCase());
const joinFr = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}`);

/** Palette divergente (faible → élevé) des cartes par bureau, proche des fiches de référence. */
export const DIV_COLORS = ["#3f6fb0", "#8eaed6", "#cfc8d8", "#e3a07f", "#c0503a"];

function divergingLegend(title: string, vals: number[]): MapLegend {
  const br = quantileBreaks(vals, Math.min(5, vals.length));
  const n = br.length - 1;
  const classes = [];
  for (let i = 0; i < n; i++) classes.push({ min: br[i], max: br[i + 1], color: DIV_COLORS[n === 1 ? 2 : Math.round((i * 4) / (n - 1))] });
  return { title, unit: "%", classes, missingLabel: "Bureau non apparié" };
}

export function buildLfi(c: Collected, indicators: Indicator[]): LfiOutput {
  const out: LfiOutput = { section: null, tables: [], charts: [], maps: [], findings: [], indicators: [] };
  const { commune, geos } = c;
  let fid = 1000;
  const addF = (f: Omit<Finding, "id" | "theme">) => {
    const id = `L${++fid}`;
    out.findings.push({ ...f, id, theme: "strategie" });
    return id;
  };
  const get = (id: string, g: GeoRef | null | undefined) => (g ? indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code && i.value != null) : undefined);
  const depName = geos.departement.name;

  /* ================================================================ 1. socio */
  const socioGeos = [geos.commune, geos.epci, geos.departement, geos.region, geos.france].filter(Boolean) as GeoRef[];
  const rowFor = (g: GeoRef) => {
    const v = (id: string) => get(id, g)?.value ?? null;
    return {
      territoire: g.level === "commune" ? g.name : g.level === "france" ? "France" : g.name,
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
  const socioRows = socioGeos.map((g) => ({ g, row: rowFor(g) })).filter(({ row }) => Object.values(row).some((x, i) => i > 0 && x !== "n.d."));
  const socioSources = [...new Map(indicators.filter((i) => ["revenu_median", "taux_pauvrete", "part_moins_25", "part_65_plus", "taux_chomage_rp", "part_locataires", "part_ouvriers"].includes(i.id)).map((i) => [i.source.dataset ?? i.source.id, i.source])).values()];
  if (socioRows.length) {
    out.tables.push({
      id: "lfi_socio",
      title: "Profil sociodémographique comparé",
      theme: "strategie",
      columns: [
        { key: "territoire", label: "", wide: true },
        { key: "revenu", label: "Revenu médian", align: "right" },
        { key: "pauvrete", label: "Taux de pauvreté", align: "right" },
        { key: "jeunes", label: "Moins de 25 ans", align: "right" },
        { key: "ages", label: "65 ans et +", align: "right" },
        { key: "chomage", label: "Taux de chômage", align: "right" },
        { key: "locataires", label: "Locataires (dont HLM)", align: "right" },
        { key: "diplome", label: "Sans diplôme ou brevet seul", align: "right" },
        { key: "ouvriers", label: "Ouvriers", align: "right" },
      ],
      rows: socioRows.map((x) => x.row),
      highlight: socioRows[0]?.g.level === "commune" ? [0] : [],
      sources: socioSources,
      note: "Revenu disponible médian par unité de consommation (Filosofi) ; autres indicateurs : recensement de la population. Locataires : part des ménages, dont locataires HLM entre parenthèses.",
    });
  }

  // Puces rédigées : seuls les écarts significatifs au département sont développés,
  // les indicateurs proches de la moyenne sont regroupés dans une puce unique.
  type Item = { text: string; evidence?: string[] };
  const socio: Item[] = [];
  const average: string[] = [];
  const evOf = (...xs: (Indicator | undefined)[]) => xs.filter(Boolean).map((i) => evidenceId(i!));
  const cmp = (id: string) => {
    const a = get(id, geos.commune);
    const b = get(id, geos.departement);
    if (!a || !b) return null;
    const unit = a.unit === "€" ? "€" : "%";
    return { a, b, dir: gap(a.value!, b.value!, unit).direction, va: fmtValue(a.value, a.unit), vb: fmtValue(b.value, b.unit) };
  };
  const vs = (x: NonNullable<ReturnType<typeof cmp>>) => `${x.va} contre ${x.vb} dans le département`;

  const pop = get("pop_municipale", geos.commune);
  const dens = get("densite", geos.commune);
  const evol = get("evol_pop_annuelle", geos.commune);
  const popEpci = get("pop_municipale", geos.epci);
  if (pop) {
    let t = `${B(`Environ ${fmtNumber(Math.round(pop.value! / 100) * 100)} habitants`)}${dens ? ` (${fmtValue(dens.value, "hab/km²")})` : ""}`;
    if (popEpci && geos.epci) t += `, au sein d'une intercommunalité de ${fmtNumber(Math.round(popEpci.value! / 1000) * 1000)} habitants`;
    if (evol) {
      const v = evol.value!;
      const period = evol.label.match(/\((\d{4}-\d{4})\)/)?.[1];
      t +=
        v <= -0.5
          ? ` ; ${B("déclin démographique")} (${fmtSigned(v, "%", 1)} par an${period ? ` sur ${period}` : ""})`
          : v >= 0.5
            ? ` ; population en croissance (${fmtSigned(v, "%", 1)} par an${period ? ` sur ${period}` : ""})`
            : ` ; population à peu près stable (${fmtSigned(v, "%", 1)} par an${period ? ` sur ${period}` : ""})`;
    }
    socio.push({ text: t + ".", evidence: evOf(pop, dens, evol) });
  }

  const rev = cmp("revenu_median");
  const pov = cmp("taux_pauvrete");
  if (rev || pov) {
    let head: string;
    if (pov?.dir === "superieur") head = `${B("Pauvreté marquée")} : taux de pauvreté de ${vs(pov)}`;
    else if (rev?.dir === "inferieur") head = `${B("Classes moyennes-inférieures")} : revenu médian de ${vs(rev)}${pov ? `, mais pauvreté contenue (${pov.va})` : ""}`;
    else if (rev?.dir === "superieur") head = `${B("Population plutôt aisée")} : revenu médian de ${vs(rev)}${pov ? `, taux de pauvreté de ${pov.va}` : ""}`;
    else head = "";
    if (head) {
      if (pov?.dir === "superieur" && rev) head += ` ; revenu médian de ${rev.va} (département : ${rev.vb})`;
      socio.push({ text: head + ".", evidence: evOf(rev?.a, rev?.b, pov?.a, pov?.b) });
    } else average.push("revenus et pauvreté");
  }

  const hlm = cmp("part_locataires_hlm");
  if (hlm) {
    if (hlm.dir === "superieur") socio.push({ text: `${B("Parc HLM important")} : ${hlm.va} des ménages sont locataires HLM (département : ${hlm.vb}).`, evidence: evOf(hlm.a, hlm.b) });
    else if (hlm.dir === "inferieur") socio.push({ text: `${B("Territoire sous-doté en HLM")} : ${hlm.va} des ménages (département : ${hlm.vb}).`, evidence: evOf(hlm.a, hlm.b) });
    else average.push("logement social");
  }
  const sec = get("part_residences_secondaires", geos.commune);
  if (sec && sec.value! >= 10) socio.push({ text: `${B("Résidences secondaires nombreuses")} : ${pct(sec.value)} des logements.`, evidence: evOf(sec) });
  const vac = cmp("part_logements_vacants");
  if (vac && vac.dir === "superieur" && vac.a.value! >= 9) socio.push({ text: `${B("Vacance élevée")} : ${vac.va} de logements vacants (département : ${vac.vb}).`, evidence: evOf(vac.a, vac.b) });

  const old = cmp(get("part_65_plus", geos.commune) ? "part_65_plus" : "part_60_plus");
  const young = cmp(get("part_moins_25", geos.commune) ? "part_moins_25" : "part_moins_30");
  const ret = cmp("part_retraites");
  const older = old?.dir === "superieur" || young?.dir === "inferieur";
  const younger = old?.dir === "inferieur" || young?.dir === "superieur";
  if (older !== younger) {
    const det = [old && `${old.va} de 65 ans et plus (département : ${old.vb})`, young && `${young.va} de moins de 25 ans (${young.vb})`, ret && `${ret.va} de retraités parmi les 15 ans et plus`].filter(Boolean).join(", ");
    socio.push({ text: `Population ${B(older ? "plus âgée" : "plus jeune")} que dans le reste du département : ${det}.`, evidence: evOf(old?.a, old?.b, young?.a, young?.b, ret?.a) });
  } else if (old || young) average.push("structure par âge");

  const csp = [
    { id: "part_ouvriers", lbl: "ouvriers" },
    { id: "part_employes", lbl: "employés" },
    { id: "part_cadres", lbl: "cadres" },
  ].map((x) => ({ ...x, c: cmp(x.id) }));
  const over = csp.filter((x) => x.c?.dir === "superieur");
  const under = csp.filter((x) => x.c?.dir === "inferieur");
  if (over.length || under.length) {
    const parts = [];
    if (over.length) parts.push(`${B(`sur-représentation des ${joinFr(over.map((x) => x.lbl))}`)} (${over.map((x) => `${x.c!.va} contre ${x.c!.vb}`).join(" ; ")})`);
    if (under.length) parts.push(`${B(`peu ${under.length === 1 && under[0].lbl === "cadres" ? "de cadres" : `d'${joinFr(under.map((x) => x.lbl))}`}`)} (${under.map((x) => `${x.c!.va} contre ${x.c!.vb}`).join(" ; ")})`);
    socio.push({ text: cap(parts.join(" ; ")) + ", parmi les 15 ans et plus.", evidence: [...over, ...under].flatMap((x) => evOf(x.c!.a, x.c!.b)) });
  } else if (csp.some((x) => x.c)) average.push("catégories socioprofessionnelles");

  const cho = cmp("taux_chomage_rp");
  if (cho) {
    if (cho.dir === "superieur") socio.push({ text: `${B("Chômage élevé")} : ${cho.va} des actifs de 15-64 ans (département : ${cho.vb}).`, evidence: evOf(cho.a, cho.b) });
    else if (cho.dir === "inferieur") socio.push({ text: `Chômage plus faible que dans le département (${vs(cho)}).`, evidence: evOf(cho.a, cho.b) });
    else average.push("chômage");
  }
  const dip = cmp("part_sans_diplome");
  if (dip?.dir === "superieur") socio.push({ text: `${B("Faible niveau de diplôme")} : ${dip.va} des 15 ans et plus sans diplôme ou avec le brevet seul (département : ${dip.vb}).`, evidence: evOf(dip.a, dip.b) });
  else if (dip) average.push("diplômes");

  const conc = get("concentration_emploi", geos.commune);
  const nearestBig = (commune.population ?? 0) < 20000 ? c.poles.find((p) => p.population >= 20000) : null;
  if (conc)
    socio.push({
      text:
        conc.value! >= 100
          ? `${B("Pôle d'emploi local")} : ${fmtNumber(conc.value!, 0)} emplois pour 100 actifs occupés résidents.`
          : `Commune ${B("résidentielle")} (${fmtNumber(conc.value!, 0)} emplois pour 100 actifs occupés résidents) : dépendance aux bassins d'emploi voisins${nearestBig ? `, notamment ${nearestBig.nom}` : ""}.`,
      evidence: evOf(conc),
    });
  const car = cmp("part_menages_sans_voiture");
  if (car?.dir === "superieur") socio.push({ text: `${B(`${car.va} des ménages sans voiture`)} (département : ${car.vb}) : publics à rencontrer à pied, près des arrêts et des commerces de proximité.`, evidence: evOf(car.a, car.b) });

  // Services : Base permanente des équipements (INSEE) si disponible, sinon OpenStreetMap.
  const popDep = c.populations.find((p) => p.geo.level === "departement")?.value ?? null;
  const bpeCount = (code: string) => c.bpe?.commune.filter((e) => e.type === code).length ?? 0;
  if (c.bpe && commune.population && popDep) {
    const per10k = (n: number, p: number) => (10000 * n) / p;
    const mc = per10k(bpeCount("D265"), commune.population);
    const md = per10k(c.bpe.countsDep.D265 ?? 0, popDep);
    const bpeInd = (id: string, label: string, value: number, g: GeoRef): Indicator => ({ id, label, theme: "sante", value, unit: "nombre", year: c.bpe!.source.vintage, geo: g, source: c.bpe!.source, status: "ok", method: "Équipements de type D265 (BPE) pour 10 000 habitants (population municipale)." });
    const i1 = bpeInd("medecins_10k", "Médecins généralistes pour 10 000 habitants", mc, geos.commune);
    const i2 = bpeInd("medecins_10k", "Médecins généralistes pour 10 000 habitants", md, geos.departement);
    out.indicators.push(i1, i2);
    const n = bpeCount("D265");
    const head =
      n === 0 && commune.population >= 1500
        ? `${B("Aucun médecin généraliste")} recensé dans la commune`
        : md && mc < md * 0.6
          ? `${B("Désert médical")} : ${fmtNumber(n)} médecin${n > 1 ? "s" : ""} généraliste${n > 1 ? "s" : ""}, soit ${fmtNumber(mc, 1)} pour 10 000 habitants (département : ${fmtNumber(md, 1)})`
          : `${fmtNumber(n)} médecin${n > 1 ? "s" : ""} généraliste${n > 1 ? "s" : ""} (${fmtNumber(mc, 1)} pour 10 000 habitants, département : ${fmtNumber(md, 1)})`;
    const urg = bpeCount("D106") > 0;
    const pub = [
      bpeCount("A128") ? "une antenne France Services" : "aucune antenne France Services",
      bpeCount("A122") ? "une agence France Travail" : "pas d'agence France Travail",
      bpeCount("A206") ? "un bureau de poste" : bpeCount("A207") + bpeCount("A208") ? "un relais ou une agence postale (pas de bureau de poste)" : "aucun point postal",
    ];
    socio.push({ text: `${head}${urg ? ", service d'urgences sur place" : ""} ; services publics : ${pub.join(", ")}.`, evidence: [evidenceId(i1), evidenceId(i2)] });
  }
  const med = c.bpe ? undefined : get("osm_medecin", geos.commune);
  const fs = get("osm_france_services", geos.commune);
  if (med && (commune.population ?? 0) >= 1500) {
    const parts = [`${fmtNumber(med.value!)} médecin${med.value! > 1 ? "s" : ""} ou cabinet${med.value! > 1 ? "s" : ""} médica${med.value! > 1 ? "ux" : "l"}`];
    if (fs) parts.push(fs.value! > 0 ? "une antenne France Services" : "aucune antenne France Services");
    socio.push({
      text: `${med.value === 0 ? `${B("Aucun médecin recensé")} : ` : "Services : "}${parts.join(", ")} selon OpenStreetMap (recensement à vérifier sur place).`,
      evidence: evOf(med, fs),
    });
  }
  if (average.length) socio.push({ text: `Dans la moyenne départementale : ${joinFr(average)}.` });

  /* ================================================================ 2. politique */
  const el = (id: string) => c.elections.find((e) => e.results[0]?.election.id === id);
  const e24 = el("EU24");
  const p22 = el("PR22T1");
  const com = (e?: { results: ElectionResult[] }) => e?.results.find((r) => r.level === "commune");
  const depR = (e?: { results: ElectionResult[] }) => e?.results.find((r) => r.level === "departement");
  const pops = new Map(referentiel().communes.filter((x) => x.departement === commune.departement.code && x.type === "commune-actuelle").map((x) => [x.code, x.population ?? null]));
  const parrains = c.interne.parrains.get(commune.code) ?? null;
  const depParrains = [...c.interne.parrains.entries()].filter(([k]) => k.startsWith(commune.departement.code)).reduce((s, [, v]) => s + v, 0);
  const elecSources: SourceRef[] = c.elections.map((e) => e.source);
  const interneFourni = c.interne.files.length > 0;

  const bvRef = c.bureaux.find((b) => b.election.id === "EU24") ?? c.bureaux.find((b) => b.election.id === "PR22T1");
  const bvSecond = c.bureaux.find((b) => b.election.id === "PR22T1" && b !== bvRef);
  // Libellés des lieux de vote ; les libellés génériques (« Bureau 5 ») n'apportent rien.
  const labels = new Map(
    [...(c.bvGeo?.labels ?? new Map<string, string>())]
      .map(([k, v]) => [k, prettyBvLabel(v)] as [string, string])
      .filter(([, v]) => !/^bureau( de vote)?\s*(n°|no|num[ée]ro)?\s*\d+$/i.test(v.trim())),
  );
  const ranked: BvRow[] = bvRef ? rankBureaux(bvRef.results, bvSecond?.results ?? null, labels) : [];
  const prio = ranked.filter((b) => b.priorite === 1);

  // Quartiers (QPV, IRIS) rattachés aux bureaux de vote.
  const qAll: Quartier[] = [...(c.quartiers?.qpv ?? []), ...(c.quartiers?.iris ?? [])];
  const qMatch = qAll.length && c.bvGeo ? matchBureaux(qAll, c.bvGeo.features ?? [], c.bvGeo.points ?? []) : [];
  const qByCode = new Map(qAll.map((q) => [`${q.kind}:${q.code}`, q]));
  const qName = (q: Quartier) => (q.kind === "qpv" ? `QPV ${quartierLabel(q.nom)}` : quartierLabel(q.nom));
  const quartierOf = (bv: string) => {
    const m = quartierOfBureau(qMatch, bv);
    return m ? (qByCode.get(`${m.kind}:${m.quartier}`) ?? null) : null;
  };
  const qBureaux = bureauxByQuartier(qMatch);
  const bvList = (bvs: string[]) => (bvs.length > 1 ? `BV ${bvs.slice(0, -1).join(", ")} et ${bvs[bvs.length - 1]}` : `BV ${bvs[0]}`);

  const ids = { perf: [] as string[], parrains: [] as string[], abst: [] as string[], partis: [] as string[], ou: [] as string[], hyp: [] as string[] };
  // Éléments réutilisés par l'« en bref ».
  let perfMain: { dir: string; abs: number; commune: number; median: number; name: string } | null = null;
  let parrainsRatio: { r1: number; r2: number } | null = null;
  let abstMain: { c: number; d: number; dir: string } | null = null;
  let lfiVoix24: number | null = null;

  const c24 = com(e24);
  const c22 = com(p22);
  const d24 = depR(e24);
  const d22 = depR(p22);
  if (c24 || c22) {
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
    const rows: Row[] = [line(commune.nom, c24?.inscrits ?? c22?.inscrits ?? null, c22 ? score("PR22T1", c22, "lfi") : null, c24 ? score("EU24", c24, "lfi") : null, parrains, c22 ? abstention(c22) : null, c24 ? abstention(c24) : null)];
    // Bureaux regroupés (comme « BV 3 et 7 (la Madeleine) » dans les fiches de référence) :
    // bureaux prioritaires, et bureaux de chaque quartier prioritaire.
    const aggOf = (res: BureauResult[] | undefined, bvs: string[]) => {
      if (!res) return null;
      const sel = res.filter((b) => bvs.includes(b.bv));
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
    const groupRow = (name: string, bvs: string[]) => {
      const a24 = aggOf(c.bureaux.find((b) => b.election.id === "EU24")?.results, bvs);
      const a22 = aggOf(c.bureaux.find((b) => b.election.id === "PR22T1")?.results, bvs);
      return line(name, a24?.inscrits ?? a22?.inscrits ?? null, a22 ? score("PR22T1", a22, "lfi") : null, a24 ? score("EU24", a24, "lfi") : null, null, a22 ? abstention(a22) : null, a24 ? abstention(a24) : null);
    };
    const prioBvs = prio.map((p) => p.bv);
    const qpvGroups = (c.quartiers?.qpv ?? []).map((q) => ({ q, bvs: qBureaux.get(q.code) ?? [] })).filter((x) => x.bvs.length);
    if (prio.length && bvRef) {
      const sameQ = prioBvs.map((b) => quartierOf(b)).filter(Boolean);
      const commonQ = sameQ.length === prioBvs.length && sameQ.every((q) => q === sameQ[0]) ? sameQ[0] : null;
      if (!qpvGroups.some((g) => g.bvs.join() === prioBvs.join())) rows.push(groupRow(`${bvList(prioBvs)} (${commonQ ? qName(commonQ) + ", " : ""}prioritaire${prioBvs.length > 1 ? "s" : ""})`, prioBvs));
    }
    for (const g of qpvGroups.slice(0, 3)) rows.push(groupRow(`${bvList(g.bvs)} (${qName(g.q)})`, g.bvs));
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
      title: "Vote LFI, parrainages et abstention",
      theme: "strategie",
      columns: [
        { key: "territoire", label: "", wide: true },
        { key: "inscrits", label: "Inscrits (2024)", align: "right" },
        { key: "lfi22", label: "LFI (P22)", align: "right" },
        { key: "lfi24", label: "LFI (E24)", align: "right" },
        ...(parrains != null || depParrains ? [{ key: "parrains", label: "Parrains", align: "right" as const }] : []),
        { key: "abst22", label: "Abstention (2022)", align: "right" },
        { key: "abst24", label: "Abstention (2024)", align: "right" },
      ],
      rows,
      highlight: [0],
      sources: elecSources,
      note: "Le nombre brut correspond au nombre de voix (ou de signataires) ; le pourcentage entre parenthèses est rapporté aux inscrits. P22 : présidentielle 2022, 1er tour (J.-L. Mélenchon) ; E24 : européennes 2024 (liste LFI). La ligne départementale n'est pas pondérée : c'est le score du département entier.",
    });

    // Indicateurs LFI (tableau de bord et preuves).
    const lfiInd = (id: string, label: string, value: number, g: GeoRef, src: SourceRef, year: string, method: string): Indicator => ({ id, label, theme: "strategie", value, unit: "%", year, geo: g, source: src, status: "ok", method });
    for (const [e, eid, y] of [[e24, "EU24", "2024"], [p22, "PR22T1", "2022"]] as const) {
      if (!e) continue;
      for (const r of e.results) {
        const s = score(eid, r, "lfi");
        const g = r.level === "commune" ? geos.commune : geos.departement;
        const name = eid === "EU24" ? "européennes 2024" : "présidentielle 2022";
        if (s) out.indicators.push(lfiInd(`lfi_${eid}_ins`, `Vote LFI (${name}) en % des inscrits`, s.pctInscrits, g, e.source, y, "Voix LFI / inscrits × 100."));
        if (s) out.indicators.push(lfiInd(`lfi_${eid}_exp`, `Vote LFI (${name}) en % des exprimés`, s.pctExprimes, g, e.source, y, "Voix LFI / suffrages exprimés × 100."));
        out.indicators.push(lfiInd(`abst_${eid}`, `Abstention (${name}) en % des inscrits`, abstention(r).pct, g, e.source, y, "Abstentions / inscrits × 100."));
      }
    }
    const ind = (id: string, lvl: "commune" | "departement") => out.indicators.find((i) => i.id === id && i.geo.level === lvl);
    if (c24) lfiVoix24 = score("EU24", c24, "lfi")?.voix ?? null;

    // Surperformance vs communes comparables du département (un seul constat, deux scrutins).
    const perfs: { eid: string; name: string; o: NonNullable<ReturnType<typeof lfiOverperformance>>; g: ReturnType<typeof gap> }[] = [];
    for (const [e, eid, name] of [[e24, "EU24", "européennes 2024"], [p22, "PR22T1", "présidentielle 2022"]] as const) {
      const d = depR(e);
      if (!d) continue;
      const o = lfiOverperformance(eid, d, commune.code, pops);
      if (o) perfs.push({ eid, name, o, g: gap(o.commune, o.median, "%") });
    }
    if (perfs.length) {
      const m = perfs[0];
      perfMain = { dir: m.g.direction, abs: m.g.abs, commune: m.o.commune, median: m.o.median, name: m.name };
      const verdict =
        m.g.direction === "superieur"
          ? "LFI surperforme par rapport aux communes de taille comparable du département"
          : m.g.direction === "inferieur"
            ? "LFI sous-performe par rapport aux communes de taille comparable du département"
            : "Le vote LFI est proche de celui des communes de taille comparable du département";
      const aux = (n: string) => (n.startsWith("présidentielle") ? `à la ${n}` : `aux ${n}`);
      const detail = perfs.map((p) => `${pct(p.o.commune)} des inscrits contre une médiane de ${pct(p.o.median)} ${aux(p.name)} (${fmtSigned(p.g.abs, "points")})`).join(" ; ");
      ids.perf.push(
        addF({
          kind: m.g.direction === "superieur" ? "atout" : "constat",
          text: `${B(verdict)} (les ${m.o.n} communes de taille la plus proche, de ${fmtNumber(m.o.minPop)} à ${fmtNumber(m.o.maxPop)} habitants) : ${detail}.`,
          evidence: perfs.map((p) => ind(`lfi_${p.eid}_ins`, "commune")).filter(Boolean).map((i) => evidenceId(i!)),
          weight: 90,
        }),
      );
    }

    // Parrainages.
    if (parrains != null && c24) {
      const s = score("EU24", c24, "lfi");
      const ds = d24 ? score("EU24", d24, "lfi") : null;
      if (s?.voix && ds?.voix && depParrains) {
        const r1 = parrains / s.voix;
        const r2 = depParrains / ds.voix;
        parrainsRatio = { r1, r2 };
        const src: SourceRef = { id: "interne", name: "Données militantes internes (parrains.csv)", url: "data/interne/parrains.csv", retrievedAt: new Date().toISOString() };
        out.indicators.push({ id: "parrains_pour_100_voix", label: "Parrains pour 100 voix LFI (E24)", theme: "strategie", value: r1 * 100, unit: "nombre", year: "2024", geo: geos.commune, source: src, status: "ok", method: "Parrains / voix LFI aux européennes 2024 × 100." });
        out.indicators.push({ id: "parrains_pour_100_voix", label: "Parrains pour 100 voix LFI (E24)", theme: "strategie", value: r2 * 100, unit: "nombre", year: "2024", geo: geos.departement, source: src, status: "ok", method: "Parrains / voix LFI aux européennes 2024 × 100." });
        const ratio = r1 / r2;
        const fois = ratio >= 1.5 || ratio <= 1 / 1.5 ? `${fmtNumber(ratio >= 1 ? ratio : 1 / ratio, 1)} fois ${ratio >= 1 ? "supérieur" : "inférieur"}` : ratio >= 1 ? "supérieur" : "inférieur";
        ids.parrains.push(
          addF({
            kind: r1 > r2 * 1.2 ? "atout" : r1 < r2 * 0.8 ? "vigilance" : "constat",
            evidence: [`parrains_pour_100_voix@commune:${commune.code}`, `parrains_pour_100_voix@departement:${geos.departement.code}`],
            text: `Le ratio parrains / voix LFI est ${fois} à la moyenne départementale (${fmtNumber(r1 * 100, 1)} parrains pour 100 électeurs LFI aux européennes, contre ${fmtNumber(r2 * 100, 1)}).${
              r1 > r2 * 1.2
                ? ` Autrement dit, ${B("la probabilité de trouver des militants potentiels parmi les électeurs insoumis y est plus forte")} que dans le reste du département.`
                : r1 < r2 * 0.8
                  ? ` ${B("Vivier militant comparativement faible")} : l'encadrement des nouveaux sympathisants est à prévoir.`
                  : ""
            }`,
            weight: 85,
          }),
        );
      }
    }

    // Abstention et scrutins intermédiaires.
    if (c22 && c24 && d22 && d24) {
      const ac24 = abstention(c24).pct;
      const ad24 = abstention(d24).pct;
      const dc = ac24 - abstention(c22).pct;
      const dd = ad24 - abstention(d22).pct;
      const lvl = gap(ac24, ad24, "%");
      abstMain = { c: ac24, d: ad24, dir: lvl.direction };
      const head = lvl.direction === "superieur" ? B("L'abstention est nettement plus élevée que dans le département") : lvl.direction === "inferieur" ? "L'abstention est plus faible que dans le département" : "L'abstention est proche de la moyenne départementale";
      ids.abst.push(
        addF({
          kind: lvl.direction === "superieur" ? "atout" : "constat",
          text: `${head} : ${pct(ac24)} aux européennes 2024 (département : ${pct(ad24)}). Elle progresse de ${fmtNumber(dc, 1)} points entre la présidentielle et les européennes, contre ${fmtNumber(dd, 1)} points dans le département.${lvl.direction === "superieur" ? ` On peut supposer une ${B("marge de progression chez les abstentionnistes")}.` : ""}`,
          evidence: [ind("abst_EU24", "commune"), ind("abst_EU24", "departement"), ind("abst_PR22T1", "commune")].filter(Boolean).map((i) => evidenceId(i!)),
          weight: 80,
        }),
      );
      if (dc > dd + 2)
        ids.abst.push(
          addF({
            kind: "hypothese",
            text: "La sur-abstention est plus marquée lors du scrutin intermédiaire : ce profil est souvent associé à une abstention intermittente plus forte chez les jeunes et les ménages modestes. Hypothèse à vérifier sur le terrain (listes d'émargement non exploitées).",
            evidence: [ind("abst_EU24", "commune"), ind("abst_PR22T1", "commune"), ind("abst_EU24", "departement"), ind("abst_PR22T1", "departement")].filter(Boolean).map((i) => evidenceId(i!)),
            weight: 60,
          }),
        );
    }

    // Forces politiques (sur/sous-performance relative au département).
    if (c24 && d24) {
      const perfAll = familyPerformance("EU24", c24, d24);
      for (const p of perfAll)
        for (const [g, v] of [[geos.commune, p.commune], [geos.departement, p.departement]] as const)
          out.indicators.push({ id: `vote_${p.family}_EU24_exp`, label: `Vote ${p.label} (européennes 2024) en % des exprimés`, theme: "strategie", value: v, unit: "%", year: "2024", geo: g, source: e24!.source, status: "ok" });
      const perf = perfAll.filter((p) => ["pcf", "ps", "eco", "rn", "lfi"].includes(p.family));
      const sur = perf.filter((p) => p.ratio >= 1.1);
      const sous = perf.filter((p) => p.ratio <= 0.9);
      if (sur.length || sous.length) {
        const part = (xs: typeof perf, verb: string) => `${joinFr(xs.map((p) => p.label))} ${verb}${xs.length > 1 ? "nt" : ""}`;
        const head = [sur.length ? part(sur, "surperforme") : "", sous.length ? part(sous, "sous-performe") : ""].filter(Boolean).join(" ; ");
        ids.partis.push(
          addF({
            kind: sur.some((p) => p.family === "lfi") ? "atout" : "constat",
            evidence: [...sur, ...sous].flatMap((p) => [`vote_${p.family}_EU24_exp@commune:${commune.code}`, `vote_${p.family}_EU24_exp@departement:${geos.departement.code}`]),
            text: `${B(cap(head))} par rapport au département (européennes 2024, % des exprimés) : ${[...sur, ...sous].map((p) => `${p.label} ${pct(p.commune)} contre ${pct(p.departement)}`).join(", ")}.`,
            weight: 55,
          }),
        );
      }
      out.tables.push({
        id: "lfi_partis",
        title: "Européennes 2024 — forces politiques comparées au département (% des exprimés)",
        theme: "strategie",
        columns: [
          { key: "famille", label: "Liste / famille" },
          { key: "commune", label: commune.nom, align: "right", unit: "%" },
          { key: "departement", label: depName, align: "right", unit: "%" },
          { key: "indice", label: "Indice (dép. = 100)", align: "right" },
        ],
        rows: perfAll.map((p) => ({ famille: p.label, commune: Math.round(p.commune * 10) / 10, departement: Math.round(p.departement * 10) / 10, indice: Math.round(p.ratio * 100) })),
        sources: [e24!.source],
      });
    }
  }

  /* ================================================================ 3. bureaux de vote */
  if (ranked.length && bvRef) {
    const second = bvSecond?.election.id === "PR22T1" && ranked.some((b) => b.lfi2PctIns != null) ? "P22" : "";
    const hasLabels = ranked.some((b) => labels.has(b.bv));
    out.tables.push({
      id: "lfi_bureaux",
      title: `Classement des bureaux de vote (${bvRef.election.label}${second ? " et présidentielle 2022" : ""})`,
      theme: "strategie",
      columns: [
        { key: "priorite", label: "Priorité", align: "right" },
        { key: "bv", label: "BV" },
        ...(hasLabels ? [{ key: "libelle", label: "Lieu de vote", wide: true }] : []),
        { key: "inscrits", label: "Inscrits", align: "right" },
        { key: "lfi", label: "LFI E24 (% inscrits)", align: "right", unit: "%" },
        { key: "lfiexp", label: "LFI E24 (% exprimés)", align: "right", unit: "%" },
        ...(second
          ? [
              { key: "lfi2", label: "Mélenchon P22 (% inscrits)", align: "right" as const, unit: "%" as const },
              { key: "lfi2exp", label: "Mélenchon P22 (% exprimés)", align: "right" as const, unit: "%" as const },
            ]
          : []),
        { key: "abst", label: "Abstention E24 (%)", align: "right", unit: "%" },
        { key: "abstn", label: "Abstentionnistes", align: "right" },
        ...(qMatch.length ? [{ key: "quartier", label: "Quartier" }] : []),
        { key: "type", label: "Profil" },
      ],
      rows: ranked.map((b) => ({
        priorite: b.priorite,
        bv: b.bv,
        libelle: labels.get(b.bv) ?? "",
        inscrits: b.inscrits,
        lfi: Math.round(b.lfiPctIns * 10) / 10,
        lfiexp: Math.round(b.lfiPctExp * 10) / 10,
        lfi2: b.lfi2PctIns != null ? Math.round(b.lfi2PctIns * 10) / 10 : null,
        lfi2exp: b.lfi2PctExp != null ? Math.round(b.lfi2PctExp * 10) / 10 : null,
        abst: Math.round(b.abstPct * 10) / 10,
        abstn: b.abstN,
        quartier: (() => {
          const q = quartierOf(b.bv);
          return q ? qName(q) : "";
        })(),
        type: BV_TYPE_LABELS[b.type],
      })),
      highlight: ranked.map((b, i) => (b.priorite === 1 ? i : -1)).filter((i) => i >= 0),
      sources: [bvRef.source, ...(c.bvGeo ? [c.bvGeo.source] : [])],
      note: `Priorité 1 : un quart des bureaux (quatre au plus), classés par potentiel = moyenne de deux scores z calculés entre les bureaux de la commune : réservoir (part LFI des exprimés aux européennes${second ? ", moyennée avec la part de J.-L. Mélenchon au 1er tour de la présidentielle 2022" : ""}) et marge de mobilisation (taux d'abstention aux européennes).${second ? " Présidentielle : bureaux appariés par numéro lorsque leurs inscrits varient de moins de 25 % (n.d. sinon)." : ""} Le découpage des bureaux peut avoir évolué depuis le scrutin.`,
    });
    out.charts.push({
      id: "lfi_chart_bureaux",
      title: `Vote LFI${second ? ", vote Mélenchon" : ""} et abstention par bureau de vote (% des inscrits)`,
      type: "bar",
      xKey: "bv",
      data: [...ranked]
        .sort((a, b) => Number(a.bv) - Number(b.bv) || a.bv.localeCompare(b.bv))
        .map((b) => ({ bv: `BV ${b.bv}`, lfi: Math.round(b.lfiPctIns * 10) / 10, ...(second ? { mel: b.lfi2PctIns != null ? Math.round(b.lfi2PctIns * 10) / 10 : null } : {}), abst: Math.round(b.abstPct * 10) / 10 })),
      series: [
        { key: "lfi", label: "LFI européennes 2024" },
        ...(second ? [{ key: "mel", label: "Mélenchon présidentielle 2022" }] : []),
        { key: "abst", label: "Abstention européennes 2024" },
      ],
      unit: "%",
      sources: [bvRef.source],
    });
    const bvGeoRef = (bv: string): GeoRef => ({ level: "bureau_vote", code: `${commune.code}-${bv}`, name: `${commune.nom} — BV ${bv}` });
    const bvInd = (b: BvRow, id: string, label: string, value: number) =>
      ({ id, label, theme: "strategie", value, unit: "%", year: bvRef.election.date.slice(0, 4), geo: bvGeoRef(b.bv), source: bvRef.source, status: "ok", denominator: b.inscrits }) as Indicator;
    for (const b of ranked) {
      out.indicators.push(bvInd(b, "lfi_bv_ins", `Vote LFI (${bvRef.election.label}) en % des inscrits`, b.lfiPctIns));
      out.indicators.push(bvInd(b, "lfi_bv_exp", `Vote LFI (${bvRef.election.label}) en % des exprimés`, b.lfiPctExp));
      out.indicators.push(bvInd(b, "abst_bv", `Abstention (${bvRef.election.label}) en % des inscrits`, b.abstPct));
      if (b.lfi2PctIns != null && bvSecond) out.indicators.push({ ...bvInd(b, "mel_bv_ins", "Vote J.-L. Mélenchon (présidentielle 2022, 1er tour) en % des inscrits", b.lfi2PctIns), year: "2022", source: bvSecond.source });
    }
    const bvEv = (rows: BvRow[], id = "lfi_bv_ins") => rows.map((b) => `${id}@bureau_vote:${commune.code}-${b.bv}`);
    const top = ranked.slice(0, Math.max(1, prio.length));
    const topVoix = top.reduce((s, b) => s + b.lfiVoix, 0);
    const allVoix = ranked.reduce((s, b) => s + b.lfiVoix, 0);
    const topIns = top.reduce((s, b) => s + b.inscrits, 0);
    const allIns = ranked.reduce((s, b) => s + b.inscrits, 0);
    ids.ou.push(
      addF({
        kind: "atout",
        evidence: [...bvEv(top), ...bvEv(top, "abst_bv")],
        text: `${B(`Les bureaux ${joinFr(top.map((b) => `${b.bv}${labels.has(b.bv) ? ` (${b.label})` : ""}`))}`)} rassemblent ${pct((100 * topIns) / (allIns || 1), 0)} des inscrits mais ${B(`${pct((100 * topVoix) / (allVoix || 1), 0)} des voix LFI`)} de la commune aux européennes (${fmtNumber(topVoix)} voix)${(() => {
          const t2 = top.reduce((s2, b) => s2 + (b.lfi2Voix ?? 0), 0);
          const a2 = ranked.reduce((s2, b) => s2 + (b.lfi2Voix ?? 0), 0);
          return second && a2 && top.every((b) => b.lfi2Voix != null) ? ` et ${pct((100 * t2) / a2, 0)} des voix Mélenchon en 2022 (${fmtNumber(t2)} voix)` : "";
        })()}, ainsi que ${fmtNumber(top.reduce((s, b) => s + b.abstN, 0))} abstentionnistes.`,
        weight: 95,
      }),
    );
    const best = [...ranked].sort((a, b) => b.lfiPctExp - a.lfiPctExp)[0];
    const worst = [...ranked].sort((a, b) => a.lfiPctExp - b.lfiPctExp)[0];
    if (best && worst && best !== worst)
      ids.ou.push(
        addF({
          kind: "constat",
          text: `Les scores se concentrent dans une partie de la commune : de ${pct(worst.lfiPctExp)} des exprimés au BV ${worst.bv}${labels.has(worst.bv) ? ` (${worst.label})` : ""} à ${pct(best.lfiPctExp)} au BV ${best.bv}${labels.has(best.bv) ? ` (${best.label})` : ""}.`,
          evidence: bvEv([worst, best], "lfi_bv_exp"),
          weight: 70,
        }),
      );

    // Cartes par bureau : contours si disponibles, sinon lieux de vote (points).
    const geo = c.bvGeo?.features ?? [];
    // Contours des quartiers prioritaires superposés aux bureaux.
    const qpvGeo = (c.quartiers?.qpv ?? []).filter((q) => q.geometry);
    const qpvLayers = qpvGeo.length
      ? [{ id: "qpv", label: "Quartiers prioritaires (QPV)", kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: qpvGeo.map((q) => ({ type: "Feature" as const, geometry: q.geometry!, properties: { nom: `QPV ${q.nom}` } })) }, color: "#111827", outlineOnly: true, visible: true, source: c.quartiers!.sources[0] }]
      : [];
    const pts = c.bvGeo?.points ?? [];
    if (!geo.length && pts.length) {
      const byBv = new Map(ranked.map((b) => [b.bv, b]));
      const lg = divergingLegend("Vote LFI (% des inscrits)", ranked.map((b) => b.lfiPctIns));
      const colorOf = (v: number | null) => (v == null ? MISSING_COLOR : (lg.classes!.find((k) => v <= k.max) ?? lg.classes![lg.classes!.length - 1])?.color ?? MISSING_COLOR);
      const features = pts.map((f) => {
        const b = byBv.get(String(f.properties?.bv));
        return { ...f, properties: { ...f.properties, name: `BV ${f.properties?.bv} — ${f.properties?.label} : LFI ${b ? pct(b.lfiPctIns) : "n.d."} des inscrits, abstention ${b ? pct(b.abstPct) : "n.d."}`, color: colorOf(b ? b.lfiPctIns : null) } };
      });
      const contour = commune.contour ? [{ type: "Feature" as const, geometry: commune.contour, properties: { nom: commune.nom } }] : [];
      const all = turf.featureCollection([...features, ...contour] as GeoJSON.Feature[]);
      out.maps.push({
        id: "lfi_map_bv",
        title: `Lieux de vote selon le vote LFI (${bvRef.election.label}, % des inscrits)`,
        theme: "strategie",
        bbox: turf.bbox(turf.buffer(all, 0.3, { units: "kilometers" })!) as [number, number, number, number],
        layers: [
          ...(contour.length ? [{ id: "contour", label: `Limite communale de ${commune.nom}`, kind: "polygons" as const, data: { type: "FeatureCollection" as const, features: contour }, color: "#374151", outlineOnly: true, visible: true, source: c.geoSource ?? c.bvGeo!.source }] : []),
          ...qpvLayers,
          { id: "lieux", label: "Lieux de vote", kind: "points", data: { type: "FeatureCollection", features }, visible: true, source: c.bvGeo!.source },
        ],
        legend: { title: lg.title, unit: "%", categories: lg.classes!.map((k) => ({ label: `${fmtNumber(k.min, 1)} – ${fmtNumber(k.max, 1)} %`, color: k.color })) },
        note: "Contours des bureaux non disponibles : chaque point est le lieu de vote (adresse du Répertoire électoral unique géocodée par la Base adresse nationale).",
      });
    }
    if (geo.length) {
      const byBv = new Map(ranked.map((b) => [b.bv, b]));
      const fc = (prop: (b: BvRow) => number | null): GeoJSON.FeatureCollection => ({
        type: "FeatureCollection",
        features: geo.map((f) => {
          const b = byBv.get(String(f.properties?.bv));
          const v = b ? prop(b) : null;
          return { ...turf.truncate(f, { precision: 5 }), properties: { ...f.properties, nom: `BV ${f.properties?.bv}${labels.has(String(f.properties?.bv)) ? ` — ${labels.get(String(f.properties?.bv))}` : ""}`, valeur: v != null ? Math.round(v * 10) / 10 : null } };
        }),
      });
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
        layers: [{ id: "bv", label: "Vote LFI (% inscrits)", kind: "polygons", data: fc((b) => b.lfiPctIns), valueProperty: "valeur", visible: true, source: src }, ...qpvLayers],
        legend: divergingLegend("Vote LFI (% des inscrits)", ranked.map((b) => b.lfiPctIns)),
        note: [approx, qpvLayers.length ? "Trait noir : contours des quartiers prioritaires." : ""].filter(Boolean).join(" "),
      });
      out.maps.push({
        id: "lfi_map_bv_participation",
        group: "lfi_bv",
        period: "Participation",
        title: `Participation par bureau de vote (${bvRef.election.label}, % des inscrits)`,
        theme: "strategie",
        bbox,
        layers: [{ id: "bv", label: "Participation (%)", kind: "polygons", data: fc((b) => 100 - b.abstPct), valueProperty: "valeur", visible: true, source: src }, ...qpvLayers],
        legend: divergingLegend("Participation (% des inscrits)", ranked.map((b) => 100 - b.abstPct)),
        note: approx,
      });
      // Présidentielle 2022 : vote Mélenchon et participation (bureaux appariés).
      const p22 = ranked.filter((b) => b.lfi2PctIns != null);
      if (bvSecond && p22.length >= Math.max(2, ranked.length / 2)) {
        const note22 = [approx, "Bureaux de 2022 appariés par numéro aux contours actuels (inscrits à ±25 %) ; gris : bureau non apparié."].filter(Boolean).join(" ");
        out.maps.push({
          id: "lfi_map_bv_p22",
          group: "lfi_bv_p22",
          period: "Vote Mélenchon",
          title: "Vote Mélenchon par bureau de vote (présidentielle 2022, 1er tour, % des inscrits)",
          theme: "strategie",
          bbox,
          layers: [{ id: "bv", label: "Vote Mélenchon (% inscrits)", kind: "polygons", data: fc((b) => b.lfi2PctIns), valueProperty: "valeur", visible: true, source: bvSecond.source }, ...qpvLayers],
          legend: divergingLegend("Vote Mélenchon (% des inscrits)", p22.map((b) => b.lfi2PctIns!)),
          note: note22,
        });
        out.maps.push({
          id: "lfi_map_bv_p22_participation",
          group: "lfi_bv_p22",
          period: "Participation",
          title: "Participation par bureau de vote (présidentielle 2022, 1er tour, % des inscrits)",
          theme: "strategie",
          bbox,
          layers: [{ id: "bv", label: "Participation (%)", kind: "polygons", data: fc((b) => (b.abst2Pct != null ? 100 - b.abst2Pct : null)), valueProperty: "valeur", visible: true, source: bvSecond.source }, ...qpvLayers],
          legend: divergingLegend("Participation (% des inscrits)", p22.filter((b) => b.abst2Pct != null).map((b) => 100 - b.abst2Pct!)),
          note: note22,
        });
      }
    }
  }

  /* ================================================================ 3 bis. quartiers */
  const ids2 = { quartiers: [] as string[] };
  if (qAll.length) {
    const comPov = get("taux_pauvrete", geos.commune)?.value ?? null;
    const lfiCom = c24 ? score("EU24", c24, "lfi")?.pctInscrits ?? null : null;
    const byBv = new Map(ranked.map((b) => [b.bv, b]));
    const lfiOfBvs = (bvs: string[]) => {
      const rows = bvs.map((b) => byBv.get(b)).filter((x): x is BvRow => !!x);
      const ins = rows.reduce((s2, b) => s2 + b.inscrits, 0);
      return ins ? { pct: (100 * rows.reduce((s2, b) => s2 + b.lfiVoix, 0)) / ins, ins } : null;
    };
    // Vote Mélenchon 2022 des bureaux appariés du quartier (moyenne pondérée par les inscrits).
    const melOfBvs = (bvs: string[]) => {
      const rows = bvs.map((b) => byBv.get(b)).filter((x): x is BvRow => !!x && x.lfi2PctIns != null);
      const ins = rows.reduce((s2, b) => s2 + b.inscrits, 0);
      return ins && rows.length === bvs.length ? rows.reduce((s2, b) => s2 + b.lfi2PctIns! * b.inscrits, 0) / ins : null;
    };
    const melCom = c22 ? (score("PR22T1", c22, "lfi")?.pctInscrits ?? null) : null;
    const iris = (c.quartiers?.iris ?? []).filter((q) => q.type !== "A" && q.type !== "D");
    const irisShown = [...iris].sort((a, b) => (b.stats.pauvrete ?? -1) - (a.stats.pauvrete ?? -1)).slice(0, 8);
    const shown = [...(c.quartiers?.qpv ?? []), ...irisShown];
    const qSrc = c.quartiers!.sources;
    const qGeo = (q: Quartier): GeoRef => ({ level: "quartier", code: `${q.kind}:${q.code}`, name: qName(q) });
    const qInd = (q: Quartier, id: string, label: string, value: number, unit: "%" | "€") =>
      ({ id, label, theme: "strategie", value, unit, geo: qGeo(q), source: (q.kind === "qpv" ? qSrc.find((x) => x.id === "insee_qpv") : qSrc.find((x) => x.id === "iris")) ?? qSrc[0], status: "ok" }) as Indicator;
    for (const q of shown) {
      if (q.stats.pauvrete != null) out.indicators.push(qInd(q, "taux_pauvrete_quartier", "Taux de pauvreté du quartier", q.stats.pauvrete, "%"));
      if (q.stats.revenu != null) out.indicators.push(qInd(q, "revenu_median_quartier", "Revenu médian du quartier", q.stats.revenu, "€"));
    }
    const jeunesLabels = [...new Set(shown.map((q) => q.stats.jeunesLabel).filter(Boolean))];
    const cRow = rowFor(geos.commune);
    out.tables.push({
      id: "lfi_quartiers",
      title: "Profil des quartiers",
      theme: "strategie",
      columns: [
        { key: "nom", label: "", wide: true },
        { key: "revenu", label: "Revenu médian", align: "right" },
        { key: "pauvrete", label: "Taux de pauvreté", align: "right" },
        { key: "jeunes", label: jeunesLabels.length === 1 ? cap(jeunesLabels[0]!) : "Jeunes*", align: "right" },
        { key: "ages", label: "60 ans et +", align: "right" },
        { key: "chomage", label: "Taux de chômage", align: "right" },
        { key: "locataires", label: "Locataires (dont HLM)", align: "right" },
        ...(qMatch.length
          ? [
              { key: "bv", label: "Bureaux de vote" },
              { key: "lfi", label: "LFI E24 (% inscrits)", align: "right" as const },
              ...(melCom != null ? [{ key: "mel", label: "Mélenchon P22 (% inscrits)", align: "right" as const }] : []),
            ]
          : []),
      ],
      rows: [
        ...shown.map((q) => {
          const bvs = qBureaux.get(q.code) ?? [];
          const l = lfiOfBvs(bvs);
          return {
            nom: q.kind === "qpv" ? `**${q.nom}** (QPV)` : `${q.nom} (IRIS)`,
            revenu: q.stats.revenu != null ? fmtValue(q.stats.revenu, "€") : "n.d.",
            pauvrete: pct(q.stats.pauvrete, 0),
            jeunes: pct(q.stats.jeunes, 0),
            ages: pct(q.stats.ages, 0),
            chomage: pct(q.stats.chomage, 0),
            locataires: q.stats.locataires != null ? `${pct(q.stats.locataires, 0)}${q.stats.hlm != null ? ` (${pct(q.stats.hlm, 0)})` : ""}` : "n.d.",
            bv: bvs.length ? bvs.join(", ") : "",
            lfi: l ? pct(l.pct) : "",
            mel: bvs.length && melOfBvs(bvs) != null ? pct(melOfBvs(bvs)) : "",
          };
        }),
        { nom: `**${commune.nom} (total)**`, revenu: cRow.revenu, pauvrete: cRow.pauvrete, jeunes: cRow.jeunes, ages: "n.d.", chomage: cRow.chomage, locataires: cRow.locataires, bv: "", lfi: lfiCom != null ? pct(lfiCom) : "", mel: melCom != null ? pct(melCom) : "" },
      ],
      highlight: shown.map((q, i) => (q.kind === "qpv" ? i : -1)).filter((i) => i >= 0),
      sources: qSrc,
      note: `QPV : quartiers prioritaires de la politique de la ville (géographie 2024, indicateurs Filosofi 2021 et estimations 2022) ; IRIS : quartiers statistiques de l'INSEE (recensement et Filosofi 2021)${iris.length > irisShown.length ? `, ${irisShown.length} IRIS d'habitat les plus pauvres sur ${iris.length}` : ""}. Bureaux de vote : bureaux dont au moins 30 % de la surface est dans le quartier (contours approximatifs). Commune : chômage au sens du recensement, part des moins de 25 ans.${jeunesLabels.length > 1 ? " *Moins de 25 ans pour les QPV, moins de 30 ans pour les IRIS." : ""}`,
    });
    // Quartier le plus pauvre.
    const poorest = shown.filter((q) => q.stats.pauvrete != null).sort((a, b) => b.stats.pauvrete! - a.stats.pauvrete!)[0];
    if (poorest && comPov != null && poorest.stats.pauvrete! >= comPov + 8)
      ids2.quartiers.push(
        addF({
          kind: "constat",
          text: `${B(`${cap(quartierLabel(poorest.nom))} concentre la pauvreté`)} : taux de pauvreté de ${pct(poorest.stats.pauvrete, 0)}, contre ${pct(comPov, 0)} dans l'ensemble de la commune${poorest.stats.revenu != null ? ` (revenu médian ${fmtValue(poorest.stats.revenu, "€")})` : ""}.`,
          evidence: [`taux_pauvrete_quartier@quartier:${poorest.kind}:${poorest.code}`, ...(get("taux_pauvrete", geos.commune) ? [evidenceId(get("taux_pauvrete", geos.commune)!)] : [])],
          weight: 88,
        }),
      );
    // Vote LFI par quartier (bureaux rattachés).
    for (const q of shown) {
      const bvs = qBureaux.get(q.code) ?? [];
      const l = lfiOfBvs(bvs);
      if (lfiCom == null) continue;
      const poor = q.stats.pauvrete != null && comPov != null && q.stats.pauvrete >= comPov + 5;
      if (l) {
        const g = gap(l.pct, lfiCom, "%");
        out.indicators.push({ ...qInd(q, "lfi_quartier_ins", "Vote LFI (E24) des bureaux du quartier, en % des inscrits", l.pct, "%"), source: bvRef!.source });
        const ev = [`lfi_quartier_ins@quartier:${q.kind}:${q.code}`, ...out.indicators.filter((i) => i.id === "lfi_EU24_ins" && i.geo.level === "commune").map(evidenceId)];
        if (g.direction === "superieur")
          ids2.quartiers.push(addF({ kind: "atout", text: `${B(`LFI surperforme dans ${q.kind === "qpv" ? "le quartier prioritaire de " : ""}${quartierLabel(q.nom)}`)} (${bvList(bvs)}) : ${pct(l.pct)} des inscrits aux européennes 2024, contre ${pct(lfiCom)} dans la commune${melOfBvs(bvs) != null && melCom != null ? ` ; J.-L. Mélenchon y avait réuni ${pct(melOfBvs(bvs))} des inscrits en 2022 (commune : ${pct(melCom)})` : ""}.`, evidence: ev, weight: 93 }));
        else if (poor)
          ids2.quartiers.push(addF({ kind: "hypothese", text: `LFI ne surperforme pas dans ${quartierLabel(q.nom)} (${bvList(bvs)} : ${pct(l.pct)} des inscrits contre ${pct(lfiCom)}), alors qu'au regard de ses données sociodémographiques ce quartier devrait nous être favorable : marge de progression probable (non-inscription, abstention).`, evidence: ev, weight: 72 }));
      } else if (poor && q.kind === "qpv")
        ids2.quartiers.push(addF({ kind: "hypothese", text: `Le quartier prioritaire ${quartierLabel(q.nom)} ne peut pas être isolé par les bureaux de vote (découpé entre plusieurs bureaux) ; au regard de ses données sociodémographiques, il devrait nous être favorable.`, evidence: [`taux_pauvrete_quartier@quartier:${q.kind}:${q.code}`], weight: 60 }));
    }
  }

  /* ================================================================ 4. pourquoi (hypothèses) */
  const povI = get("taux_pauvrete", geos.commune);
  const povDep = get("taux_pauvrete", geos.departement);
  const youngI = get("part_moins_25", geos.commune);
  const youngDep = get("part_moins_25", geos.departement);
  const hlmI = get("part_locataires_hlm", geos.commune);
  const hlmDep = get("part_locataires_hlm", geos.departement);
  const reasons: string[] = [];
  const ev: Indicator[] = [];
  if (povI && povDep && gap(povI.value!, povDep.value!, "%").direction === "superieur") {
    reasons.push(`un taux de pauvreté élevé (${pct(povI.value)} contre ${pct(povDep.value)})`);
    ev.push(povI, povDep);
  }
  if (youngI && youngDep && gap(youngI.value!, youngDep.value!, "%").direction === "superieur") {
    reasons.push(`une population jeune (${pct(youngI.value)} de moins de 25 ans contre ${pct(youngDep.value)})`);
    ev.push(youngI, youngDep);
  }
  if (hlmI && hlmDep && gap(hlmI.value!, hlmDep.value!, "%").direction === "superieur") {
    reasons.push(`un parc HLM important (${pct(hlmI.value)} des ménages contre ${pct(hlmDep.value)})`);
    ev.push(hlmI, hlmDep);
  }
  if (reasons.length)
    ids.hyp.push(
      addF({
        kind: "hypothese",
        text: `La commune combine ${joinFr(reasons)}. Ces caractéristiques sont, à l'échelle nationale, associées à un vote LFI plus élevé mais aussi à une abstention plus forte : elles pourraient expliquer à la fois le potentiel et la marge de mobilisation. Corrélation territoriale, pas causalité : à confirmer par la connaissance du terrain.`,
        evidence: ev.map(evidenceId),
        weight: 75,
      }),
    );
  if (ranked.length >= 3) {
    const sorted = [...ranked].sort((x, y) => y.lfiPctExp - x.lfiPctExp);
    const spread = sorted[0].lfiPctExp - sorted[sorted.length - 1].lfiPctExp;
    if (spread >= 10)
      ids.hyp.push(
        addF({
          kind: "hypothese",
          text: `Les écarts entre bureaux (${fmtNumber(spread, 1)} points de part LFI des exprimés entre le BV ${sorted[0].bv} et le BV ${sorted[sorted.length - 1].bv}) reflètent probablement des différences de composition sociale entre quartiers (habitat social, population étudiante, âge). À confirmer par les données infracommunales (IRIS, quartiers prioritaires) et la connaissance du terrain.`,
          evidence: [`lfi_bv_exp@bureau_vote:${commune.code}-${sorted[0].bv}`, `lfi_bv_exp@bureau_vote:${commune.code}-${sorted[sorted.length - 1].bv}`],
          weight: 65,
        }),
      );
  }
  if (!reasons.length && perfMain?.dir === "superieur")
    ids.hyp.push(
      addF({
        kind: "hypothese",
        text: "La surperformance LFI ne s'explique pas par les indicateurs sociodémographiques communaux disponibles (revenus, âge, logement social proches de la moyenne) : d'autres facteurs pourraient jouer (implantation militante, quartiers spécifiques, électorat néo-résident). À confirmer avec les retours de terrain.",
        evidence: out.indicators.filter((i) => i.id === "lfi_EU24_ins").map(evidenceId),
        weight: 60,
      }),
    );

  /* ================================================================ 5. comment : lieux d'action */
  const centroids = new Map<string, [number, number]>();
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
  // Supermarchés : BPE (INSEE) si disponible, plus complète que OpenStreetMap.
  const singular = (t: string) => (t === "A128" ? "France Services" : BPE_TYPES[t].label.replace(/s$/, "")).replace(/^Bureaux/, "Bureau").replace(/^Agences/, "Agence").replace(/^Hypermarché$/, "Hypermarché").replace(/^Supermarché$/, "Supermarché");
  const bpeName = (e: { nom: string; type: string; adresse: string }) => (e.nom ? `${e.nom}${e.adresse ? ` (${e.adresse})` : ""}` : `${singular(e.type)}${e.adresse ? `, ${e.adresse}` : ""}`);
  if (c.bpe) for (const e of c.bpe.commune.filter((e) => e.type === "B105" || e.type === "B104")) pushLieu("Supermarché", bpeName(e), e.type === "B104" ? "hypermarché" : "", e.lon, e.lat);
  for (const e of c.bpe?.commune.filter((e) => ["A122", "A128", "A206"].includes(e.type)) ?? []) pushLieu("Service public", bpeName(e), singular(e.type), e.lon, e.lat);
  for (const f of c.bpe ? [] : eq.filter((f) => f.properties?.category === "alimentaire" && (f.properties?.shop === "supermarket" || f.properties?.shop == null))) {
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
  if (centroids.size && prioSet.size) {
    const keep = lieux.filter((l) => l.prioritaire || l.type === "Marché" || l.type === "Gare" || l.type === "Service public");
    lieux.length = 0;
    lieux.push(...keep);
  }
  if (lieux.length) {
    const order = ["Marché", "Gare", "Supermarché", "Service public", "Sortie de collège", "Sortie de lycée"];
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

  // Actions recommandées, regroupées par type de lieu (comme dans les fiches de référence).
  const groupes = c.interne.groupes.filter((g) => g.code === commune.code || (commune.epci && referentiel().epcis.find((e) => e.code === commune.epci!.code)?.membres.some((m) => m.code === g.code)));
  const actionGroups: { title: string; hint?: string; items: string[] }[] = [];
  const nearSchools = (bv: string) =>
    (c.schools?.schools ?? [])
      .filter((s) => s.lon != null && centroids.has(bv))
      .map((s) => ({ s, d: haversineKm([s.lon!, s.lat!], centroids.get(bv)!) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map((x) => x.s.nom);
  if (prio.length) {
    actionGroups.push({
      title: "Porte-à-porte",
      hint: "priorité",
      items: prio.map((p) => {
        const adr = c.bvGeo?.points.find((f) => String(f.properties?.bv) === p.bv)?.properties?.adresse as string | undefined;
        const ns = nearSchools(p.bv);
        const where = adr ? `lieu de vote : ${adr}` : ns.length ? `repères : ${ns.join(", ")}` : "";
        const q = quartierOf(p.bv);
        return `${B(`BV ${p.bv}${labels.has(p.bv) ? ` — ${p.label}` : ""}`)}${q ? ` (${qName(q)})` : ""} : LFI ${pct(p.lfiPctIns)} des inscrits aux européennes${p.lfi2PctIns != null ? `, Mélenchon ${pct(p.lfi2PctIns)} en 2022` : ""} ; abstention ${pct(p.abstPct, 0)} (${fmtNumber(p.abstN)} abstentionnistes)${where ? ` ; ${where}` : ""}.`;
      }),
    });
    const reservoir = ranked.filter((b) => b.type === "reservoir_abstention" || b.type === "bastion_a_mobiliser").filter((b) => !prioSet.has(b.bv)).slice(0, 3);
    const abstItems = [`Inscription sur les listes électorales et mobilisation des abstentionnistes dans les bureaux prioritaires${abstMain?.dir === "superieur" ? ", où la marge de progression est la plus forte" : ""}.`];
    if (reservoir.length) abstItems.push(`Bureaux à abstention forte à couvrir ensuite : ${joinFr(reservoir.map((b) => `BV ${b.bv} (${pct(b.abstPct, 0)})`))}.`);
    actionGroups.push({ title: "Abstentionnistes et inscription", items: abstItems });
  }
  const markets = lieux.filter((l) => l.type === "Marché");
  if (markets.length) actionGroups.push({ title: "Marchés", items: markets.slice(0, 5).map((m) => `${B(m.nom)} : ${m.infos}${m.bv ? ` (${m.bv}${m.prioritaire ? ", prioritaire" : ""})` : ""}.`) });
  else if ((commune.population ?? 0) >= 2000) actionGroups.push({ title: "Marchés", items: ["Aucun marché recensé dans OpenStreetMap : jours, horaires et emplacements à demander à la mairie ou aux militants locaux."] });
  const gares = lieux.filter((l) => l.type === "Gare");
  const tt = (nom: string) => c.timetables?.stations.find((s) => s.nom === nom);
  if (gares.length)
    actionGroups.push({
      title: gares.length > 1 ? "Gares" : "Gare",
      items: [
        ...gares.map((g) => {
          const t = tt(g.nom);
          if (!t || !t.departs) return `${B(g.nom)} : ${g.infos}.`;
          const freq = t.departs >= 30 ? `un train toutes les ~${Math.max(5, Math.round((16 * 60) / t.departs / 5) * 5)} minutes en moyenne` : `${t.departs} passages un jour de semaine`;
          const pointe = t.pointe ? `, priorité entre ${t.pointe[0]} h et ${t.pointe[1]} h (${t.parHeure[t.pointe[0]] + t.parHeure[t.pointe[0] + 1]} passages)` : "";
          return `${B(g.nom)} : ${g.infos} ; ${freq}${pointe}${t.paris ? ` ; Paris en ${fmtDuration(t.paris.minMinutes)} (trajets directs)` : ""}.`;
        }),
        ...(gares.some((g) => tt(g.nom)?.departs) ? [] : ["Privilégier les heures de pointe (7 h-9 h, 17 h-19 h), à confirmer avec les fiches horaires TER."]),
      ],
    });
  const sup = lieux.filter((l) => l.type === "Supermarché");
  if (sup.length) actionGroups.push({ title: "Supermarchés", items: sup.slice(0, 5).map((s) => `${B(s.nom)}${s.infos ? ` : ${s.infos}` : ""}${s.bv ? ` (${s.bv})` : ""}.`) });
  const services = lieux.filter((l) => l.type === "Service public");
  if (services.length) actionGroups.push({ title: "Services publics", hint: "files d'attente, permanences", items: services.slice(0, 4).map((s) => `${B(s.nom)} (${s.infos}${s.bv ? `, ${s.bv}` : ""}).`) });
  const ecoles = lieux.filter((l) => l.type.startsWith("Sortie"));
  if (ecoles.length) actionGroups.push({ title: "Sorties de collèges et lycées", hint: "parents, jeunes", items: ecoles.slice(0, 4).map((s) => `${B(s.nom)}${s.infos ? ` (${s.infos})` : ""}.`) });
  const implant: string[] = [];
  if (interneFourni && !groupes.length) implant.push("Aucun groupe d'action référencé : envisager la création d'un groupe local, encadré par un groupe voisin actif.");
  if (parrainsRatio && parrainsRatio.r1 < parrainsRatio.r2 * 0.8) implant.push("Prévoir l'encadrement des nouveaux sympathisants : un futur groupe serait majoritairement composé de personnes n'ayant pas encore parrainé.");
  if (implant.length) actionGroups.push({ title: "Implantation", items: implant });
  // Constats « piste » (traçabilité, synthèse du rapport complet).
  for (const g of actionGroups) addF({ kind: "piste", text: `${g.title} : ${g.items.join(" ")}`.replace(/\*\*/g, ""), evidence: [], weight: 70 });

  /* ================================================================ accessibilité */
  const access: string[] = [];
  if (c.stations?.stations.length) {
    const s = c.stations.stations;
    const names = s.map((x) => (/^gare\b/i.test(x.nom) ? x.nom : `gare de ${x.nom}`));
    access.push(joinFr(names));
  }
  const trainParis = c.timetables?.stations.map((s) => s.paris?.minMinutes).filter((x): x is number => x != null).sort((a, b) => a - b)[0];
  const road = (label: string) => c.routes?.routes.find((r) => r.label === label);
  const rPole = road("Pôle urbain le plus proche");
  const rParis = road("Paris");
  if (rPole) access.push(`${rPole.nom} à ${fmtDuration(rPole.minutes)} en voiture`);
  else if (nearestBig) access.push(`${nearestBig.nom} à ${fmtValue(nearestBig.distanceKm, "km")}`);
  for (const lab of ["Grande ville la plus proche", "Préfecture"]) {
    const r = road(lab);
    if (r) access.push(`${r.nom}${lab === "Préfecture" ? " (préfecture)" : ""} à ${fmtDuration(r.minutes)}`);
  }
  if (trainParis != null || rParis) access.push(`Paris à ${[trainParis != null ? `${fmtDuration(trainParis)} en train direct` : "", rParis ? `${fmtDuration(rParis.minutes)} en voiture` : ""].filter(Boolean).join(", ")}`);
  else if (c.parisKm != null) access.push(`Paris à ${fmtValue(c.parisKm, "km")}`);
  const cy = get("km_amenagements_cyclables", geos.commune);
  if (cy) access.push(`${fmtValue(cy.value, "km")} d'aménagements cyclables`);

  /* ================================================================ en bref */
  const glance: Extract<Block, { type: "glance" }>["items"] = [];
  const tone = (dir?: string) => (dir === "superieur" ? "up" : dir === "inferieur" ? "down" : "neutral") as "up" | "down" | "neutral";
  if (pop) glance.push({ label: "Habitants", value: fmtNumber(Math.round(pop.value! / 100) * 100), detail: evol ? `${fmtSigned(evol.value!, "%", 1)} par an` : undefined });
  if (pov) glance.push({ label: "Taux de pauvreté", value: pov.va, detail: `département : ${pov.vb}`, tone: tone(pov.dir) });
  else if (rev) glance.push({ label: "Revenu médian", value: rev.va, detail: `département : ${rev.vb}`, tone: tone(rev.dir) });
  const l24 = c24 ? score("EU24", c24, "lfi") : null;
  const dl24 = d24 ? score("EU24", d24, "lfi") : null;
  const m22 = c22 ? score("PR22T1", c22, "lfi") : null;
  const dm22 = d22 ? score("PR22T1", d22, "lfi") : null;
  // Tonalité sur la part des exprimés (comparable entre scrutins de participation différente).
  if (l24) glance.push({ label: "Vote LFI (européennes 2024)", value: pct(l24.pctExprimes), detail: `des exprimés · dép. ${pct(dl24?.pctExprimes)} · ${pct(l24.pctInscrits)} des inscrits`, tone: dl24 ? tone(gap(l24.pctExprimes, dl24.pctExprimes, "%").direction) : "neutral" });
  if (m22) glance.push({ label: "Vote Mélenchon (présidentielle 2022)", value: pct(m22.pctExprimes), detail: `des exprimés · dép. ${pct(dm22?.pctExprimes)} · ${pct(m22.pctInscrits)} des inscrits`, tone: dm22 ? tone(gap(m22.pctExprimes, dm22.pctExprimes, "%").direction) : "neutral" });
  if (abstMain) glance.push({ label: "Abstention (E24)", value: pct(abstMain.c), detail: `département : ${pct(abstMain.d)}`, tone: tone(abstMain.dir) });
  if (parrainsRatio) glance.push({ label: "Parrains / 100 voix LFI", value: fmtNumber(parrainsRatio.r1 * 100, 1), detail: `département : ${fmtNumber(parrainsRatio.r2 * 100, 1)}`, tone: parrainsRatio.r1 > parrainsRatio.r2 * 1.2 ? "up" : parrainsRatio.r1 < parrainsRatio.r2 * 0.8 ? "down" : "neutral" });
  if (ranked.length) glance.push({ label: "Bureaux de vote", value: String(ranked.length), detail: prio.length ? `prioritaires : ${prio.map((p) => p.bv).join(", ")}` : undefined });

  const synth: Item[] = [];
  const lfiStrong = !!(l24 && dl24 && l24.pctExprimes >= dl24.pctExprimes * 1.2);
  const melStrong = !!(m22 && dm22 && m22.pctExprimes >= dm22.pctExprimes * 1.1);
  const voteStrong =
    lfiStrong || melStrong
      ? `vote insoumis au-dessus du département : ${[l24 && dl24 ? `${pct(l24.pctExprimes)} des exprimés pour LFI aux européennes 2024 (département : ${pct(dl24.pctExprimes)})` : "", m22 && dm22 ? `${pct(m22.pctExprimes)} pour J.-L. Mélenchon à la présidentielle 2022 (département : ${pct(dm22.pctExprimes)})` : ""].filter(Boolean).join(", ")}`
      : "";
  const atout =
    perfMain?.dir === "superieur"
      ? `LFI surperforme par rapport aux communes comparables (${pct(perfMain.commune)} des inscrits contre ${pct(perfMain.median)} aux ${perfMain.name})${voteStrong ? ` ; ${voteStrong}` : ""}`
      : voteStrong
        ? voteStrong
        : parrainsRatio && parrainsRatio.r1 > parrainsRatio.r2 * 1.2
        ? "vivier militant plus dense que dans le reste du département (ratio parrains / voix LFI élevé)"
        : abstMain?.dir === "superieur"
          ? `réservoir d'abstentionnistes (${pct(abstMain.c)} d'abstention aux européennes, département : ${pct(abstMain.d)})`
          : groupes.length
            ? "un groupe d'action déjà implanté"
            : "";
  if (atout) synth.push({ text: `${B("Atout principal")} : ${atout}.` });
  if (abstMain?.dir === "superieur" && !/abstentionnistes/.test(atout))
    synth.push({ text: `${B("Marge de progression")} : abstention de ${pct(abstMain.c)} aux européennes (département : ${pct(abstMain.d)})${c22 && d22 ? `, ${pct(abstention(c22).pct)} à la présidentielle (département : ${pct(abstention(d22).pct)})` : ""}.` });
  const diff =
    parrainsRatio && parrainsRatio.r1 < parrainsRatio.r2 * 0.8
      ? "très peu de parrains au regard du vote LFI : l'encadrement de nouveaux militants est la question centrale"
      : perfMain?.dir === "inferieur"
        ? `LFI sous-performe par rapport aux communes comparables (${pct(perfMain.commune)} des inscrits contre ${pct(perfMain.median)})`
        : interneFourni && !groupes.length
          ? "aucun groupe d'action référencé sur la commune et son intercommunalité"
          : lfiVoix24 != null && lfiVoix24 < 150
            ? `faible volume de voix (${fmtNumber(lfiVoix24)} voix LFI aux européennes) : soutiens dispersés`
            : "";
  if (diff) synth.push({ text: `${B("Difficulté principale")} : ${diff}.` });
  if (prio.length) synth.push({ text: `${B("Où agir en priorité")} : ${joinFr(prio.map((p) => `BV ${p.bv}${labels.has(p.bv) ? ` (${p.label})` : ""}`))}.` });
  const leviers = [
    markets.length ? `${markets.length > 1 ? `${markets.length} marchés` : "le marché"}` : "",
    gares.length ? `${gares.length > 1 ? "les gares" : "la gare"}${gares[0].infos.includes("voyageurs") ? ` (${gares[0].infos})` : ""}` : "",
    sup.length ? `${sup.length > 1 ? `${sup.length} supermarchés` : "le supermarché"}` : "",
    services.length ? "services publics (France Travail, poste, France Services)" : "",
    ecoles.length ? "sorties de collèges et lycées" : "",
  ].filter(Boolean);
  if (leviers.length) synth.push({ text: `${B("Lieux de passage")} : ${joinFr(leviers)}.` });

  /* ================================================================ contexte municipal */
  let municipalText = "";
  const m = c.municipal;
  if (m) {
    const nu = (code: string) => NUANCES[code] ?? code;
    const maj = m.majorite;
    const t1 = m.rounds.find((r) => r.tour === 1);
    const t2 = m.rounds.find((r) => r.tour === 2);
    const majT1 = maj && t1 ? t1.listes.find((l) => l.tete === maj.tete) : null;
    const parts: string[] = [];
    if (maj) {
      const fam = nuanceFamily(maj.nuance);
      parts.push(
        `${B(`La commune est dirigée par ${m.maire ? `${m.maire.prenom} ${m.maire.nom}` : maj.tete}`)}${maj.nuance ? ` (${nu(maj.nuance)}${fam === "gauche" ? ", mairie de gauche" : ""})` : ""} : sa liste « ${maj.libelle} » a obtenu ${majT1 ? `${pct(majT1.pctExprimes, 0)} des exprimés au 1er tour des municipales 2026${t2 ? "" : " (élection dès le 1er tour)"}` : "la majorité en 2026"}${t2 && t2.listes.find((l) => l.tete === maj.tete) ? ` et ${pct(t2.listes.find((l) => l.tete === maj.tete)!.pctExprimes, 0)} au 2nd tour` : ""}.`,
      );
      const last = t2 ?? t1;
      const left = last?.listes.filter((l) => l !== maj && l.tete !== maj.tete && nuanceFamily(l.nuance) === "gauche") ?? [];
      if (left.length && nuanceFamily(maj.nuance) !== "gauche")
        parts.push(`Liste${left.length > 1 ? "s" : ""} de gauche battue${left.length > 1 ? "s" : ""} : ${left.map((l) => `« ${l.libelle} » (${nu(l.nuance)}, ${pct(l.pctExprimes, 0)})`).join(", ")}.`);
      if (!last?.listes.some((l) => nuanceFamily(l.nuance) === "gauche")) parts.push("Aucune liste de gauche au tour décisif.");
      if (last && last.listes.length === 1) parts.push("Liste unique : élection sans opposition.");
    } else if (m.maire) parts.push(`Maire : ${B(`${m.maire.prenom} ${m.maire.nom}`)} (commune sans scrutin de liste).`);
    municipalText = parts.join(" ");
    if (m.rounds.some((r) => r.listes.length)) {
      const allTetes = [...new Set(m.rounds.flatMap((r) => r.listes.map((l) => l.tete)))];
      out.tables.push({
        id: "lfi_municipales",
        title: "Élections municipales 2026",
        theme: "strategie",
        columns: [
          { key: "liste", label: "Liste (tête de liste)", wide: true },
          { key: "nuance", label: "Nuance" },
          { key: "t1", label: "1er tour (% exprimés)", align: "right" },
          ...(t2 ? [{ key: "t2", label: "2nd tour (% exprimés)", align: "right" as const }] : []),
          { key: "sieges", label: "Sièges au conseil", align: "right" },
        ],
        rows: allTetes.map((tete) => {
          const a = t1?.listes.find((l) => l.tete === tete);
          const b = t2?.listes.find((l) => l.tete === tete);
          const any = (b ?? a)!;
          return { liste: `${any.libelle || "—"} (${tete})`, nuance: nu(any.nuance), t1: a ? pct(a.pctExprimes) : "", t2: b ? pct(b.pctExprimes) : "", sieges: (b ?? a)?.sieges ?? "" };
        }),
        highlight: maj ? [allTetes.indexOf(maj.tete)] : [],
        sources: [m.source],
        note: "Résultats définitifs par commune (ministère de l'Intérieur) ; nuances attribuées par les préfectures. Maire : Répertoire national des élus.",
      });
    }
  }
  // Groupes d'action : description enrichie (export Action Populaire).
  const groupeText = (g: (typeof groupes)[number]) => {
    const meta = [
      g.creation ? `créé ${/^\d{4}-\d{2}-\d{2}/.test(g.creation) ? `le ${new Date(g.creation).toLocaleDateString("fr-FR")}` : g.creation}` : "",
      g.membres != null ? `${g.membres} membre${g.membres > 1 ? "s" : ""}` : "",
      g.type ?? "",
      g.certifie === true ? "certifié" : g.certifie === false ? "non certifié" : "",
      g.actions != null ? `${g.actions} action${g.actions > 1 ? "s" : ""} référencée${g.actions > 1 ? "s" : ""}` : "",
      g.derniereAction ? `dernière action : ${g.derniereAction}` : "",
      g.statut,
    ].filter(Boolean);
    return `${B(`« ${g.nom} »`)}${g.code !== commune.code ? ` (${referentiel().communes.find((x) => x.code === g.code)?.nom ?? g.code})` : ""}${meta.length ? ` — ${meta.join(", ")}` : ""}.${g.description ? ` ${g.description.replace(/\.?$/, ".")}` : ""}`;
  };

  /* ================================================================ section */
  if (!out.tables.length && !socio.length) return out;
  const blocks: Block[] = [];
  const has = (t: string) => out.tables.some((x) => x.id === t);
  blocks.push({
    type: "callout",
    tone: "warning",
    text: `Le ciblage présenté ci-dessous s'appuie uniquement sur l'exploitation de données statistiques et électorales publiques agrégées (commune, bureau de vote), par des personnes qui ne vivent pas forcément ${commune.nom ? `à ${commune.nom}` : "sur place"}. ${B("Les informations suggérées doivent être confrontées à la connaissance du terrain des militantes et militants locaux.")}`,
  });
  if (glance.length >= 3) blocks.push({ type: "glance", items: glance });
  if (synth.length) blocks.push({ type: "list", items: synth });
  blocks.push({ type: "fieldNotes" });

  blocks.push({ type: "heading", text: "Profil sociodémographique du territoire" });
  if (socio.length) blocks.push({ type: "list", items: socio });
  if (has("lfi_socio")) blocks.push({ type: "table", tableId: "lfi_socio" });
  blocks.push({ type: "chart", chartId: "chart_ages" });
  if (has("lfi_quartiers")) {
    blocks.push({ type: "heading", text: "Quartiers" });
    blocks.push({ type: "table", tableId: "lfi_quartiers" });
  }

  blocks.push({ type: "heading", text: "Profil politique du territoire" });
  if (groupes.length)
    blocks.push({
      type: "callout",
      tone: "accent",
      title: groupes.length > 1 ? `${groupes.length} groupes d'action` : "Groupe d'action",
      text: groupes.map(groupeText).join("\n"),
    });
  else if (interneFourni) blocks.push({ type: "callout", tone: "accent", text: `${B("Aucun groupe d'action n'est référencé")} dans la commune ni dans son intercommunalité.` });
  else blocks.push({ type: "note", text: "Données internes non fournies (groupes d'action, parrainages) : déposer groupes.csv et parrains.csv dans data/interne/ pour compléter cette partie (voir README)." });
  const prose = (list: string[]) => list.length && blocks.push({ type: "findings", ids: list, style: "prose" });
  if (municipalText) blocks.push({ type: "paragraph", text: municipalText, evidence: [] });
  if (has("lfi_municipales")) blocks.push({ type: "table", tableId: "lfi_municipales" });
  prose([...ids.perf, ...ids.parrains]);
  if (has("lfi_politique")) blocks.push({ type: "table", tableId: "lfi_politique" });
  prose(ids2.quartiers.filter((id) => out.findings.find((f) => f.id === id)?.kind !== "hypothese"));
  prose(ids.abst);
  prose(ids.partis);
  if (has("lfi_partis")) blocks.push({ type: "table", tableId: "lfi_partis" });

  blocks.push({ type: "heading", text: "Où agir : analyse par bureau de vote" });
  if (has("lfi_bureaux")) {
    if (out.maps.some((m) => m.id === "lfi_map_bv_participation")) blocks.push({ type: "mapPair", mapIds: ["lfi_map_bv", "lfi_map_bv_participation"], title: `Vote LFI (à gauche) et participation (à droite) par bureau de vote — ${bvRef!.election.label}, % des inscrits` });
    else blocks.push({ type: "map", mapId: "lfi_map_bv" });
    if (out.maps.some((m) => m.id === "lfi_map_bv_p22")) blocks.push({ type: "mapPair", mapIds: ["lfi_map_bv_p22", "lfi_map_bv_p22_participation"], title: "Vote Mélenchon (à gauche) et participation (à droite) par bureau de vote — présidentielle 2022, 1er tour, % des inscrits" });
    prose(ids.ou);
    blocks.push({ type: "table", tableId: "lfi_bureaux" }, { type: "chart", chartId: "lfi_chart_bureaux" });
  } else blocks.push({ type: "note", text: "Résultats par bureau de vote indisponibles lors de la génération." });

  const hypQ = ids2.quartiers.filter((id) => out.findings.find((f) => f.id === id)?.kind === "hypothese");
  if (ids.hyp.length || hypQ.length) {
    blocks.push({ type: "heading", text: "Pourquoi : hypothèses à vérifier" });
    prose([...hypQ, ...ids.hyp]);
  }

  blocks.push({ type: "heading", text: "Actions recommandées" });
  if (actionGroups.length) blocks.push({ type: "actions", groups: actionGroups });
  else blocks.push({ type: "note", text: "Aucun lieu d'action identifié automatiquement (marchés, gares, commerces, établissements) : à compléter avec les militants locaux." });
  if (access.length) blocks.push({ type: "callout", tone: "info", text: `${B("Accessibilité")} : ${access.join(" ; ")}${c.routes || c.timetables ? " (temps de trajet théoriques, sans trafic)" : " (distances à vol d'oiseau)"}.` });
  if (has("lfi_lieux")) blocks.push({ type: "table", tableId: "lfi_lieux" });

  out.section = { id: "LFI", letter: "", title: "Fiche d'action — proposition de ciblage", blocks };
  return out;
}

export { MISSING_COLOR, SEQ_COLORS };
