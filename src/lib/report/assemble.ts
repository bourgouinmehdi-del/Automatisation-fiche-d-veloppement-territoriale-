import * as turf from "@turf/turf";
import { referentiel } from "../collectors/admin";
import { CATEGORIES, GROUP_COLORS, GROUP_LABELS } from "../collectors/osm";
import { SECTIONS_NAF } from "../collectors/public-apis";
import { BPE_TYPES, BPE_VINTAGE } from "../collectors/bpe";
import { density, quantileBreaks, seriesEvolution } from "../analysis/stats";
import type { ChartSpec, DataTable, GeoRef, Indicator, MapLegend, MapSpec, MissingItem, Series, SourceRef, ThemeId } from "../types";
import type { Collected } from "./collect";

/**
 * Transforme les données collectées en objets de rapport normalisés :
 * indicateurs (avec leur traçabilité), séries, tableaux, graphiques et cartes.
 * Aucun calcul ici ne complète une donnée absente.
 */

export const SEQ_COLORS = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
export const MISSING_COLOR = "#e5e7eb";

export interface Assembled {
  indicators: Indicator[];
  series: Series[];
  tables: DataTable[];
  charts: ChartSpec[];
  maps: MapSpec[];
  missing: MissingItem[];
}

const levelOrder: GeoRef["level"][] = ["commune", "epci", "departement", "region", "france"];

function simplify<T extends GeoJSON.FeatureCollection>(fc: T, tolerance: number): T {
  try {
    const s = turf.simplify(fc, { tolerance, highQuality: false, mutate: false });
    return turf.truncate(s, { precision: 5, coordinates: 2, mutate: true }) as T;
  } catch {
    return fc;
  }
}

function legendFromBreaks(title: string, unit: Indicator["unit"], breaks: number[]): MapLegend {
  const classes = [];
  for (let i = 0; i < breaks.length - 1; i++)
    classes.push({ min: breaks[i], max: breaks[i + 1], color: SEQ_COLORS[Math.min(SEQ_COLORS.length - 1, Math.round((i * (SEQ_COLORS.length - 1)) / Math.max(1, breaks.length - 2)))] });
  return { title, unit, classes, missingLabel: "Donnée non disponible" };
}

export function colorFor(v: number | null | undefined, legend?: MapLegend): string {
  if (v == null || !Number.isFinite(v) || !legend?.classes?.length) return MISSING_COLOR;
  for (const c of legend.classes) if (v <= c.max) return c.color;
  return legend.classes[legend.classes.length - 1].color;
}

export function assemble(c: Collected): Assembled {
  const indicators: Indicator[] = [];
  const series: Series[] = [];
  const tables: DataTable[] = [];
  const charts: ChartSpec[] = [];
  const maps: MapSpec[] = [];
  const missing: MissingItem[] = [...c.ctx.missing];
  const { commune, geos } = c;
  const now = new Date().toISOString();
  const calc = (url = ""): SourceRef => ({ id: "calcul", name: "Calcul de l'application", url, retrievedAt: now });

  /* ------------------------------------------------ population et densité */
  for (const p of c.populations) {
    if (!Number.isFinite(p.value)) continue;
    indicators.push({
      id: "pop_municipale",
      label: "Population municipale (population légale)",
      theme: "demographie",
      value: p.value,
      unit: "habitants",
      year: c.popSource.vintage,
      geo: p.geo,
      source: c.popSource,
      status: "ok",
      method: p.communes > 1 ? `Somme des populations municipales de ${p.communes.toLocaleString("fr-FR")} communes.` : undefined,
      limits: "Population légale millésimée 2023, en vigueur au 1er janvier 2026.",
    });
  }
  if (commune.surfaceKm2 != null && c.geoSource) {
    indicators.push({ id: "surface", label: "Superficie", theme: "identite", value: commune.surfaceKm2, unit: "km²", geo: geos.commune, source: c.geoSource, status: "ok" });
    const d = density(commune.population, commune.surfaceKm2);
    indicators.push({
      id: "densite",
      label: "Densité de population",
      theme: "demographie",
      value: d,
      unit: "hab/km²",
      year: c.popSource.vintage,
      geo: geos.commune,
      source: { ...c.geoSource, name: "geo.api.gouv.fr (surface) et INSEE (population légale)" },
      status: d == null ? "missing" : "ok",
      method: "Population municipale / superficie.",
    });
  }
  if (c.depFeatures) {
    const feats = c.depFeatures.features.map((f) => f.properties as { code: string; population?: number; surface?: number; codeEpci?: string });
    const agg = (list: typeof feats) => {
      const pop = list.reduce((s, x) => s + (x.population ?? 0), 0);
      const sur = list.reduce((s, x) => s + (x.surface ?? 0), 0) / 100;
      return density(pop, sur);
    };
    const dd = agg(feats);
    if (dd != null && c.geoSource)
      indicators.push({
        id: "densite",
        label: "Densité de population",
        theme: "demographie",
        value: dd,
        unit: "hab/km²",
        geo: geos.departement,
        source: { ...c.geoSource, name: "geo.api.gouv.fr (populations et surfaces communales)" },
        status: "ok",
        method: "Somme des populations / somme des surfaces des communes du département.",
      });
    if (geos.epci && commune.epci) {
      const members = new Set(referentiel().epcis.find((e) => e.code === commune.epci!.code)?.membres.map((m) => m.code));
      const inDep = feats.filter((f) => members.has(f.code));
      if (inDep.length === members.size && c.geoSource) {
        indicators.push({
          id: "densite",
          label: "Densité de population",
          theme: "demographie",
          value: agg(inDep),
          unit: "hab/km²",
          geo: geos.epci,
          source: { ...c.geoSource, name: "geo.api.gouv.fr (populations et surfaces communales)" },
          status: "ok",
          method: "Somme des populations / somme des surfaces des communes membres.",
        });
      }
    }
  }

  /* ------------------------------------------------ INSEE */
  for (const { result } of c.insee) {
    indicators.push(...result.indicators);
    series.push(...result.series);
  }
  for (const s of series.filter((x) => x.id === "pop_historique")) {
    const ev = seriesEvolution(s.points, 10);
    if (ev?.annual != null)
      indicators.push({
        id: "evol_pop_annuelle",
        label: `Variation annuelle moyenne de la population (${ev.from}-${ev.to})`,
        theme: "demographie",
        value: ev.annual,
        unit: "%",
        year: `${ev.from}-${ev.to}`,
        geo: s.geo,
        source: s.source,
        status: "ok",
        method: "Taux de croissance annuel moyen : (Pfin / Pdébut)^(1/n) − 1.",
        limits: "Les populations de référence successives peuvent intégrer des changements de périmètre communal (communes nouvelles).",
      });
  }

  /* ------------------------------------------------ distances */
  if (c.poles.length && c.polesSource) {
    const nearestBig = c.poles.find((p) => p.population >= 50000);
    if (nearestBig)
      indicators.push({
        id: "distance_pole_50k",
        label: `Distance à la commune de 50 000 hab. ou plus la plus proche (${nearestBig.nom})`,
        theme: "mobilite",
        value: nearestBig.distanceKm,
        unit: "km",
        geo: geos.commune,
        source: c.polesSource,
        status: "ok",
        method: "Distance à vol d'oiseau entre les centres communaux (geo.api.gouv.fr).",
        limits: "Ne reflète ni le temps de trajet ni l'offre de transport.",
      });
  }
  for (const n of c.nearest ?? []) {
    indicators.push({
      id: "distance_" + n.label.toLowerCase().normalize("NFD").replace(/[^a-z]+/g, "_"),
      label: `Distance : ${n.label.toLowerCase()} le plus proche (${n.name})`,
      theme: "mobilite",
      value: n.distanceKm,
      unit: "km",
      geo: geos.commune,
      source: c.nearestSource!,
      status: "ok",
      method: "Distance à vol d'oiseau depuis le centre communal (rayon de recherche : 30 km).",
      limits: "OpenStreetMap : couverture incomplète possible ; distance non routière.",
    });
  }

  /* ------------------------------------------------ DVF */
  if (c.dvf?.stats.length) {
    const lastYear = c.dvf.stats[c.dvf.stats.length - 1].year;
    for (const type of ["Appartement", "Maison"] as const) {
      // Dernière année complète disponible avec au moins 10 ventes.
      const st = [...c.dvf.stats].reverse().find((s) => s.type === type && s.count >= 10);
      if (!st) continue;
      indicators.push({
        id: type === "Maison" ? "prix_m2_maison" : "prix_m2_appartement",
        label: `Prix médian au m² — ${type === "Maison" ? "maisons" : "appartements"}`,
        theme: "immobilier",
        value: st.median,
        unit: "€/m²",
        year: st.year,
        geo: geos.commune,
        source: { ...c.dvf.source, vintage: st.year },
        status: st.count < 30 ? "partial" : "ok",
        denominator: st.count,
        method: `Médiane des prix au m² de ${st.count} ventes d'un seul logement (${type.toLowerCase()}) en ${st.year}.`,
        limits:
          (st.count < 30 ? "Moins de 30 ventes : valeur instable. " : "") +
          (st.year === lastYear ? "L'année la plus récente peut être incomplète (publication semestrielle). " : "") +
          "Valeurs aberrantes exclues (< 200 ou > 25 000 €/m²).",
      });
    }
    const years = [...new Set(c.dvf.stats.map((s) => s.year))];
    charts.push({
      id: "chart_dvf",
      title: `Prix médian au m² des logements vendus à ${commune.nom}`,
      type: "line",
      xKey: "annee",
      data: years.map((y) => ({
        annee: y,
        appartement: c.dvf!.stats.find((s) => s.year === y && s.type === "Appartement" && s.count >= 10)?.median ?? null,
        maison: c.dvf!.stats.find((s) => s.year === y && s.type === "Maison" && s.count >= 10)?.median ?? null,
      })),
      series: [
        { key: "appartement", label: "Appartements" },
        { key: "maison", label: "Maisons" },
      ],
      unit: "€/m²",
      sources: [c.dvf.source],
      note: "Années avec moins de 10 ventes non représentées. L'année en cours peut être partielle.",
    });
    tables.push({
      id: "table_dvf",
      title: "Ventes de logements (DVF) par année et type de bien",
      theme: "immobilier",
      columns: [
        { key: "annee", label: "Année" },
        { key: "type", label: "Type" },
        { key: "ventes", label: "Ventes retenues", align: "right" },
        { key: "q1", label: "1er quartile (€/m²)", align: "right", unit: "€/m²" },
        { key: "mediane", label: "Médiane (€/m²)", align: "right", unit: "€/m²" },
        { key: "q3", label: "3e quartile (€/m²)", align: "right", unit: "€/m²" },
        { key: "prix", label: "Prix médian (€)", align: "right", unit: "€" },
      ],
      rows: c.dvf.stats.map((s) => ({ annee: s.year, type: s.type, ventes: s.count, q1: Math.round(s.q1), mediane: Math.round(s.median), q3: Math.round(s.q3), prix: Math.round(s.medianPrice) })),
      sources: [c.dvf.source],
      note: "Ventes d'un seul logement (avec ou sans dépendances) ; mutations multi-logements exclues.",
    });
  }

  /* ------------------------------------------------ équipements OSM */
  if (c.equipments) {
    const counts = CATEGORIES.map((cat) => ({ cat, n: c.equipments!.features.filter((f) => f.properties?.category === cat.id).length }));
    for (const { cat, n } of counts) {
      indicators.push({
        id: "osm_" + cat.id,
        label: `${cat.label} (OpenStreetMap)`,
        theme: cat.group === "sante" ? "sante" : cat.group === "education" || cat.group === "enfance" ? "education" : cat.group === "transport" ? "mobilite" : "equipements",
        value: n,
        unit: "nombre",
        geo: geos.commune,
        source: c.equipments.source,
        status: "ok",
        limits: "Recensement contributif : une valeur nulle peut traduire une lacune de la base.",
      });
    }
    tables.push({
      id: "table_equipements",
      title: `Équipements et services recensés dans OpenStreetMap à ${commune.nom}`,
      theme: "equipements",
      columns: [
        { key: "groupe", label: "Domaine" },
        { key: "categorie", label: "Catégorie" },
        { key: "nombre", label: "Nombre", align: "right" },
        { key: "pour10k", label: "Pour 10 000 hab.", align: "right" },
      ],
      // Avec la BPE, les catégories absentes d'OSM (valeur 0) ne sont pas affichées : la BPE fait foi.
      rows: counts.filter(({ n }) => !c.bpe || n > 0).map(({ cat, n }) => ({
        groupe: GROUP_LABELS[cat.group],
        categorie: cat.label,
        nombre: n,
        pour10k: commune.population ? Math.round((n / commune.population) * 100000) / 10 : null,
      })),
      sources: [c.equipments.source, c.popSource],
      note: `OpenStreetMap est une base contributive : l'absence d'un équipement dans la base ne prouve pas son absence sur le terrain.${c.bpe ? " Catégories sans objet dans OpenStreetMap non affichées : voir le tableau de la Base permanente des équipements, qui fait référence." : ""}`,
    });
    const groups = Object.keys(GROUP_LABELS) as (keyof typeof GROUP_LABELS)[];
    charts.push({
      id: "chart_equipements",
      title: "Équipements recensés par domaine (OpenStreetMap)",
      type: "hbar",
      xKey: "domaine",
      data: groups.map((g) => ({ domaine: GROUP_LABELS[g], nombre: counts.filter((x) => x.cat.group === g && x.cat.id !== "arret_bus").reduce((s, x) => s + x.n, 0) })),
      series: [{ key: "nombre", label: "Nombre d'équipements" }],
      unit: "nombre",
      sources: [c.equipments.source],
      note: "Arrêts de bus exclus du décompte « Transports ».",
    });
  }
  /* Base permanente des équipements (INSEE) : référence pour les comptages. */
  if (c.bpe) {
    const popCom = commune.population ?? null;
    const popDep = c.populations.find((p) => p.geo.level === "departement")?.value ?? null;
    const comCounts: Record<string, number> = {};
    for (const e of c.bpe.commune) comCounts[e.type] = (comCounts[e.type] ?? 0) + 1;
    const per10k = (n: number, pop: number | null) => (pop ? Math.round((n / pop) * 100000) / 10 : null);
    const GROUPS: Record<string, string> = { sante: "Santé", public: "Services publics", commerce: "Commerces", education: "Enseignement", securite: "Sécurité", transport: "Transports", culture: "Sports et culture" };
    const rows: Record<string, string | number | null>[] = [];
    for (const [code, t] of Object.entries(BPE_TYPES)) {
      const n = comCounts[code] ?? 0;
      const nd = c.bpe.countsDep[code] ?? 0;
      indicators.push({
        id: `bpe_${code}`,
        label: `${t.label} (BPE)`,
        theme: t.group === "sante" ? "sante" : t.group === "education" ? "education" : "equipements",
        value: n,
        unit: "nombre",
        geo: geos.commune,
        source: c.bpe.source,
        year: BPE_VINTAGE,
        status: "ok",
      });
      indicators.push({ id: `bpe_${code}_10k`, label: `${t.label} pour 10 000 habitants (BPE)`, theme: t.group === "sante" ? "sante" : "equipements", value: per10k(n, popCom), unit: "nombre", geo: geos.commune, source: c.bpe.source, year: BPE_VINTAGE, status: popCom ? "ok" : "missing" });
      indicators.push({ id: `bpe_${code}_10k`, label: `${t.label} pour 10 000 habitants (BPE)`, theme: t.group === "sante" ? "sante" : "equipements", value: per10k(nd, popDep), unit: "nombre", geo: geos.departement, source: c.bpe.source, year: BPE_VINTAGE, status: popDep ? "ok" : "missing" });
      if (!n && !nd) continue;
      rows.push({ groupe: GROUPS[t.group], type: t.label, nombre: n, pour10k: per10k(n, popCom), dep10k: per10k(nd, popDep) });
    }
    tables.push({
      id: "table_bpe",
      title: `Équipements et services de ${commune.nom} (Base permanente des équipements ${BPE_VINTAGE})`,
      theme: "equipements",
      columns: [
        { key: "groupe", label: "Domaine" },
        { key: "type", label: "Équipement", wide: true },
        { key: "nombre", label: "Nombre", align: "right" },
        { key: "pour10k", label: "Pour 10 000 hab.", align: "right" },
        { key: "dep10k", label: "Département (pour 10 000 hab.)", align: "right" },
      ],
      rows,
      sources: [c.bpe.source, c.popSource],
      note: "Base permanente des équipements de l'INSEE : équipements au 1er janvier. Un professionnel exerçant dans plusieurs lieux peut être compté plusieurs fois ; la BPE ne mesure ni la disponibilité ni les délais.",
    });
  }

  if (c.cycleways) {
    const km = c.cycleways.lines.reduce((s, l) => s + turf.length(l, { units: "kilometers" }), 0);
    indicators.push({
      id: "km_amenagements_cyclables",
      label: "Linéaire d'aménagements cyclables (OpenStreetMap)",
      theme: "mobilite",
      value: km,
      unit: "km",
      geo: geos.commune,
      source: c.cycleways.source,
      status: "ok",
      method: "Somme des longueurs des voies `highway=cycleway` et des voies avec bande ou piste cyclable.",
      limits: "Une voie avec aménagement des deux côtés n'est comptée qu'une fois ; couverture OSM variable.",
    });
  }

  /* ------------------------------------------------ écoles */
  if (c.schools) {
    const sc = c.schools.schools;
    const byType = new Map<string, { n: number; pub: number; eleves: number; withEleves: number; ep: number }>();
    for (const s of sc) {
      const t = (s.type || "Autre").replace(/^Ecole/, "École");
      const v = byType.get(t) ?? { n: 0, pub: 0, eleves: 0, withEleves: 0, ep: 0 };
      v.n++;
      if (/public/i.test(s.statut)) v.pub++;
      if (s.eleves != null && s.eleves > 0) {
        v.eleves += s.eleves;
        v.withEleves++;
      }
      if (s.priorite && !/^non$/i.test(s.priorite) && s.priorite !== "") v.ep++;
      byType.set(t, v);
    }
    const anyEleves = [...byType.values()].some((v) => v.withEleves > 0);
    indicators.push({ id: "nb_etablissements_scolaires", label: "Établissements scolaires ouverts", theme: "education", value: sc.length, unit: "nombre", geo: geos.commune, source: c.schools.source, status: "ok" });
    tables.push({
      id: "table_ecoles",
      title: `Établissements scolaires à ${commune.nom}`,
      theme: "education",
      columns: [
        { key: "type", label: "Type" },
        { key: "n", label: "Établissements", align: "right" },
        { key: "pub", label: "dont publics", align: "right" },
        { key: "ep", label: "dont éducation prioritaire", align: "right" },
        ...(anyEleves ? [{ key: "eleves", label: "Élèves (si renseigné)", align: "right" as const }] : []),
      ],
      rows: [...byType.entries()].map(([type, v]) => ({ type, n: v.n, pub: v.pub, ep: v.ep, eleves: v.withEleves ? v.eleves : null })),
      sources: [c.schools.source],
      note: anyEleves ? "Effectifs renseignés pour une partie des établissements seulement." : "Effectifs d'élèves non renseignés dans l'annuaire pour cette commune.",
    });
  }

  /* ------------------------------------------------ gares */
  if (c.stations) {
    const rows = c.stations.stations.map((s) => {
      const last = s.frequentation[s.frequentation.length - 1];
      const first = s.frequentation[0];
      return {
        gare: s.nom,
        segment: s.segment || null,
        annee: last?.year ?? null,
        voyageurs: last?.voyageurs ?? null,
        evolution: first && last && first.year !== last.year && first.voyageurs ? Math.round(((last.voyageurs - first.voyageurs) / first.voyageurs) * 1000) / 10 : null,
        periode: first && last && first.year !== last.year ? `${first.year}-${last.year}` : null,
      };
    });
    tables.push({
      id: "table_gares",
      title: "Gares de voyageurs de la commune",
      theme: "mobilite",
      columns: [
        { key: "gare", label: "Gare" },
        { key: "segment", label: "Segment DRG" },
        { key: "annee", label: "Année" },
        { key: "voyageurs", label: "Voyageurs annuels", align: "right" },
        { key: "evolution", label: "Évolution (%)", align: "right", unit: "%" },
        { key: "periode", label: "Période" },
      ],
      rows,
      sources: [c.stations.source],
      note: "Segment DRG : a = gares nationales, b = gares régionales, c = gares locales.",
    });
    const tot = rows.reduce((s, r) => s + (r.voyageurs ?? 0), 0);
    indicators.push({ id: "nb_gares", label: "Gares de voyageurs", theme: "mobilite", value: c.stations.stations.length, unit: "nombre", geo: geos.commune, source: c.stations.source, status: "ok" });
    if (tot > 0)
      indicators.push({ id: "voyageurs_gares", label: "Fréquentation annuelle des gares (voyageurs)", theme: "mobilite", value: tot, unit: "nombre", year: rows.find((r) => r.annee)?.annee ?? undefined, geo: geos.commune, source: c.stations.source, status: "ok" });
  }

  /* ------------------------------------------------ entreprises */
  if (c.entreprises) {
    const tot = c.entreprises.bySection.reduce((s, x) => s + x.count, 0);
    indicators.push({
      id: "unites_legales_actives",
      label: "Unités légales actives ayant un établissement dans la commune",
      theme: "economie",
      value: tot,
      unit: "établissements",
      geo: geos.commune,
      source: c.entreprises.source,
      status: c.entreprises.bySection.length === Object.keys(SECTIONS_NAF).length ? "ok" : "partial",
      method: "Somme, par section NAF, du nombre d'unités légales actives ayant au moins un établissement dans la commune.",
      limits: "Comprend les entreprises individuelles et micro-entreprises ; ne mesure pas l'emploi.",
    });
    charts.push({
      id: "chart_sections",
      title: "Unités légales actives par secteur d'activité (sections NAF)",
      type: "hbar",
      xKey: "secteur",
      data: c.entreprises.bySection.filter((s) => s.count > 0).sort((a, b) => b.count - a.count).map((s) => ({ secteur: s.label, nombre: s.count })),
      series: [{ key: "nombre", label: "Unités légales" }],
      unit: "nombre",
      sources: [c.entreprises.source],
    });
    tables.push({
      id: "table_employeurs",
      title: "Établissements de 100 salariés et plus (tranche d'effectif déclarée)",
      theme: "economie",
      columns: [
        { key: "nom", label: "Établissement" },
        { key: "activite", label: "Code APE" },
        { key: "tranche", label: "Tranche d'effectif" },
        { key: "siret", label: "SIRET" },
      ],
      rows: c.entreprises.employers.slice(0, 30).map((e) => ({ nom: e.nom, activite: e.activite, tranche: e.trancheLabel, siret: e.siret })),
      sources: [c.entreprises.source],
      note: "Tranches d'effectifs issues de SIRENE, déclaratives et parfois anciennes : à confirmer localement.",
    });
  }

  /* ------------------------------------------------ risques */
  if (c.risques) {
    const r = c.risques.data;
    indicators.push({ id: "nb_catnat", label: "Arrêtés de catastrophe naturelle", theme: "risques", value: r.catnat.length, unit: "nombre", geo: geos.commune, source: c.risques.source, status: "ok", method: "Nombre d'arrêtés CatNat recensés dans GASPAR depuis 1982." });
    indicators.push({ id: "nb_risques", label: "Risques recensés (GASPAR)", theme: "risques", value: r.risques.length, unit: "nombre", geo: geos.commune, source: c.risques.source, status: "ok" });
    if (r.icpe.length || r.urls.some((u) => u.includes("installations_classees")))
      indicators.push({ id: "nb_icpe", label: "Installations classées (ICPE) recensées", theme: "risques", value: r.icpe.length, unit: "nombre", geo: geos.commune, source: c.risques.source, status: "ok", limits: "Limité aux 100 premières installations renvoyées par l'API." });
    const byType = new Map<string, { n: number; last: string }>();
    for (const x of r.catnat) {
      const v = byType.get(x.libelle) ?? { n: 0, last: "" };
      v.n++;
      if (x.debut > v.last) v.last = x.debut;
      byType.set(x.libelle, v);
    }
    tables.push({
      id: "table_risques",
      title: "Risques recensés et arrêtés de catastrophe naturelle",
      theme: "risques",
      columns: [
        { key: "type", label: "Risque" },
        { key: "arretes", label: "Arrêtés CatNat", align: "right" },
        { key: "dernier", label: "Dernier événement" },
      ],
      rows: [
        ...r.risques.map((x) => ({ type: x, arretes: null, dernier: null })),
        ...[...byType.entries()].map(([type, v]) => ({ type: `CatNat — ${type}`, arretes: v.n, dernier: v.last.slice(0, 10) })),
        ...(r.sismicite ? [{ type: `Zone de sismicité : ${r.sismicite}`, arretes: null, dernier: null }] : []),
        ...(r.radon ? [{ type: `Potentiel radon : ${r.radon}`, arretes: null, dernier: null }] : []),
      ],
      sources: [c.risques.source],
    });
  }

  /* ------------------------------------------------ élections */
  const elecRows: Record<string, string | number | null>[] = [];
  for (const e of c.elections) {
    for (const r of e.results) {
      const g = r.level === "commune" ? geos.commune : geos.departement;
      const part = r.inscrits ? (100 * r.votants) / r.inscrits : null;
      indicators.push({
        id: `participation_${r.election.id}`,
        label: `Participation — ${r.election.label}`,
        theme: "elections",
        value: part,
        unit: "%",
        year: r.election.date.slice(0, 4),
        geo: g,
        source: e.source,
        status: part == null ? "missing" : "ok",
        method: "Votants / inscrits × 100.",
        numerator: r.votants,
        denominator: r.inscrits,
      });
      elecRows.push({
        scrutin: r.election.label,
        territoire: g.name,
        inscrits: r.inscrits,
        participation: part != null ? Math.round(part * 10) / 10 : null,
        abstention: r.inscrits ? Math.round(((100 * r.abstentions) / r.inscrits) * 10) / 10 : null,
        blancs_nuls: r.blancs != null && r.nuls != null && r.votants ? Math.round(((100 * (r.blancs + r.nuls)) / r.votants) * 10) / 10 : null,
      });
    }
    const com = e.results.find((r) => r.level === "commune");
    const dep = e.results.find((r) => r.level === "departement");
    if (com && com.exprimes > 0) {
      const top = com.candidates.slice(0, 8);
      tables.push({
        id: `table_elec_${com.election.id}`,
        title: `${com.election.label} — résultats agrégés (en % des suffrages exprimés)`,
        theme: "elections",
        columns: [
          { key: "liste", label: "Liste / candidat / nuance" },
          { key: "commune", label: commune.nom, align: "right", unit: "%" },
          { key: "departement", label: geos.departement.name, align: "right", unit: "%" },
          { key: "voix", label: "Voix (commune)", align: "right" },
        ],
        rows: top.map((t) => ({
          liste: t.label,
          commune: Math.round(((100 * t.voix) / com.exprimes) * 10) / 10,
          departement: dep && dep.exprimes ? Math.round(((100 * (dep.candidates.find((x) => x.label === t.label)?.voix ?? NaN)) / dep.exprimes) * 10) / 10 : null,
          voix: t.voix,
        })),
        sources: [e.source],
        note: "Résultats officiels agrégés, présentés à titre descriptif. Les 8 premières listes ou nuances de la commune sont affichées.",
      });
    }
  }
  if (elecRows.length) {
    tables.push({
      id: "table_participation",
      title: "Participation électorale (résultats officiels agrégés)",
      theme: "elections",
      columns: [
        { key: "scrutin", label: "Scrutin" },
        { key: "territoire", label: "Territoire" },
        { key: "inscrits", label: "Inscrits", align: "right" },
        { key: "participation", label: "Participation (%)", align: "right", unit: "%" },
        { key: "abstention", label: "Abstention (% inscrits)", align: "right", unit: "%" },
        { key: "blancs_nuls", label: "Blancs et nuls (% votants)", align: "right", unit: "%" },
      ],
      rows: elecRows,
      sources: c.elections.map((e) => e.source),
    });
    charts.push({
      id: "chart_participation",
      title: "Participation par scrutin",
      type: "bar",
      xKey: "scrutin",
      data: c.elections.map((e) => {
        const com = e.results.find((r) => r.level === "commune");
        const dep = e.results.find((r) => r.level === "departement");
        return {
          scrutin: e.results[0].election.label,
          commune: com && com.inscrits ? Math.round((1000 * com.votants) / com.inscrits) / 10 : null,
          departement: dep && dep.inscrits ? Math.round((1000 * dep.votants) / dep.inscrits) / 10 : null,
        };
      }),
      series: [
        { key: "commune", label: commune.nom },
        { key: "departement", label: geos.departement.name },
      ],
      unit: "%",
      sources: c.elections.map((e) => e.source),
    });
  }

  /* ------------------------------------------------ tableau des comparaisons */
  const COMPARE_IDS = [
    "pop_municipale",
    "densite",
    "evol_pop_annuelle",
    "part_moins_25",
    "part_moins_30",
    "part_60_plus",
    "part_65_plus",
    "part_75_plus",
    "part_80_plus",
    "part_personnes_seules",
    "part_menages_sans_voiture",
    "part_menages_2_voitures",
    "part_actifs_travaillant_commune",
    "part_trajets_voiture",
    "part_trajets_tc",
    "revenu_median",
    "taux_pauvrete",
    "rapport_interdecile",
    "taux_emploi",
    "taux_chomage_rp",
    "concentration_emploi",
    "part_sans_diplome",
    "part_diplome_superieur",
    "part_residences_principales",
    "part_residences_secondaires",
    "part_logements_vacants",
    "part_maisons",
    "part_proprietaires",
    "part_locataires_prives",
    "part_locataires_hlm",
  ];
  const refGeos = levelOrder.map((l) => (l === "commune" ? geos.commune : l === "epci" ? geos.epci : l === "departement" ? geos.departement : l === "region" ? geos.region : geos.france)).filter(Boolean) as GeoRef[];
  const compRows = COMPARE_IDS.map((id) => {
    const forGeo = (g: GeoRef) => indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code);
    const base = refGeos.map(forGeo).find(Boolean);
    if (!base) return null;
    const row: Record<string, string | number | null> = { indicateur: base.label, unite: base.unit, annee: forGeo(geos.commune)?.year ?? base.year ?? null };
    for (const g of refGeos) row[g.level] = forGeo(g)?.value ?? null;
    return row;
  }).filter((r): r is Record<string, string | number | null> => !!r);
  if (compRows.length)
    tables.push({
      id: "table_comparaison",
      title: "Indicateurs clés et territoires de référence",
      theme: "identite",
      columns: [
        { key: "indicateur", label: "Indicateur" },
        { key: "annee", label: "Millésime" },
        ...refGeos.map((g) => ({ key: g.level, label: g.name, align: "right" as const })),
      ],
      rows: compRows,
      sources: [...new Map(indicators.map((i) => [i.source.id + i.source.dataset, i.source])).values()],
      note: "n.d. : donnée non disponible (non diffusée, non collectée ou source indisponible). Les unités figurent dans le libellé de chaque ligne.",
    });

  /* ------------------------------------------------ séries / graphiques INSEE */
  const popHist = series.filter((s) => s.id === "pop_historique");
  const comHist = popHist.find((s) => s.geo.level === "commune");
  if (comHist) {
    charts.push({
      id: "chart_pop_historique",
      title: `Évolution de la population municipale de ${commune.nom}`,
      type: "line",
      xKey: "annee",
      data: comHist.points.map((p) => ({ annee: p.x, population: p.y })),
      series: [{ key: "population", label: "Population municipale" }],
      unit: "habitants",
      sources: [comHist.source],
      note: comHist.note,
    });
    const depHist = popHist.find((s) => s.geo.level === "departement");
    if (depHist) {
      const base = comHist.points.find((p) => p.y && depHist.points.some((q) => q.x === p.x && q.y));
      if (base) {
        const dBase = depHist.points.find((q) => q.x === base.x)!.y!;
        charts.push({
          id: "chart_pop_indice",
          title: `Évolution comparée de la population (indice base 100 en ${base.x})`,
          type: "line",
          xKey: "annee",
          data: comHist.points
            .filter((p) => p.x >= base.x)
            .map((p) => {
              const d = depHist.points.find((q) => q.x === p.x)?.y;
              return { annee: p.x, commune: p.y ? Math.round((1000 * p.y) / base.y!) / 10 : null, departement: d ? Math.round((1000 * d) / dBase) / 10 : null };
            }),
          series: [
            { key: "commune", label: commune.nom },
            { key: "departement", label: geos.departement.name },
          ],
          unit: "nombre",
          sources: [comHist.source, depHist.source],
        });
      }
    }
  }
  const comInsee = c.insee.find((x) => x.geo.level === "commune")?.result;
  const frInsee = c.insee.find((x) => x.geo.level === "france")?.result ?? c.insee.find((x) => x.geo.level === "departement")?.result;
  if (comInsee?.ages) {
    const refAges = frInsee?.ages;
    charts.push({
      id: "chart_ages",
      title: `Répartition de la population par âge (${comInsee.agesYear})`,
      type: "bar",
      xKey: "age",
      data: comInsee.ages.map((a) => ({
        age: a.label,
        commune: Math.round(a.share * 10) / 10,
        reference: refAges?.find((r) => r.label === a.label) ? Math.round(refAges.find((r) => r.label === a.label)!.share * 10) / 10 : null,
      })),
      series: [
        { key: "commune", label: commune.nom },
        ...(refAges ? [{ key: "reference", label: frInsee === c.insee.find((x) => x.geo.level === "france")?.result ? "France" : geos.departement.name }] : []),
      ],
      unit: "%",
      sources: [comInsee.agesSource!],
    });
  }
  if (comInsee?.agesBySex) {
    charts.push({
      id: "chart_pyramide",
      title: `Pyramide des âges de ${commune.nom} (${comInsee.agesYear})`,
      type: "pyramid",
      xKey: "age",
      data: comInsee.agesBySex.map((a) => ({ age: a.label, hommes: a.hommes, femmes: a.femmes })),
      series: [
        { key: "hommes", label: "Hommes" },
        { key: "femmes", label: "Femmes" },
      ],
      unit: "habitants",
      sources: [comInsee.agesSource!],
    });
  }
  for (const d of comInsee?.distributions ?? []) {
    const ref = c.insee.find((x) => x.geo.level === "departement")?.result.distributions.find((x) => x.id === d.id);
    charts.push({
      id: "chart_" + d.id,
      title: `${d.label} (${d.year})`,
      type: "hbar",
      xKey: "modalite",
      data: d.items.map((i) => ({
        modalite: i.label,
        commune: Math.round(i.share * 10) / 10,
        departement: ref ? Math.round((ref.items.find((r) => r.code === i.code)?.share ?? NaN) * 10) / 10 || null : null,
      })),
      series: [{ key: "commune", label: commune.nom }, ...(ref ? [{ key: "departement", label: geos.departement.name }] : [])],
      unit: "%",
      sources: [d.source],
    });
  }

  /* ------------------------------------------------ communes du périmètre */
  const perimeterRows = (c.query.scope === "custom" ? c.perimeter.communes : commune.epci ? referentiel().epcis.find((e) => e.code === commune.epci!.code)?.membres.map((m) => ({ code: m.code, nom: m.nom, population: referentiel().byCode.get(m.code)?.population ?? null })) ?? [] : []).map((m) => {
    const feat = c.depFeatures?.features.find((f) => (f.properties as { code: string }).code === m.code);
    const sur = (feat?.properties as { surface?: number } | undefined)?.surface;
    const ins = c.perimeterInsee.find((p) => p.code === m.code)?.result;
    const val = (id: string) => ins?.indicators.find((i) => i.id === id)?.value ?? null;
    return {
      code: m.code,
      commune: m.nom,
      population: m.population,
      densite: sur ? Math.round((m.population ?? 0) / (sur / 100)) : null,
      revenu: val("revenu_median") != null ? Math.round(val("revenu_median")!) : null,
      pauvrete: val("taux_pauvrete"),
      vacance: val("part_logements_vacants") != null ? Math.round(val("part_logements_vacants")! * 10) / 10 : null,
    };
  });
  if (perimeterRows.length > 1) {
    perimeterRows.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    tables.push({
      id: "table_perimetre",
      title: c.query.scope === "custom" ? "Communes du territoire personnalisé" : `Communes de l'intercommunalité (${geos.epci?.name})`,
      theme: "identite",
      // Grandes intercommunalités (Métropole du Grand Paris : 130 communes) : les 20 plus peuplées
      // et la commune étudiée ; colonnes sans aucune donnée retirées.
      columns: [
        { key: "commune", label: "Commune" },
        { key: "code", label: "Code INSEE" },
        { key: "population", label: "Population", align: "right" as const, unit: "habitants" as const },
        { key: "densite", label: "Densité (hab./km²)", align: "right" as const },
        { key: "revenu", label: "Revenu médian (€/UC)", align: "right" as const, unit: "€" as const },
        { key: "pauvrete", label: "Taux de pauvreté (%)", align: "right" as const, unit: "%" as const },
        { key: "vacance", label: "Logements vacants (%)", align: "right" as const, unit: "%" as const },
      ].filter((col) => {
        if (["commune", "code", "population"].includes(col.key)) return true;
        const n = perimeterRows.filter((r) => r[col.key as keyof (typeof perimeterRows)[number]] != null).length;
        // Densité : surfaces connues seulement dans le département ; colonne retirée si elle manque pour beaucoup de communes.
        return col.key === "densite" ? n >= perimeterRows.length * 0.8 : n > 0;
      }),
      rows: perimeterRows.length > 25 ? perimeterRows.filter((r, i) => i < 20 || r.code === commune.code) : perimeterRows,
      highlight: (perimeterRows.length > 25 ? perimeterRows.filter((r, i) => i < 20 || r.code === commune.code) : perimeterRows).map((r, i) => (r.code === commune.code ? i : -1)).filter((i) => i >= 0),
      sources: [c.popSource, ...(c.geoSource ? [c.geoSource] : []), ...(c.perimeterInsee[0]?.result.indicators[0] ? [c.perimeterInsee[0].result.indicators[0].source] : [])],
      note: `${perimeterRows.length > 25 ? `20 communes les plus peuplées sur ${perimeterRows.length}, et ${commune.nom}. ` : ""}Revenus et pauvreté : non diffusés pour les communes soumises au secret statistique.`,
    });
    charts.push({
      id: "chart_perimetre_pop",
      title: "Population des communes du périmètre",
      type: "hbar",
      xKey: "commune",
      data: perimeterRows.slice(0, 25).map((r) => ({ commune: r.commune, population: r.population })),
      series: [{ key: "population", label: "Population municipale" }],
      unit: "habitants",
      sources: [c.popSource],
      note: perimeterRows.length > 25 ? `25 communes les plus peuplées sur ${perimeterRows.length}.` : undefined,
    });
    if (perimeterRows.some((r) => r.revenu != null))
      charts.push({
        id: "chart_perimetre_revenu",
        title: "Revenu disponible médian par unité de consommation, communes du périmètre",
        type: "hbar",
        xKey: "commune",
        data: perimeterRows.filter((r) => r.revenu != null).sort((a, b) => b.revenu! - a.revenu!).map((r) => ({ commune: r.commune, revenu: r.revenu })),
        series: [{ key: "revenu", label: "Revenu médian (€)" }],
        unit: "€",
        sources: c.perimeterInsee.slice(0, 1).flatMap((p) => p.result.indicators.filter((i) => i.id === "revenu_median").map((i) => i.source)),
        note: "Communes soumises au secret statistique non représentées.",
      });
  }

  /* ------------------------------------------------ voisins, pôles, comparables */
  if (c.neighbours.length)
    tables.push({
      id: "table_voisins",
      title: "Communes limitrophes (même département)",
      theme: "identite",
      columns: [
        { key: "commune", label: "Commune" },
        { key: "population", label: "Population", align: "right", unit: "habitants" },
        { key: "surface", label: "Superficie (km²)", align: "right" },
      ],
      rows: c.neighbours.map((n) => ({ commune: n.nom, population: n.population, surface: n.surfaceKm2 != null ? Math.round(n.surfaceKm2 * 10) / 10 : null })),
      sources: c.geoSource ? [c.geoSource] : [],
      note: "Contiguïté calculée par intersection des contours ADMIN EXPRESS ; les communes limitrophes situées dans un autre département ne sont pas listées.",
    });
  if (c.poles.length)
    tables.push({
      id: "table_poles",
      title: "Pôles urbains de 20 000 habitants et plus dans un rayon de 80 km",
      theme: "mobilite",
      columns: [
        { key: "commune", label: "Commune" },
        { key: "population", label: "Population", align: "right", unit: "habitants" },
        { key: "distance", label: "Distance à vol d'oiseau (km)", align: "right" },
      ],
      rows: c.poles.map((p) => ({ commune: p.nom, population: p.population, distance: Math.round(p.distanceKm * 10) / 10 })),
      sources: c.polesSource ? [c.polesSource] : [],
      note: "Distances entre centres communaux, sans prise en compte du réseau de transport.",
    });
  if (c.nearest?.length)
    tables.push({
      id: "table_acces",
      title: "Équipements structurants les plus proches",
      theme: "mobilite",
      columns: [
        { key: "type", label: "Équipement" },
        { key: "nom", label: "Nom" },
        { key: "distance", label: "Distance à vol d'oiseau (km)", align: "right" },
      ],
      rows: c.nearest.map((n) => ({ type: n.label, nom: n.name, distance: Math.round(n.distanceKm * 10) / 10 })),
      sources: [c.nearestSource!],
      note: `Recherche dans un rayon de 30 km dans OpenStreetMap ; distances à vol d'oiseau depuis le centre de la commune.${c.routes?.routes.length ? " Temps de trajet routiers : voir « Temps de trajet et desserte ferroviaire »." : ""}`,
    });
  if (c.comparables.length) {
    const val = (r: (typeof c.comparables)[number]["result"], id: string) => r?.indicators.find((i) => i.id === id)?.value ?? null;
    const comVal = (id: string) => indicators.find((i) => i.id === id && i.geo.level === "commune")?.value ?? null;
    tables.push({
      id: "table_comparables",
      title: "Communes comparables (taille et densité proches)",
      theme: "identite",
      columns: [
        { key: "commune", label: "Commune" },
        { key: "dep", label: "Dép." },
        { key: "population", label: "Population", align: "right", unit: "habitants" },
        { key: "densite", label: "Densité (hab./km²)", align: "right" },
        { key: "revenu", label: "Revenu médian (€/UC)", align: "right", unit: "€" },
        { key: "pauvrete", label: "Pauvreté (%)", align: "right", unit: "%" },
        { key: "chomage", label: "Chômage RP (%)", align: "right", unit: "%" },
        { key: "vacance", label: "Vacance (%)", align: "right", unit: "%" },
      ],
      rows: [
        {
          commune: `${commune.nom} (territoire étudié)`,
          dep: commune.departement.code,
          population: commune.population,
          densite: comVal("densite") != null ? Math.round(comVal("densite")!) : null,
          revenu: comVal("revenu_median"),
          pauvrete: comVal("taux_pauvrete"),
          chomage: comVal("taux_chomage_rp"),
          vacance: comVal("part_logements_vacants"),
        },
        ...c.comparables.map((x) => ({
          commune: x.nom,
          dep: x.departement,
          population: x.population,
          densite: x.densite != null ? Math.round(x.densite) : null,
          revenu: val(x.result, "revenu_median"),
          pauvrete: val(x.result, "taux_pauvrete"),
          chomage: val(x.result, "taux_chomage_rp"),
          vacance: val(x.result, "part_logements_vacants"),
        })),
      ],
      sources: [c.popSource, ...(c.polesSource ? [c.polesSource] : [])],
      note: c.comparablesScope?.startsWith("arrondissements")
        ? "Sélection : arrondissements de Paris, Lyon et Marseille dont la population est à ±50 % de celle de l'arrondissement."
        : c.comparables.some((x) => x.densite != null)
          ? c.comparablesScope
            ? `Sélection : la région comptant moins de 5 communes proches, la recherche a été élargie (${c.comparablesScope}) aux communes dont la population est à ±20 % et la densité comprise entre la moitié et le double de celle de la commune.`
            : "Sélection : communes de la même région dont la population est à ±30 % et la densité comprise entre la moitié et le double de celle de la commune."
          : "Sélection sur le seul critère de population (±30 %, même région) : les densités n'ont pas pu être calculées lors de la génération.",
    });
  }

  /* ------------------------------------------------ cartes */
  if (c.depFeatures) {
    const dep = simplify(c.depFeatures, 0.0015);
    const epciCodes = commune.epci ? new Set(referentiel().epcis.find((e) => e.code === commune.epci!.code)?.membres.map((m) => m.code)) : new Set<string>();
    const props = (f: GeoJSON.Feature) => f.properties as { code: string; nom: string; population?: number; surface?: number; codeEpci?: string };
    const geoSrc = c.geoSource!;
    const withProps = (extra: (f: GeoJSON.Feature) => Record<string, unknown>): GeoJSON.FeatureCollection => ({
      type: "FeatureCollection",
      features: dep.features.map((f) => ({ ...f, properties: { code: props(f).code, nom: props(f).nom, ...extra(f) } })),
    });
    const communeFc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: dep.features.filter((f) => props(f).code === commune.code).map((f) => ({ ...f, properties: { code: commune.code, nom: commune.nom } })),
    };
    const bbox = turf.bbox(dep) as [number, number, number, number];
    const localBbox = communeFc.features.length
      ? (turf.bbox(turf.buffer(communeFc, 1.5, { units: "kilometers" })!) as [number, number, number, number])
      : bbox;

    maps.push({
      id: "map_localisation",
      title: `Localisation de ${commune.nom} et de son intercommunalité dans le département (${geos.departement.name})`,
      theme: "identite",
      bbox,
      layers: [
        { id: "communes", label: "Communes du département", kind: "polygons", data: withProps((f) => ({ population: props(f).population ?? null, epci: epciCodes.has(props(f).code) ? 1 : 0 })), color: "#e5e7eb", visible: true, source: geoSrc },
        { id: "epci", label: `Intercommunalité (${geos.epci?.name ?? "—"})`, kind: "polygons", data: { type: "FeatureCollection", features: withProps(() => ({})).features.filter((f) => epciCodes.has((f.properties as { code: string }).code)) }, color: "#86b6ef", visible: true, source: geoSrc },
        { id: "commune", label: commune.nom, kind: "polygons", data: communeFc, color: "#1c5cab", visible: true, source: geoSrc },
      ],
      legend: { title: "Légende", categories: [{ label: commune.nom, color: "#1c5cab" }, { label: geos.epci?.name ?? "Intercommunalité", color: "#86b6ef" }, { label: "Autres communes du département", color: "#e5e7eb" }] },
    });

    // Densité
    const dens = dep.features.map((f) => density(props(f).population ?? null, props(f).surface ? props(f).surface! / 100 : null));
    const breaks = quantileBreaks(dens.filter((x): x is number => x != null), 5);
    const legend = legendFromBreaks("Densité de population", "hab/km²", breaks);
    maps.push({
      id: "map_densite",
      title: `Densité de population par commune (${geos.departement.name})`,
      theme: "demographie",
      bbox,
      layers: [
        { id: "densite", label: "Densité (hab./km²)", kind: "polygons", data: withProps((f) => ({ densite: density(props(f).population ?? null, props(f).surface ? props(f).surface! / 100 : null) })), valueProperty: "densite", visible: true, source: geoSrc },
        { id: "commune", label: commune.nom, kind: "polygons", data: communeFc, color: "#eb6834", outlineOnly: true, visible: true, source: geoSrc },
      ],
      legend,
      note: "Discrétisation par quantiles (5 classes).",
    });

    // Revenus (périmètre)
    const rev = new Map(c.perimeterInsee.map((p) => [p.code, p.result.indicators.find((i) => i.id === "revenu_median")?.value ?? null]));
    if ([...rev.values()].some((v) => v != null)) {
      const rb = quantileBreaks([...rev.values()].filter((x): x is number => x != null), Math.min(5, [...rev.values()].filter((x) => x != null).length));
      const perim = new Set(c.perimeterInsee.map((p) => p.code));
      const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: withProps((f) => ({ revenu: rev.get(props(f).code) ?? null })).features.filter((f) => perim.has((f.properties as { code: string }).code)) };
      maps.push({
        id: "map_revenus",
        title: "Revenu disponible médian par unité de consommation (communes du périmètre)",
        theme: "revenus",
        bbox: fc.features.length ? (turf.bbox(fc) as [number, number, number, number]) : bbox,
        layers: [
          { id: "revenu", label: "Revenu médian (€/UC)", kind: "polygons", data: fc, valueProperty: "revenu", visible: true, source: c.perimeterInsee.find((p) => p.result.indicators.length)?.result.indicators[0].source ?? geoSrc },
          { id: "commune", label: commune.nom, kind: "polygons", data: communeFc, color: "#eb6834", outlineOnly: true, visible: true, source: geoSrc },
        ],
        legend: legendFromBreaks("Revenu médian", "€", rb),
        note: "Gris : valeur non diffusée (secret statistique) ou indisponible.",
      });
    }

    // Équipements
    const contourLayer = { id: "contour", label: `Limite communale de ${commune.nom}`, kind: "polygons" as const, data: communeFc, color: "#374151", outlineOnly: true, visible: true, source: geoSrc };
    if (c.equipments) {
      const groups = Object.keys(GROUP_LABELS) as (keyof typeof GROUP_LABELS)[];
      maps.push({
        id: "map_equipements",
        title: `Équipements et services (OpenStreetMap) — ${commune.nom}`,
        theme: "equipements",
        bbox: localBbox,
        layers: [
          contourLayer,
          ...groups
            .filter((g) => g !== "transport")
            .map((g) => ({
              id: "eq_" + g,
              label: GROUP_LABELS[g],
              kind: "points" as const,
              data: { type: "FeatureCollection" as const, features: c.equipments!.features.filter((f) => f.properties?.group === g) },
              categoryProperty: "categoryLabel",
              color: GROUP_COLORS[g],
              visible: true,
              source: c.equipments!.source,
            })),
        ],
        legend: { title: "Domaines", categories: groups.filter((g) => g !== "transport").map((g) => ({ label: GROUP_LABELS[g], color: GROUP_COLORS[g] })) },
        note: "Données contributives OpenStreetMap ; couverture à vérifier localement.",
      });
    }
    // Transports
    const tLayers: MapSpec["layers"] = [contourLayer];
    if (c.equipments)
      for (const [id, color] of [["gare", "#0b0b0b"], ["arret_bus", "#2a78d6"], ["velo", "#eb6834"], ["recharge", "#eda100"]] as const) {
        const cat = CATEGORIES.find((x) => x.id === id)!;
        const features = c.equipments.features.filter((f) => f.properties?.category === id).map((f) => ({ ...f, properties: { ...f.properties, color } }));
        tLayers.push({ id: "t_" + id, label: cat.label, kind: "points", data: { type: "FeatureCollection", features }, color, visible: id !== "recharge", source: c.equipments.source });
      }
    if (c.cycleways?.lines.length)
      tLayers.push({ id: "cyclable", label: "Aménagements cyclables", kind: "lines", data: { type: "FeatureCollection", features: c.cycleways.lines.map((l) => turf.truncate(l, { precision: 5 })) }, color: "#1baf7a", visible: true, source: c.cycleways.source });
    if (c.stations?.stations.some((s) => s.lon != null))
      tLayers.push({
        id: "gares_sncf",
        label: "Gares SNCF (fréquentation)",
        kind: "points",
        data: { type: "FeatureCollection", features: c.stations.stations.filter((s) => s.lon != null).map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon!, s.lat!] }, properties: { name: s.nom, voyageurs: s.frequentation[s.frequentation.length - 1]?.voyageurs ?? null } })) },
        color: "#6250d6",
        visible: true,
        source: c.stations.source,
      });
    if (tLayers.length > 1)
      maps.push({
        id: "map_transports",
        title: `Transports et mobilité — ${commune.nom}`,
        theme: "mobilite",
        bbox: localBbox,
        layers: tLayers,
        legend: { title: "Couches", categories: tLayers.filter((l) => l.id !== "contour").map((l) => ({ label: l.label, color: l.color ?? "#000" })) },
      });
    if (c.nearest?.length && commune.centre) {
      const pts: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: commune.centre }, properties: { name: `Centre de ${commune.nom}` } },
          ...c.nearest.map((n) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [n.lon, n.lat] }, properties: { name: `${n.label} : ${n.name} (${n.distanceKm.toFixed(1).replace(".", ",")} km)` } })),
        ],
      };
      maps.push({
        id: "map_acces",
        title: "Équipements structurants les plus proches",
        theme: "mobilite",
        bbox: turf.bbox(turf.buffer(pts, 2, { units: "kilometers" })!) as [number, number, number, number],
        layers: [
          { id: "dep", label: "Communes du département", kind: "polygons", data: withProps(() => ({})), color: "#e5e7eb", visible: true, source: geoSrc },
          contourLayer,
          { id: "acces", label: "Équipements structurants", kind: "points", data: pts, color: "#b91c1c", visible: true, source: c.nearestSource! },
        ],
        legend: { title: "Légende", categories: [{ label: "Équipement structurant / centre communal", color: "#b91c1c" }] },
      });
    }
    // Participation électorale : une carte par scrutin (sélecteur de période dans la visionneuse).
    const withMaps = c.elections.filter((e) => e.results.some((r) => r.level === "departement" && r.byCommune?.length));
    withMaps.forEach((e, idx) => {
      const depRes = e.results.find((r) => r.level === "departement")!;
      const part = new Map(depRes.byCommune!.map((x) => [x.code, x.inscrits ? (100 * x.votants) / x.inscrits : null]));
      const pb = quantileBreaks([...part.values()].filter((x): x is number => x != null), 5);
      maps.push({
        id: idx === 0 ? "map_participation" : `map_participation_${depRes.election.id}`,
        group: "participation",
        period: depRes.election.label,
        title: `Participation par commune — ${depRes.election.label}`,
        theme: "elections",
        bbox,
        layers: [
          { id: "participation", label: "Participation (% des inscrits)", kind: "polygons", data: withProps((f) => ({ participation: part.get(props(f).code) ?? null })), valueProperty: "participation", visible: true, source: e.source },
          { id: "commune", label: commune.nom, kind: "polygons", data: communeFc, color: "#eb6834", outlineOnly: true, visible: true, source: geoSrc },
        ],
        legend: legendFromBreaks("Participation", "%", pb),
        note: "Indicateur agrégé à la commune, à visée descriptive.",
      });
    });
    // Risques technologiques
    if (c.risques?.data.icpe.some((i) => i.lon != null)) {
      maps.push({
        id: "map_icpe",
        title: `Installations classées pour la protection de l'environnement — ${commune.nom}`,
        theme: "risques",
        bbox: localBbox,
        layers: [
          contourLayer,
          {
            id: "icpe",
            label: "Installations classées",
            kind: "points",
            data: { type: "FeatureCollection", features: c.risques.data.icpe.filter((i) => i.lon != null && i.lat != null).map((i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [i.lon!, i.lat!] }, properties: { name: i.nom, regime: i.regime, seveso: i.seveso } })) },
            color: "#9a3412",
            visible: true,
            source: c.risques.source,
          },
        ],
        legend: { title: "Légende", categories: [{ label: "Installation classée", color: "#9a3412" }] },
      });
    }
  }

  /* ------------------------------------------------ données manquantes */
  const expected: [string, ThemeId, string][] = [
    ["revenu_median", "revenus", "Revenu médian (Filosofi)"],
    ["taux_pauvrete", "revenus", "Taux de pauvreté (Filosofi)"],
    ["taux_chomage_rp", "emploi", "Taux de chômage (recensement)"],
    ["part_65_plus", "demographie", "Structure par âge (recensement)"],
    ["part_logements_vacants", "logement", "Parc de logements (recensement)"],
    ["part_locataires_hlm", "logement", "Statut d'occupation (recensement)"],
    ["part_diplome_superieur", "formation", "Niveau de diplôme (recensement)"],
    ["part_personnes_seules", "menages", "Personnes vivant seules (recensement)"],
    ["part_menages_sans_voiture", "mobilite", "Équipement automobile des ménages (recensement)"],
    ["part_trajets_voiture", "mobilite", "Modes de transport domicile-travail (recensement)"],
    ["evol_pop_annuelle", "demographie", "Évolution historique de la population"],
    ["concentration_emploi", "emploi", "Emploi au lieu de travail et concentration d'emploi"],
  ];
  for (const [id, theme, label] of expected) {
    if (!indicators.some((i) => i.id === id && i.geo.level === "commune" && i.value != null))
      missing.push({ theme, label, reason: c.insee.some((x) => x.geo.level === "commune") ? "Non diffusé pour ce territoire (secret statistique) ou modalité non reconnue dans le jeu INSEE" : "Source INSEE indisponible lors de la génération", sourceId: "insee_melodi" });
  }
  if (!c.dvf) missing.push({ theme: "immobilier", label: "Prix immobiliers (DVF)", reason: "Source indisponible ou commune non couverte (Alsace-Moselle, Mayotte)", sourceId: "dvf" });
  if (!c.elections.length) missing.push({ theme: "elections", label: "Résultats électoraux", reason: "Source indisponible lors de la génération", sourceId: "elections" });
  if (!c.bureaux.length) missing.push({ theme: "elections", label: "Résultats par bureau de vote", reason: "Source indisponible lors de la génération" });
  if (!c.routes) missing.push({ theme: "mobilite", label: "Temps de trajet routiers", reason: "Calculateur d'itinéraires (OSRM) indisponible lors de la génération", sourceId: "osrm" });
  missing.push({ theme: "mobilite", label: "Lignes de bus et de cars (GTFS régionaux)", reason: "Non intégré : seuls les horaires SNCF (trains et cars TER) sont exploités" });
  if (!c.quartiers) missing.push({ theme: "demographie", label: "Données infracommunales (IRIS, quartiers prioritaires)", reason: "Commune sans quartier prioritaire ni découpage IRIS, ou source indisponible" });

  return { indicators, series, tables, charts, maps, missing: dedupeMissing(missing) };
}

function dedupeMissing(m: MissingItem[]) {
  const seen = new Set<string>();
  return m.filter((x) => {
    const k = x.theme + x.label;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
