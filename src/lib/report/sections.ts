import { fmtNumber, fmtSigned, fmtValue } from "../format";
import { evidenceId } from "../analysis/findings";
import { rankOf } from "../analysis/stats";
import { departementCommunes } from "../collectors/admin";
import type { Block, ChartSpec, DataTable, Finding, GeoRef, Indicator, MapSpec, Section } from "../types";
import type { Collected } from "./collect";

/**
 * Plan du rapport (parties A à I) et rédaction des paragraphes par gabarits.
 * Chaque paragraphe n'utilise que des valeurs d'indicateurs présents ; les
 * phrases dont une donnée manque sont simplement omises.
 */

interface Ctx {
  c: Collected;
  indicators: Indicator[];
  tables: DataTable[];
  charts: ChartSpec[];
  maps: MapSpec[];
  findings: Finding[];
}

const has = (x: Ctx, kind: "table" | "chart" | "map", id: string) =>
  kind === "table" ? x.tables.some((t) => t.id === id) : kind === "chart" ? x.charts.some((t) => t.id === id) : x.maps.some((t) => t.id === id);

function get(x: Ctx, id: string, g: GeoRef | null | undefined) {
  if (!g) return undefined;
  return x.indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code && i.value != null);
}

function para(text: string, ev: (Indicator | undefined)[]): Block {
  return { type: "paragraph", text, evidence: ev.filter(Boolean).map((i) => evidenceId(i!)) };
}

function optional(x: Ctx, kind: "table" | "chart" | "map", id: string): Block[] {
  if (!has(x, kind, id)) return [];
  return [kind === "table" ? { type: "table", tableId: id } : kind === "chart" ? { type: "chart", chartId: id } : { type: "map", mapId: id }];
}

/* ===================================================================== A */
function sectionA(x: Ctx): Section {
  const { c } = x;
  const { commune, geos } = c;
  const blocks: Block[] = [];
  const pop = get(x, "pop_municipale", geos.commune);
  const popEpci = get(x, "pop_municipale", geos.epci);
  const surf = get(x, "surface", geos.commune);
  const dens = get(x, "densite", geos.commune);
  const densDep = get(x, "densite", geos.departement);

  let t = `${commune.nom} (code INSEE ${commune.code}${commune.codesPostaux.length ? `, code${commune.codesPostaux.length > 1 ? "s" : ""} postal${commune.codesPostaux.length > 1 ? "aux" : ""} ${commune.codesPostaux.join(", ")}` : ""}) est une commune du département ${depArticle(commune.departement.nom)} (${commune.departement.code}), en région ${commune.region.nom}`;
  if (commune.arrondissement) t += `, dans l'arrondissement de ${commune.arrondissement.nom}`;
  t += ".";
  if (pop) {
    t += ` Elle compte ${fmtValue(pop.value, "habitants")} (population municipale légale, millésime ${pop.year}).`;
    const rank = rankOf(departementCommunes(commune.departement.code), (d) => d.population, (d) => d.code === commune.code);
    if (rank) t += ` Elle se classe au ${rank.rank === 1 ? "1er" : rank.rank + "e"} rang des ${fmtNumber(rank.of)} communes du département par la population.`;
  }
  if (commune.epci) {
    t += ` Elle est membre de ${commune.epci.nom}${popEpci ? ` (${fmtValue(popEpci.value, "habitants")})` : ""}`;
    if (pop && popEpci) t += `, dont elle regroupe ${fmtValue((100 * pop.value!) / popEpci.value!, "%")} de la population`;
    t += ".";
  } else t += " Elle n'est rattachée à aucun EPCI à fiscalité propre dans le référentiel.";
  if (commune.communesDeleguees.length)
    t += ` Commune nouvelle, elle regroupe les anciennes communes de ${commune.communesDeleguees.map((d) => d.nom).join(", ")} : les séries historiques peuvent intégrer ces changements de périmètre.`;
  blocks.push(para(t, [pop, popEpci]));

  if (surf || dens) {
    let s = "";
    if (surf) s += `Le territoire communal s'étend sur ${fmtValue(surf.value, "km²")}`;
    if (dens) s += `${s ? ", pour une densité de " : "La densité est de "}${fmtValue(dens.value, "hab/km²")}`;
    if (dens && densDep) s += ` (département : ${fmtValue(densDep.value, "hab/km²")})`;
    s += ".";
    if (x.c.neighbours.length) s += ` La commune est limitrophe de ${x.c.neighbours.length} commune(s) du même département, dont ${x.c.neighbours.slice(0, 4).map((n) => n.nom).join(", ")}.`;
    blocks.push(para(s, [surf, dens, densDep]));
  }
  if (c.poles.length) {
    const p = c.poles.slice(0, 4).map((p) => `${p.nom} (${fmtValue(p.population, "habitants")}, ${fmtValue(p.distanceKm, "km")})`);
    blocks.push(para(`Pôles urbains de 20 000 habitants et plus les plus proches (distance à vol d'oiseau) : ${p.join(" ; ")}.`, []));
  }
  blocks.push({ type: "kpis", indicatorIds: ["pop_municipale", "surface", "densite", "evol_pop_annuelle"] });
  blocks.push({ type: "locator" });
  blocks.push(...optional(x, "map", "map_localisation"), ...optional(x, "map", "map_epci"));
  blocks.push(...optional(x, "table", "table_perimetre"), ...optional(x, "chart", "chart_perimetre_pop"));
  blocks.push(...optional(x, "table", "table_voisins"), ...optional(x, "table", "table_poles"), ...optional(x, "table", "table_comparables"));
  return { id: "A", letter: "A", title: "Présentation générale du territoire", blocks };
}

function depArticle(nom: string) {
  if (/^[AEIOUYÉÈ]/i.test(nom)) return `de l'${nom}`;
  if (/^(Hautes?|Bouches|Côtes|Deux|Alpes|Pyrénées|Yvelines|Vosges|Landes|Ardennes|Hauts|Bouches)/.test(nom)) return `des ${nom}`;
  return `de ${nom}`;
}

/* ===================================================================== B */
function sectionB(x: Ctx): Section {
  const { geos } = x.c;
  const blocks: Block[] = [];
  const evo = get(x, "evol_pop_annuelle", geos.commune);
  const evoDep = get(x, "evol_pop_annuelle", geos.departement);
  const evoFr = get(x, "evol_pop_annuelle", geos.france);
  if (evo) {
    let t = `Sur la période ${evo.year}, la population a ${evo.value! > 0.05 ? "augmenté" : evo.value! < -0.05 ? "diminué" : "été globalement stable"} (${fmtSigned(evo.value!, "%", 2)} par an en moyenne)`;
    if (evoDep) t += `, contre ${fmtSigned(evoDep.value!, "%", 2)} par an pour le département`;
    if (evoFr) t += ` et ${fmtSigned(evoFr.value!, "%", 2)} pour la France`;
    blocks.push(para(t + ".", [evo, evoDep, evoFr]));
  }
  // Les bornes d'âge dépendent du millésime diffusé : on prend la première disponible.
  const firstOf = (ids: string[], g: GeoRef | null | undefined) => ids.map((id) => get(x, id, g)).find(Boolean);
  const y30 = firstOf(["part_moins_30", "part_moins_25", "part_moins_20"], geos.commune);
  const s60 = firstOf(["part_60_plus", "part_65_plus"], geos.commune);
  const s60Dep = s60 ? get(x, s60.id, geos.departement) : undefined;
  if (y30 || s60) {
    let t = "Structure par âge : ";
    const parts = [];
    if (y30) parts.push(`${fmtValue(y30.value, "%")} ${y30.label.replace(/^Part des /, "")}`);
    if (s60) parts.push(`${fmtValue(s60.value, "%")} ${s60.label.replace(/^Part des /, "")}${s60Dep ? ` (département : ${fmtValue(s60Dep.value, "%")})` : ""}`);
    t += parts.join(", ") + ` (recensement ${(y30 ?? s60)!.year}).`;
    blocks.push(para(t, [y30, s60, s60Dep]));
  }
  const rev = get(x, "revenu_median", geos.commune);
  const pov = get(x, "taux_pauvrete", geos.commune);
  if (rev || pov) {
    const revDep = get(x, "revenu_median", geos.departement);
    const povDep = get(x, "taux_pauvrete", geos.departement);
    let t = "";
    if (rev) t += `Le revenu disponible médian s'établit à ${fmtValue(rev.value, "€")} par unité de consommation en ${rev.year}${revDep ? ` (département : ${fmtValue(revDep.value, "€")})` : ""}. `;
    if (pov) t += `Le taux de pauvreté atteint ${fmtValue(pov.value, "%")}${povDep ? ` (département : ${fmtValue(povDep.value, "%")})` : ""}.`;
    blocks.push(para(t.trim(), [rev, revDep, pov, povDep]));
  }
  blocks.push({ type: "findings", themes: ["demographie", "menages", "revenus", "formation"], kinds: ["constat"], title: "Constats chiffrés" });
  blocks.push({
    type: "comparison",
    title: "Comparaison aux territoires de référence",
    indicatorIds: ["pop_municipale", "densite", "evol_pop_annuelle", "part_moins_15", "part_moins_25", "part_moins_30", "part_60_plus", "part_65_plus", "part_75_plus", "part_80_plus", "part_personnes_seules", "revenu_median", "taux_pauvrete", "rapport_interdecile", "part_sans_diplome", "part_diplome_superieur"],
  });
  for (const id of ["chart_pop_historique", "chart_pop_indice", "chart_ages", "chart_pyramide", "chart_dist_taille_menages", "chart_dist_csp", "chart_dist_diplomes", "chart_perimetre_revenu"]) blocks.push(...optional(x, "chart", id));
  blocks.push(...optional(x, "map", "map_densite"), ...optional(x, "map", "map_revenus"));
  blocks.push({ type: "missing", themes: ["demographie", "menages", "revenus", "formation"] });
  blocks.push({
    type: "note",
    text: "Les écarts statistiques décrivent des situations moyennes : ils ne permettent pas d'inférer les caractéristiques ou comportements d'individus, ni d'établir une causalité entre indicateurs corrélés.",
  });
  return { id: "B", letter: "B", title: "Profil sociodémographique", blocks };
}

/* ===================================================================== C */
function sectionC(x: Ctx): Section {
  const { geos, commune } = x.c;
  const blocks: Block[] = [];
  const ch = get(x, "taux_chomage_rp", geos.commune);
  const chDep = get(x, "taux_chomage_rp", geos.departement);
  const emp = get(x, "taux_emploi", geos.commune);
  const conc = get(x, "concentration_emploi", geos.commune);
  const lt = get(x, "emplois_lieu_travail", geos.commune);
  const ul = get(x, "unites_legales_actives", geos.commune);
  const parts: string[] = [];
  if (lt) parts.push(`${commune.nom} compte ${fmtValue(lt.value, "nombre")} emplois au lieu de travail (recensement ${lt.year})`);
  if (conc) parts.push(`l'indicateur de concentration d'emploi s'élève à ${fmtValue(conc.value, "nombre")} (${conc.value! >= 100 ? "plus d'emplois que d'actifs occupés résidents" : "moins d'emplois que d'actifs occupés résidents"})`);
  if (emp) parts.push(`le taux d'emploi des 15-64 ans est de ${fmtValue(emp.value, "%")}`);
  if (ch) parts.push(`le taux de chômage au sens du recensement atteint ${fmtValue(ch.value, "%")}${chDep ? ` (département : ${fmtValue(chDep.value, "%")})` : ""}`);
  if (parts.length) blocks.push(para(capitalize(parts.join(" ; ")) + ".", [lt, conc, emp, ch, chDep]));
  if (ul)
    blocks.push(
      para(
        `La base SIRENE recense ${fmtValue(ul.value, "nombre")} unités légales actives disposant d'au moins un établissement dans la commune (entreprises individuelles comprises). ${x.c.entreprises?.employers.length ? `${x.c.entreprises.employers.length} établissement(s) déclarent une tranche d'effectif de 100 salariés ou plus.` : ""}`.trim(),
        [ul],
      ),
    );
  blocks.push({ type: "findings", themes: ["emploi", "economie"], kinds: ["constat", "hypothese"] });
  blocks.push({ type: "comparison", title: "Emploi et activité", indicatorIds: ["taux_emploi", "taux_chomage_rp", "concentration_emploi", "emplois_lieu_travail", "part_sans_diplome", "part_diplome_superieur"] });
  blocks.push(...optional(x, "chart", "chart_sections"), ...optional(x, "chart", "chart_dist_csp"), ...optional(x, "table", "table_employeurs"));
  blocks.push({
    type: "note",
    text: "Non couverts automatiquement à ce stade : évolution annuelle de l'emploi salarié (URSSAF / Acoss), zones d'activité économique, offre de formation et d'insertion, évolution du tissu commercial. Ces éléments sont listés dans la partie I comme compléments à recueillir.",
  });
  blocks.push({ type: "missing", themes: ["emploi", "economie"] });
  return { id: "C", letter: "C", title: "Économie et emploi", blocks };
}

/* ===================================================================== D */
function sectionD(x: Ctx): Section {
  const blocks: Block[] = [];
  const eq = x.c.equipments?.features.length;
  if (eq != null)
    blocks.push(
      para(
        `${fmtNumber(eq)} équipements et services ont été recensés dans OpenStreetMap à l'intérieur des limites communales. Ce recensement est indicatif : OpenStreetMap est une base contributive, et l'absence d'un équipement dans la base ne prouve pas son absence sur le terrain. La Base permanente des équipements (BPE) de l'INSEE constitue la référence statistique pour confirmer ces décomptes.`,
        [],
      ),
    );
  const sc = get(x, "nb_etablissements_scolaires", x.c.geos.commune);
  if (sc) blocks.push(para(`L'Annuaire de l'éducation recense ${fmtNumber(sc.value)} établissements scolaires ouverts dans la commune.`, [sc]));
  blocks.push(...optional(x, "map", "map_equipements"), ...optional(x, "table", "table_equipements"), ...optional(x, "chart", "chart_equipements"), ...optional(x, "table", "table_ecoles"));
  blocks.push({ type: "findings", themes: ["equipements", "sante", "education"] });
  blocks.push({ type: "missing", themes: ["equipements", "sante", "education"] });
  return { id: "D", letter: "D", title: "Services publics et équipements", blocks };
}

/* ===================================================================== E */
function sectionE(x: Ctx): Section {
  const blocks: Block[] = [];
  const g = get(x, "nb_gares", x.c.geos.commune);
  const v = get(x, "voyageurs_gares", x.c.geos.commune);
  const cy = get(x, "km_amenagements_cyclables", x.c.geos.commune);
  const s: string[] = [];
  if (g) s.push(g.value ? `La commune dispose de ${fmtNumber(g.value)} gare(s) de voyageurs${v ? `, totalisant ${fmtValue(v.value, "nombre")} voyageurs en ${v.year}` : ""}` : "Aucune gare de voyageurs n'est recensée par SNCF Open Data dans la commune");
  if (cy) s.push(`OpenStreetMap recense ${fmtValue(cy.value, "km")} de voies équipées d'aménagements cyclables`);
  if (s.length) blocks.push(para(s.join(". ") + ".", [g, v, cy]));
  blocks.push(...optional(x, "map", "map_transports"), ...optional(x, "table", "table_gares"), ...optional(x, "table", "table_acces"), ...optional(x, "map", "map_acces"));
  blocks.push({
    type: "comparison",
    title: "Mobilité domicile-travail et équipement automobile",
    indicatorIds: ["part_menages_sans_voiture", "part_menages_2_voitures", "part_trajets_voiture", "part_trajets_tc", "part_actifs_travaillant_commune"],
  });
  blocks.push(...optional(x, "chart", "chart_dist_mode_transport"), ...optional(x, "chart", "chart_dist_lieu_travail"), ...optional(x, "chart", "chart_dist_voitures"), ...optional(x, "table", "table_poles"));
  blocks.push({ type: "findings", themes: ["mobilite"] });
  blocks.push({
    type: "note",
    text: "Les distances sont calculées à vol d'oiseau. Les fréquences et destinations des trains, les lignes de bus et les temps de trajet nécessitent l'exploitation des flux GTFS publiés sur transport.data.gouv.fr (non intégrée dans cette version).",
  });
  blocks.push({ type: "missing", themes: ["mobilite"] });
  return { id: "E", letter: "E", title: "Mobilité et accessibilité", blocks };
}

/* ===================================================================== F */
function sectionF(x: Ctx): Section {
  const { geos } = x.c;
  const blocks: Block[] = [];
  const vac = get(x, "part_logements_vacants", geos.commune);
  const hlm = get(x, "part_locataires_hlm", geos.commune);
  const prop = get(x, "part_proprietaires", geos.commune);
  const parts: string[] = [];
  if (prop) parts.push(`${fmtValue(prop.value, "%")} des ménages sont propriétaires de leur résidence principale`);
  if (hlm) parts.push(`${fmtValue(hlm.value, "%")} sont locataires d'un logement HLM`);
  if (vac) parts.push(`les logements vacants représentent ${fmtValue(vac.value, "%")} du parc`);
  if (parts.length) blocks.push(para(capitalize(parts.join(", ")) + ` (recensement ${(prop ?? hlm ?? vac)!.year}).`, [prop, hlm, vac]));
  const pa = get(x, "prix_m2_appartement", geos.commune);
  const pm = get(x, "prix_m2_maison", geos.commune);
  if (pa || pm)
    blocks.push(
      para(
        `D'après les transactions enregistrées (DVF), le prix médian s'établit à ${[pa ? `${fmtValue(pa.value, "€/m²")} pour les appartements (${pa.year}, ${pa.denominator} ventes)` : "", pm ? `${fmtValue(pm.value, "€/m²")} pour les maisons (${pm.year}, ${pm.denominator} ventes)` : ""].filter(Boolean).join(" et ")}.`,
        [pa, pm],
      ),
    );
  blocks.push({ type: "comparison", title: "Parc de logements", indicatorIds: ["part_residences_principales", "part_residences_secondaires", "part_logements_vacants", "part_maisons", "part_proprietaires", "part_locataires_prives", "part_locataires_hlm"] });
  blocks.push(...optional(x, "chart", "chart_dist_periode_construction"), ...optional(x, "chart", "chart_dvf"), ...optional(x, "table", "table_dvf"));
  blocks.push({ type: "findings", themes: ["logement", "immobilier", "risques"] });
  blocks.push(...optional(x, "table", "table_risques"), ...optional(x, "map", "map_icpe"));
  blocks.push({
    type: "note",
    text: "Non couverts automatiquement : performance énergétique du parc (DPE de l'ADEME), logements sociaux au sens du répertoire RPLS, artificialisation des sols (portail de l'artificialisation), différences infracommunales (IRIS).",
  });
  blocks.push({ type: "missing", themes: ["logement", "immobilier", "risques"] });
  return { id: "F", letter: "F", title: "Logement et cadre de vie", blocks };
}

/* ===================================================================== G */
function sectionG(x: Ctx): Section {
  const blocks: Block[] = [
    {
      type: "note",
      text: "Chapitre strictement descriptif. Les résultats présentés sont des agrégats officiels publiés par le ministère de l'Intérieur. Ils ne permettent pas de déduire les opinions d'individus ou de groupes sociaux, et ne doivent pas servir au ciblage de personnes ou de quartiers.",
    },
  ];
  if (!x.c.elections.length) blocks.push(para("Les résultats électoraux n'ont pas pu être récupérés lors de la génération de cette fiche (voir la liste des sources).", []));
  blocks.push(...optional(x, "table", "table_participation"), ...optional(x, "chart", "chart_participation"), ...optional(x, "map", "map_participation"));
  for (const e of x.c.elections) {
    const id = `table_elec_${e.results[0].election.id}`;
    blocks.push(...optional(x, "table", id));
  }
  blocks.push({ type: "findings", themes: ["elections"], kinds: ["constat"] });
  blocks.push({ type: "missing", themes: ["elections"] });
  return { id: "G", letter: "G", title: "Contexte institutionnel et électoral", blocks };
}

/* ===================================================================== H */
function sectionH(x: Ctx): Section {
  return {
    id: "H",
    letter: "H",
    title: "Analyse transversale du territoire",
    blocks: [
      para(
        "Cette partie rassemble les enseignements issus des chapitres précédents. Chaque affirmation renvoie aux indicateurs qui la fondent. Les atouts et points de vigilance reposent sur des écarts significatifs aux références (règle : au moins 2 points et 10 % d'écart relatif pour les taux, 10 % pour les autres grandeurs) ; les hypothèses sont des pistes d'explication à vérifier.",
        [],
      ),
      { type: "findings", kinds: ["atout"], title: "Atouts et ressources" },
      { type: "findings", kinds: ["vigilance"], title: "Fragilités et points de vigilance" },
      { type: "findings", kinds: ["hypothese"], title: "Hypothèses d'interprétation (à vérifier)" },
      { type: "findings", kinds: ["piste"], title: "Enjeux et pistes de travail" },
      { type: "findings", kinds: ["a_verifier"], title: "Questions nécessitant une enquête de terrain ou des données complémentaires" },
    ],
  };
}

/* ===================================================================== I */
export const RESOURCES = [
  { text: "INSEE — Dossier complet de la commune", url: "https://www.insee.fr/fr/statistiques/2011101" },
  { text: "INSEE — Base permanente des équipements (BPE)", url: "https://www.insee.fr/fr/metadonnees/source/serie/s1161" },
  { text: "Observatoire des territoires (ANCT)", url: "https://www.observatoire-des-territoires.gouv.fr/" },
  { text: "DREES — Accessibilité potentielle localisée aux médecins (APL)", url: "https://data.drees.solidarites-sante.gouv.fr/" },
  { text: "Données LOVAC sur la vacance des logements", url: "https://www.data.gouv.fr/fr/datasets/logements-vacants-du-parc-prive-par-commune-epci-departement-region/" },
  { text: "Répertoire du parc locatif social (RPLS)", url: "https://www.statistiques.developpement-durable.gouv.fr/" },
  { text: "Géorisques — rapport de risques par adresse", url: "https://www.georisques.gouv.fr/" },
  { text: "transport.data.gouv.fr — horaires de transport (GTFS)", url: "https://transport.data.gouv.fr/" },
  { text: "Portail de l'artificialisation des sols", url: "https://artificialisation.developpement-durable.gouv.fr/" },
  { text: "Résultats électoraux officiels (data.gouv.fr)", url: "https://www.data.gouv.fr/fr/pages/donnees-des-elections/" },
  { text: "Annuaire de l'administration — services publics locaux", url: "https://lannuaire.service-public.fr/" },
];

function sectionI(x: Ctx): Section {
  const top = x.findings
    .filter((f) => f.kind === "constat" || f.kind === "atout" || f.kind === "vigilance" || f.kind === "hypothese")
    .sort((a, b) => b.weight - a.weight);
  // On évite de répéter le même indicateur (constat + vigilance) dans les enseignements clés.
  const seen = new Set<string>();
  const key: Finding[] = [];
  for (const f of top) {
    const k = f.evidence[0] ?? f.text;
    if (seen.has(k)) continue;
    seen.add(k);
    key.push(f);
    if (key.length >= 10) break;
  }
  const { commune, geos } = x.c;
  const pop = get(x, "pop_municipale", geos.commune);
  const nInd = x.indicators.filter((i) => i.geo.level === "commune" && i.value != null).length;
  const nSrc = new Set(x.c.ctx.runs.filter((r) => r.status !== "failed" && r.status !== "skipped").map((r) => r.sourceId)).size;
  const failed = [...new Set(x.c.ctx.runs.filter((r) => r.status === "failed").map((r) => r.name))];
  let synth = `${commune.nom}${pop ? ` (${fmtValue(pop.value, "habitants")})` : ""}, ${commune.departement.nom}, ${commune.region.nom}. Cette fiche mobilise ${nInd} indicateurs communaux issus de ${nSrc} source(s) publique(s) interrogée(s) avec succès.`;
  if (failed.length) synth += ` Sources indisponibles lors de la génération : ${failed.join(" ; ")}. Les rubriques correspondantes sont signalées comme manquantes.`;
  const vig = x.findings.filter((f) => f.kind === "vigilance").length;
  const atouts = x.findings.filter((f) => f.kind === "atout").length;
  if (vig || atouts) synth += ` L'analyse automatique relève ${atouts} atout(s) et ${vig} point(s) de vigilance au regard des moyennes de référence.`;
  return {
    id: "I",
    letter: "I",
    title: "Synthèse opérationnelle",
    blocks: [
      para(synth, []),
      ...(key.length ? [{ type: "list" as const, title: "Enseignements principaux", items: key.map((f) => ({ text: f.text })) }] : []),
      {
        type: "kpis",
        indicatorIds: ["pop_municipale", "densite", "evol_pop_annuelle", "part_65_plus", "part_60_plus", "revenu_median", "taux_pauvrete", "taux_chomage_rp", "part_logements_vacants", "part_locataires_hlm", "prix_m2_appartement", "unites_legales_actives", "nb_etablissements_scolaires"],
      },
      { type: "missing", themes: [] },
      { type: "findings", kinds: ["a_verifier"], title: "Vérifications à mener auprès des acteurs locaux" },
      {
        type: "list",
        title: "Acteurs à consulter",
        items: [
          { text: "Mairie et services de l'intercommunalité (urbanisme, habitat, action sociale)" },
          { text: "Centre communal d'action sociale (CCAS) et espace France Services" },
          { text: "France Travail et mission locale" },
          { text: "Bailleurs sociaux présents sur la commune" },
          { text: "Communauté professionnelle territoriale de santé (CPTS) et agence régionale de santé" },
          { text: "Autorité organisatrice des mobilités" },
          { text: "Associations locales et conseils de quartier" },
        ],
      },
      { type: "list", title: "Ressources publiques pour approfondir", items: RESOURCES },
    ],
  };
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildSections(x: Ctx): Section[] {
  return [sectionA(x), sectionB(x), sectionC(x), sectionD(x), sectionE(x), sectionF(x), sectionG(x), sectionH(x), sectionI(x)];
}
