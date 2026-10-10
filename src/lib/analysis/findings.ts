import { fmtSigned, fmtValue } from "../format";
import type { Finding, GeoRef, Indicator, MissingItem, ThemeId } from "../types";
import { gap, isSmallSample, robustZ } from "./stats";

/**
 * Moteur de constats.
 *
 * Il transforme les indicateurs en affirmations courtes, chacune reliée aux
 * indicateurs qui la fondent (`evidence`). Les règles sont explicites :
 *  - CONSTAT : valeur observée et écart à la référence départementale (et
 *    nationale lorsqu'elle existe), avec qualification « proche / supérieur /
 *    inférieur » selon la règle de `gap()` ;
 *  - ATOUT / VIGILANCE : écart significatif dans un sens favorable /
 *    défavorable pour un indicateur dont le sens est défini (`higherIsBetter`) ;
 *  - HYPOTHÈSE : combinaison de constats suggérant une explication, toujours
 *    formulée au conditionnel et assortie d'une vérification à mener ;
 *  - PISTE : enjeu territorial objectif associé à une vigilance ;
 *  - À VÉRIFIER : donnée manquante, petit effectif, base contributive.
 * Aucune règle ne produit de chiffre qui ne figure pas dans un indicateur.
 */

export interface FindingInput {
  focus: GeoRef;
  references: GeoRef[];
  indicators: Indicator[];
  missing: MissingItem[];
  comparables: { code: string; values: Record<string, number | null> }[];
  population: number | null;
}

const find = (inds: Indicator[], id: string, g: GeoRef) => inds.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code && i.value != null);

const srcShort = (i: Indicator) => {
  const s = i.source.dataset ? `${i.source.dataset.replace(/^DS_/, "").replace(/_/g, " ")}` : i.source.name.split(" (")[0];
  return `${s}${i.year ? ", " + i.year : ""}`;
};

/** Indicateurs soumis à comparaison automatique, avec leur poids dans la synthèse. */
const COMPARED: { id: string; weight: number; pistes?: string }[] = [
  { id: "taux_pauvrete", weight: 95, pistes: "Accès aux droits et aux services sociaux : vérifier la couverture des permanences (France Services, CCAS, CAF) et leur accessibilité." },
  { id: "revenu_median", weight: 85 },
  { id: "taux_chomage_rp", weight: 90, pistes: "Emploi et insertion : recenser l'offre d'accompagnement (France Travail, mission locale, structures d'insertion) et son accessibilité." },
  { id: "taux_emploi", weight: 70 },
  { id: "evol_pop_annuelle", weight: 80 },
  { id: "part_60_plus", weight: 60, pistes: "Vieillissement : examiner l'offre de services aux personnes âgées (soins à domicile, hébergement, mobilité)." },
  { id: "part_65_plus", weight: 60, pistes: "Vieillissement : examiner l'offre de services aux personnes âgées (soins à domicile, hébergement, mobilité)." },
  { id: "part_75_plus", weight: 55 },
  { id: "part_80_plus", weight: 55 },
  { id: "part_moins_30", weight: 55 },
  { id: "part_moins_25", weight: 55 },
  { id: "part_menages_sans_voiture", weight: 60 },
  { id: "part_trajets_voiture", weight: 55 },
  { id: "part_actifs_travaillant_commune", weight: 45 },
  { id: "part_logements_vacants", weight: 75, pistes: "Logement : qualifier la vacance (durée, état du bâti, localisation) avec les données LOVAC et les services de l'habitat." },
  { id: "part_locataires_hlm", weight: 65 },
  { id: "part_residences_secondaires", weight: 45 },
  { id: "part_sans_diplome", weight: 70, pistes: "Formation : identifier l'offre de formation continue et de lutte contre l'illettrisme accessible localement." },
  { id: "part_diplome_superieur", weight: 55 },
  { id: "part_personnes_seules", weight: 50, pistes: "Isolement : vérifier l'offre de lien social et d'accompagnement des personnes vivant seules (CCAS, associations)." },
  { id: "rapport_interdecile", weight: 60 },
  { id: "densite", weight: 40 },
  { id: "part_proprietaires", weight: 40 },
  { id: "concentration_emploi", weight: 70 },
];

/** Libellé de comparaison selon la direction de l'écart. */
function dirWord(d: "superieur" | "inferieur" | "proche") {
  return d === "superieur" ? "supérieur" : d === "inferieur" ? "inférieur" : "proche";
}

export function computeFindings(inp: FindingInput): Finding[] {
  const out: Finding[] = [];
  const { focus, indicators } = inp;
  const dep = inp.references.find((r) => r.level === "departement" && !(focus.level === "departement"));
  const fr = inp.references.find((r) => r.level === "france");
  const reg = inp.references.find((r) => r.level === "region");
  let n = 0;
  const add = (f: Omit<Finding, "id">) => out.push({ ...f, id: `F${++n}` });

  for (const c of COMPARED) {
    const v = find(indicators, c.id, focus);
    if (!v) continue;
    const ref = (dep && find(indicators, c.id, dep)) || (reg && find(indicators, c.id, reg)) || undefined;
    const nat = fr ? find(indicators, c.id, fr) : undefined;
    const ev = [v, ref, nat].filter(Boolean).map((i) => evidenceId(i!));
    const val = fmtValue(v.value, v.unit);
    let text = `${v.label} : ${val} (${srcShort(v)})`;
    let kindWeight = c.weight * 0.6;
    let g = null as ReturnType<typeof gap> | null;
    if (ref) {
      g = gap(v.value!, ref.value!, v.unit);
      text += g.significant
        ? `, niveau ${dirWord(g.direction)} à celui ${refName(ref.geo)} (${fmtValue(ref.value, ref.unit)} ; écart ${fmtSigned(g.unit === "points" ? g.abs : g.rel ?? g.abs, g.unit === "points" ? "points" : "%")})`
        : `, niveau proche de celui ${refName(ref.geo)} (${fmtValue(ref.value, ref.unit)})`;
      if (g.significant) kindWeight = c.weight;
    }
    if (nat && nat !== ref) text += ` ; France : ${fmtValue(nat.value, nat.unit)}`;
    text += ".";
    if (isSmallSample(v)) text += " Effectif faible : valeur à interpréter avec prudence.";
    add({ kind: "constat", theme: v.theme, text, evidence: ev, weight: kindWeight });

    if (g?.significant && v.higherIsBetter !== undefined) {
      const favorable = (g.direction === "superieur") === v.higherIsBetter;
      add({
        kind: favorable ? "atout" : "vigilance",
        theme: v.theme,
        text: `${v.label} ${favorable ? "plus favorable" : "moins favorable"} que ${refName(ref!.geo, true)} (${val} contre ${fmtValue(ref!.value, ref!.unit)}).`,
        evidence: ev,
        weight: c.weight,
      });
      if (!favorable && c.pistes) add({ kind: "piste", theme: v.theme, text: c.pistes, evidence: ev, weight: c.weight - 5 });
    }

    // Comparaison aux communes comparables (score z robuste).
    const sample = inp.comparables.map((x) => x.values[c.id]).filter((x): x is number => x != null);
    const z = robustZ(v.value!, sample);
    if (z != null && Math.abs(z) >= 2) {
      add({
        kind: "constat",
        theme: v.theme,
        text: `Parmi ${sample.length} communes comparables (taille et densité proches), la valeur de ${v.label.toLowerCase()} est atypiquement ${z > 0 ? "élevée" : "faible"} (score z robuste : ${fmtValue(z, "nombre", 1)}).`,
        evidence: [evidenceId(v)],
        weight: c.weight * 0.8,
      });
    }
  }

  /* Dynamique démographique */
  const evo = find(indicators, "evol_pop_annuelle", focus);
  const vac = find(indicators, "part_logements_vacants", focus);
  const vacDep = dep ? find(indicators, "part_logements_vacants", dep) : undefined;
  if (evo && evo.value! < -0.3 && vac && vacDep && gap(vac.value!, vacDep.value!, "%").direction === "superieur") {
    add({
      kind: "hypothese",
      theme: "logement",
      text: `La baisse de population (${fmtSigned(evo.value!, "%")} par an) conjuguée à une vacance élevée (${fmtValue(vac.value, "%")}) pourrait traduire une moindre attractivité résidentielle ou l'inadaptation d'une partie du parc. Hypothèse à confronter aux données LOVAC et aux acteurs de l'habitat.`,
      evidence: [evidenceId(evo), evidenceId(vac), evidenceId(vacDep)],
      weight: 70,
    });
  }
  const conc = find(indicators, "concentration_emploi", focus);
  if (conc && conc.value! > 110) {
    add({
      kind: "hypothese",
      theme: "emploi",
      text: `Avec un indicateur de concentration d'emploi de ${fmtValue(conc.value, "nombre")}, le territoire offre davantage d'emplois qu'il ne compte d'actifs occupés résidents : il joue vraisemblablement un rôle de pôle d'emploi attirant des actifs des communes voisines (à confirmer avec les flux domicile-travail MOBPRO de l'INSEE).`,
      evidence: [evidenceId(conc)],
      weight: 65,
    });
  } else if (conc && conc.value! < 70) {
    add({
      kind: "hypothese",
      theme: "emploi",
      text: `L'indicateur de concentration d'emploi (${fmtValue(conc.value, "nombre")}) suggère une fonction surtout résidentielle : une part importante des actifs travaille probablement hors du territoire, ce qui accroît les besoins de mobilité (à confirmer avec les flux MOBPRO).`,
      evidence: [evidenceId(conc)],
      weight: 65,
    });
  }

  /* Équipements : absences dans OSM → vérification, jamais « sous-équipement » */
  const pop = inp.population ?? 0;
  const osmChecks: [string, string, number][] = [
    ["osm_medecin", "médecin ou cabinet médical", 2000],
    ["osm_pharmacie", "pharmacie", 2000],
    ["osm_ecole", "école", 1000],
    ["osm_alimentaire", "commerce alimentaire (supermarché ou supérette)", 1500],
    ["osm_poste", "bureau ou agence postale", 3000],
  ];
  for (const [id, label, minPop] of osmChecks) {
    const v = indicators.find((i) => i.id === id && i.geo.level === "commune");
    if (v && v.value === 0 && pop >= minPop)
      add({
        kind: "a_verifier",
        theme: "equipements",
        text: `Aucun(e) ${label} n'est recensé(e) dans OpenStreetMap pour une commune de ${fmtValue(pop, "habitants")} : lacune probable de la base ou réel déficit, à vérifier (BPE de l'INSEE, annuaire santé, mairie).`,
        evidence: [evidenceId(v)],
        weight: 50,
      });
  }
  const med = indicators.find((i) => i.id === "osm_medecin" && i.geo.level === "commune");
  if (med && med.value! > 0 && pop > 0) {
    add({
      kind: "constat",
      theme: "sante",
      text: `${fmtValue(med.value, "nombre")} lieu(x) d'exercice médical recensé(s) dans OpenStreetMap. Ce décompte ne mesure ni le nombre de praticiens ni leur disponibilité : l'accessibilité potentielle localisée (APL) de la DREES est la référence pour qualifier un éventuel désert médical.`,
      evidence: [evidenceId(med)],
      weight: 40,
    });
  }

  /* Distances */
  for (const d of indicators.filter((i) => i.id.startsWith("distance_") && i.geo.level === "commune")) {
    if (d.value! > 15)
      add({
        kind: "vigilance",
        theme: "mobilite",
        text: `${d.label} : ${fmtValue(d.value, "km")} à vol d'oiseau, ce qui implique un accès dépendant des moyens de transport disponibles.`,
        evidence: [evidenceId(d)],
        weight: 55,
      });
  }

  /* Risques */
  const catnat = indicators.find((i) => i.id === "nb_catnat" && i.geo.level === "commune");
  if (catnat && catnat.value! >= 5)
    add({
      kind: "vigilance",
      theme: "risques",
      text: `${fmtValue(catnat.value, "nombre")} arrêtés de catastrophe naturelle ont été pris pour la commune depuis 1982 (Géorisques) : exposition récurrente à documenter (types d'aléas, quartiers concernés, PPR).`,
      evidence: [evidenceId(catnat)],
      weight: 50,
    });

  /* Immobilier */
  for (const id of ["prix_m2_appartement", "prix_m2_maison"]) {
    const p = indicators.find((i) => i.id === id && i.geo.level === "commune");
    if (p)
      add({
        kind: "constat",
        theme: "immobilier",
        text: `${p.label} : ${fmtValue(p.value, "€/m²")} en ${p.year} (${p.denominator} ventes, DVF).${p.status === "partial" ? " Effectif réduit : valeur indicative." : ""}`,
        evidence: [evidenceId(p)],
        weight: 45,
      });
  }

  /* Participation électorale : constat descriptif uniquement */
  for (const p of indicators.filter((i) => i.id.startsWith("participation_") && i.geo.level === "commune")) {
    const d = dep ? find(indicators, p.id, dep) : undefined;
    if (!d) continue;
    const g = gap(p.value!, d.value!, "%");
    add({
      kind: "constat",
      theme: "elections",
      text: `${p.label} : ${fmtValue(p.value, "%")} des inscrits, contre ${fmtValue(d.value, "%")} dans le département (${g.significant ? `écart de ${fmtSigned(g.abs, "points")}` : "niveau proche"}).`,
      evidence: [evidenceId(p), evidenceId(d)],
      weight: 30,
    });
  }

  /* Données manquantes → vérifications */
  for (const m of inp.missing.slice(0, 12))
    add({ kind: "a_verifier", theme: m.theme, text: `${m.label} : ${m.reason}.`, evidence: [], weight: 20 });

  return out;
}

export function evidenceId(i: Indicator) {
  return `${i.id}@${i.geo.level}:${i.geo.code}`;
}

function refName(g: GeoRef, short = false) {
  if (g.level === "departement") return short ? `la moyenne du département (${g.name})` : `du département (${g.name})`;
  if (g.level === "region") return short ? `la moyenne régionale (${g.name})` : `de la région (${g.name})`;
  if (g.level === "france") return short ? "la moyenne nationale" : "de la France";
  return short ? g.name : `de ${g.name}`;
}

export const KIND_LABELS: Record<Finding["kind"], string> = {
  constat: "Constat",
  atout: "Atout",
  vigilance: "Point de vigilance",
  hypothese: "Hypothèse",
  piste: "Piste d'action",
  a_verifier: "À vérifier",
};

export const THEME_LABELS: Record<ThemeId, string> = {
  identite: "Identité et périmètres",
  demographie: "Démographie",
  menages: "Ménages et familles",
  revenus: "Revenus et pauvreté",
  emploi: "Emploi et activité",
  formation: "Formation",
  logement: "Logement",
  economie: "Économie",
  equipements: "Équipements et services",
  sante: "Santé",
  education: "Éducation",
  mobilite: "Mobilité et accessibilité",
  immobilier: "Marché immobilier",
  risques: "Risques et environnement",
  elections: "Contexte électoral",
};
