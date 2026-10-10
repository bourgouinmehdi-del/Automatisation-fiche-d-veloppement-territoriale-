import type { GeoRef, Indicator, Series, SourceRef, ThemeId, Unit } from "../types";
import type { CollectContext, TrackedHttp } from "./context";
import {
  ageLabel,
  choosePartition,
  CodeSpec,
  latestValue,
  loadDataset,
  MelodiDataset,
  parseAgeCode,
  resolveCode,
  resolveDim,
  timeSeries,
} from "./insee";

/**
 * Déclaration des indicateurs INSEE et de leurs correspondances avec les
 * modalités Melodi. Chaque critère liste plusieurs noms de dimension et
 * plusieurs règles de reconnaissance de modalité (code exact, puis expression
 * régulière sur le code, puis sur le libellé).
 *
 * Maintenance : en cas d'évolution de la nomenclature INSEE, lancer
 * `npm run check:sources -- --insee 60159` pour lister les dimensions et
 * modalités réellement servies, puis ajuster les règles ci-dessous.
 */

interface Criterion {
  dims: string[];
  spec: CodeSpec;
  /** Somme de toutes les modalités reconnues (ex. tous les diplômes du supérieur). */
  all?: boolean;
  /** Si la dimension n'existe pas dans le jeu, le critère est ignoré. */
  optional?: boolean;
}

interface IndicatorDef {
  id: string;
  label: string;
  theme: ThemeId;
  unit: Unit;
  datasets: string[];
  kind: "value" | "ratio";
  num: Criterion[];
  /** Dénominateur : somme des ensembles de critères listés (vide = total). */
  den?: Criterion[][];
  higherIsBetter?: boolean;
  method?: string;
  limits?: string;
}

const RP_LIMITS =
  "Recensement de la population : valeurs issues de cinq enquêtes annuelles ; comparer des millésimes distants d'au moins 5 ans.";

const MEASURE_DIMS = ["FILOSOFI_MEASURE", "MEASURE", "INDICATOR", "STAT_MEASURE"];

export const INDICATOR_DEFS: IndicatorDef[] = [
  /* ----------------------------------------------------------- revenus */
  {
    id: "revenu_median",
    label: "Revenu disponible médian par unité de consommation",
    theme: "revenus",
    unit: "€",
    datasets: ["DS_FILOSOFI_CC"],
    kind: "value",
    num: [{ dims: MEASURE_DIMS, spec: { codes: ["MED_SL", "MED_DISP"], labelRe: /m[ée]dian/i } }],
    higherIsBetter: true,
    limits: "Filosofi : non diffusé pour les communes de moins de 1 000 ménages fiscaux (secret statistique).",
  },
  {
    id: "taux_pauvrete",
    label: "Taux de pauvreté (seuil 60 % du revenu médian)",
    theme: "revenus",
    unit: "%",
    datasets: ["DS_FILOSOFI_CC"],
    kind: "value",
    num: [{ dims: MEASURE_DIMS, spec: { codes: ["PR_MD60", "TP60"], labelRe: /taux de pauvret/i } }],
    higherIsBetter: false,
    limits: "Filosofi : non diffusé pour les petites communes (secret statistique).",
  },
  {
    id: "rapport_interdecile",
    label: "Rapport interdécile D9/D1 du revenu disponible",
    theme: "revenus",
    unit: "nombre",
    datasets: ["DS_FILOSOFI_CC"],
    kind: "value",
    num: [{ dims: MEASURE_DIMS, spec: { codes: ["IR_D9_D1_SL", "RD"], labelRe: /interd[ée]cile/i } }],
    higherIsBetter: false,
    method: "D9/D1 : rapport entre le revenu au-dessus duquel se situent les 10 % les plus aisés et celui en dessous duquel se situent les 10 % les plus modestes.",
  },
  /* ----------------------------------------------------------- logement */
  ...(
    [
      ["part_residences_principales", "Part des résidences principales", ["DW_MAIN", "1"], /principal/i, undefined],
      ["part_residences_secondaires", "Part des résidences secondaires et logements occasionnels", ["DW_SEC_DW_OCC", "DW_SEC", "2"], /secondaire/i, undefined],
      ["part_logements_vacants", "Part des logements vacants", ["DW_VAC", "3"], /vacant/i, false],
    ] as const
  ).map(
    ([id, label, codes, re, hib]): IndicatorDef => ({
      id,
      label,
      theme: "logement",
      unit: "%",
      datasets: ["DS_RP_LOGEMENT_PRINC"],
      kind: "ratio",
      num: [{ dims: ["OCS", "OCCUPATION", "CATL"], spec: { codes: [...codes], labelRe: re } }],
      higherIsBetter: hib,
      method: "Logements de la catégorie / ensemble des logements × 100.",
      limits: RP_LIMITS + " La vacance du recensement inclut la vacance frictionnelle (logements en vente, en travaux…).",
    }),
  ),
  {
    id: "part_maisons",
    label: "Part des maisons dans le parc de logements",
    theme: "logement",
    unit: "%",
    datasets: ["DS_RP_LOGEMENT_PRINC"],
    kind: "ratio",
    num: [{ dims: ["TDW", "TYPL", "DWELLING_TYPE"], spec: { codes: ["HOUSE", "1"], labelRe: /maison/i } }],
    method: "Maisons / ensemble des logements × 100.",
    limits: RP_LIMITS,
  },
  ...(
    [
      ["part_proprietaires", "Part des ménages propriétaires de leur résidence principale", ["OWN", "100", "1"], /propri[ée]taire/i],
      ["part_locataires_hlm", "Part des ménages locataires d'un logement HLM", ["RENT_SOC", "212", "RENT_HLM"], /HLM|social/i],
      ["part_locataires_prives", "Part des ménages locataires du parc privé", ["RENT_PRIV", "211", "RENT_FREE_MARKET"], /locataire.*(priv|vide non HLM)|non HLM/i],
    ] as const
  ).map(
    ([id, label, codes, re]): IndicatorDef => ({
      id,
      label,
      theme: "logement",
      unit: "%",
      datasets: ["DS_RP_LOGEMENT_PRINC"],
      kind: "ratio",
      num: [
        { dims: ["OCS", "OCCUPATION", "CATL"], spec: { codes: ["DW_MAIN", "1"], labelRe: /principal/i }, optional: true },
        { dims: ["TSH", "STOCD", "TENURE_STATUS"], spec: { codes: [...codes], labelRe: re } },
      ],
      den: [[{ dims: ["OCS", "OCCUPATION", "CATL"], spec: { codes: ["DW_MAIN", "1"], labelRe: /principal/i }, optional: true }]],
      method: "Résidences principales selon le statut d'occupation / ensemble des résidences principales × 100.",
      limits:
        RP_LIMITS +
        (id === "part_locataires_hlm"
          ? " Les logements sociaux du recensement sont déclarés par les ménages ; le répertoire RPLS donne un décompte administratif différent."
          : ""),
    }),
  ),
  /* ----------------------------------------------------------- emploi */
  {
    id: "taux_chomage_rp",
    label: "Taux de chômage des 15-64 ans (au sens du recensement)",
    theme: "emploi",
    unit: "%",
    datasets: ["DS_RP_EMPLOI_LR_PRINC"],
    kind: "ratio",
    num: [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["2", "UNE"], labelRe: /ch[ôo]m/i } }],
    den: [
      [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["1", "EMP"], labelRe: /(ayant un emploi|occup)/i } }],
      [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["2", "UNE"], labelRe: /ch[ôo]m/i } }],
    ],
    higherIsBetter: false,
    method: "Chômeurs déclarés / (actifs occupés + chômeurs) × 100, population de 15 à 64 ans.",
    limits:
      RP_LIMITS + " Le chômage déclaré au recensement est supérieur au chômage au sens du BIT ; ne pas comparer aux taux trimestriels de l'INSEE.",
  },
  {
    id: "taux_emploi",
    label: "Taux d'emploi des 15-64 ans",
    theme: "emploi",
    unit: "%",
    datasets: ["DS_RP_EMPLOI_LR_PRINC"],
    kind: "ratio",
    num: [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["1", "EMP"], labelRe: /(ayant un emploi|occup)/i } }],
    higherIsBetter: true,
    method: "Actifs occupés / population des 15-64 ans × 100.",
    limits: RP_LIMITS,
  },
  {
    id: "emplois_lieu_travail",
    label: "Emplois au lieu de travail",
    theme: "economie",
    unit: "emplois",
    datasets: ["DS_RP_EMPLOI_LT_PRINC"],
    kind: "value",
    num: [],
    limits: RP_LIMITS,
  },
  /* ----------------------------------------------------------- diplômes */
  {
    id: "part_sans_diplome",
    label: "Part des non-scolarisés de 15 ans et plus sans diplôme ou avec au plus le brevet",
    theme: "formation",
    unit: "%",
    datasets: ["DS_RP_DIPLOMES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["EDUC", "DIPLOMA", "DIPL"], spec: { codes: ["001T100_RP", "NONE_BEPC"], labelRe: /^(?!.*bac)(?!.*brevet prof).*((aucun|sans) dipl|BEPC|brevet des coll|DNB|certificat d'[ée]tudes)/i }, all: true }],
    higherIsBetter: false,
    method: "Somme des modalités « aucun diplôme », « CEP », « BEPC/brevet » / population non scolarisée de 15 ans et plus × 100.",
    limits: RP_LIMITS,
  },
  {
    id: "part_diplome_superieur",
    label: "Part des non-scolarisés de 15 ans et plus diplômés du supérieur",
    theme: "formation",
    unit: "%",
    datasets: ["DS_RP_DIPLOMES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["EDUC", "DIPLOMA", "DIPL"], spec: { labelRe: /sup[ée]rieur|bac ?\+ ?\d/i }, all: true }],
    higherIsBetter: true,
    method: "Somme des modalités de l'enseignement supérieur / population non scolarisée de 15 ans et plus × 100.",
    limits: RP_LIMITS,
  },
  /* ----------------------------------------------------------- ménages */
  {
    id: "part_familles_monoparentales",
    label: "Part des familles monoparentales parmi les familles",
    theme: "menages",
    unit: "%",
    datasets: ["DS_RP_FAMILLE_PRINC", "DS_RP_MENAGES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["FAMILY_TYPE", "TYPFC", "TF", "FAM_TYPE"], spec: { codes: ["MONO", "SINGLE_PARENT"], labelRe: /monoparent/i } }],
    method: "Familles monoparentales / ensemble des familles × 100.",
    limits: RP_LIMITS,
  },
  {
    id: "part_menages_une_personne",
    label: "Part des ménages d'une personne",
    theme: "menages",
    unit: "%",
    datasets: ["DS_RP_MENAGES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["NPERC", "HH_SIZE", "NBPERS", "HOUSEHOLD_SIZE", "TYPMR"], spec: { codes: ["1"], labelRe: /^(1 personne|une personne|personne seule|m[ée]nages? d'une personne)/i } }],
    method: "Ménages d'une personne / ensemble des ménages × 100.",
    limits: RP_LIMITS,
  },
];

/** Jeux téléchargés pour chaque territoire (le premier jeu disponible d'une liste est retenu). */
export const DATASETS = [
  "DS_POPULATIONS_REFERENCE",
  "DS_RP_POPULATION_PRINC",
  "DS_FILOSOFI_CC",
  "DS_RP_LOGEMENT_PRINC",
  "DS_RP_EMPLOI_LR_PRINC",
  "DS_RP_EMPLOI_LT_PRINC",
  "DS_RP_DIPLOMES_PRINC",
  "DS_RP_MENAGES_PRINC",
  "DS_RP_FAMILLE_PRINC",
  "DS_RP_POPULATION_COMP",
  "DS_RP_NAVETTES_PRINC",
] as const;

/** Distributions présentées en graphiques (toutes modalités d'une dimension). */
const DISTRIBUTIONS: { id: string; label: string; theme: ThemeId; datasets: string[]; dims: string[] }[] = [
  { id: "dist_csp", label: "Population de 15 ans et plus selon la catégorie socioprofessionnelle", theme: "emploi", datasets: ["DS_RP_POPULATION_COMP"], dims: ["PCS", "CS1", "SOCIO_PROF", "PCS_ESE"] },
  { id: "dist_diplomes", label: "Population non scolarisée de 15 ans et plus selon le diplôme", theme: "formation", datasets: ["DS_RP_DIPLOMES_PRINC"], dims: ["EDUC", "DIPLOMA", "DIPL"] },
  { id: "dist_periode_construction", label: "Résidences principales selon la période d'achèvement", theme: "logement", datasets: ["DS_RP_LOGEMENT_PRINC"], dims: ["ACHL", "CONSTRUCTION_PERIOD", "BUILD_END"] },
  { id: "dist_taille_menages", label: "Ménages selon le nombre de personnes", theme: "menages", datasets: ["DS_RP_MENAGES_PRINC"], dims: ["NPERC", "HH_SIZE", "NBPERS", "HOUSEHOLD_SIZE"] },
  { id: "dist_mode_transport", label: "Actifs occupés selon le mode de transport domicile-travail", theme: "mobilite", datasets: ["DS_RP_NAVETTES_PRINC"], dims: ["TRANS", "TRANSPORT_MODE", "TRANSPORT"] },
  { id: "dist_lieu_travail", label: "Actifs occupés selon le lieu de travail", theme: "mobilite", datasets: ["DS_RP_NAVETTES_PRINC"], dims: ["ILT", "WORKPLACE", "PLACE_OF_WORK"] },
];

export interface Distribution {
  id: string;
  label: string;
  theme: ThemeId;
  geo: GeoRef;
  year: string;
  items: { code: string; label: string; value: number; share: number }[];
  source: SourceRef;
}

export interface InseeResult {
  indicators: Indicator[];
  series: Series[];
  distributions: Distribution[];
  ages: { label: string; value: number; share: number; min: number; max: number }[] | null;
  agesBySex: { label: string; femmes: number; hommes: number }[] | null;
  agesYear?: string;
  agesSource?: SourceRef;
  found: string[];
}

function srcRef(ctx: CollectContext, ds: MelodiDataset, vintage?: string): SourceRef {
  return ctx.ref("insee_melodi", ds.url, ds.retrievedAt, { dataset: ds.id, vintage });
}

/** Résout un ensemble de critères en filtres de sélection (plusieurs combinaisons si `all`). */
function resolveCriteria(ds: MelodiDataset, crit: Criterion[]): Record<string, string>[] | null {
  let combos: Record<string, string>[] = [{}];
  for (const c of crit) {
    const dim = resolveDim(ds, c.dims);
    if (!dim) {
      if (c.optional) continue;
      return null;
    }
    let codes: string[] = [];
    if (c.all) {
      const vals = [...(ds.dimValues.get(dim) ?? [])].filter((v) => v !== "_T");
      const lab = ds.labels.get(dim);
      codes = vals.filter(
        (v) =>
          c.spec.codes?.includes(v) || (c.spec.codeRe && c.spec.codeRe.test(v)) || (c.spec.labelRe && lab && c.spec.labelRe.test(lab.get(v) ?? "")),
      );
    } else {
      const code = resolveCode(ds, dim, c.spec);
      if (code) codes = [code];
    }
    if (!codes.length) {
      if (c.optional) continue;
      return null;
    }
    combos = combos.flatMap((cb) => codes.map((code) => ({ ...cb, [dim]: code })));
  }
  return combos;
}

function sumAt(ds: MelodiDataset, combos: Record<string, string>[], year?: string) {
  let total = 0;
  let y = year;
  for (const cb of combos) {
    const v = latestValue(ds, cb, y);
    if (!v) return null;
    y = v.year;
    total += v.value;
  }
  return { value: total, year: y ?? "" };
}

export async function collectInsee(
  ctx: CollectContext,
  http: TrackedHttp,
  kind: "COM" | "EPCI" | "DEP" | "REG" | "FRANCE",
  code: string,
  geo: GeoRef,
  opts: { datasets?: readonly string[] } = {},
): Promise<InseeResult> {
  const out: InseeResult = { indicators: [], series: [], distributions: [], ages: null, agesBySex: null, found: [] };
  const loaded = new Map<string, MelodiDataset>();
  for (const id of opts.datasets ?? DATASETS) {
    try {
      const ds = await loadDataset(http, id, kind, code);
      if (ds) {
        loaded.set(id, ds);
        out.found.push(id);
      }
    } catch (e) {
      http.partial = true;
      http.notes.push(`${id} : ${e instanceof Error ? e.message : e}`);
    }
  }
  if (loaded.size === 0) throw new Error(`Aucun jeu INSEE obtenu pour ${geo.name}${http.notes.length ? ` (${[...new Set(http.notes.map((n) => n.replace(/^DS_\w+ : /, "")))].join(" ; ")})` : ""}`);

  const mkInd = (
    def: Pick<IndicatorDef, "id" | "label" | "theme" | "unit" | "higherIsBetter" | "method" | "limits">,
    ds: MelodiDataset,
    value: number | null,
    year: string,
    extra: Partial<Indicator> = {},
  ): Indicator => ({
    id: def.id,
    label: def.label,
    theme: def.theme,
    unit: def.unit,
    value,
    year,
    geo,
    source: srcRef(ctx, ds, year),
    method: def.method,
    limits: def.limits,
    status: value == null ? "missing" : "ok",
    higherIsBetter: def.higherIsBetter,
    ...extra,
  });

  /* Population de référence et historique */
  const popref = loaded.get("DS_POPULATIONS_REFERENCE");
  if (popref) {
    const dim = resolveDim(popref, ["POPREF_MEASURE", "MEASURE", "POP_MEASURE"]);
    const pmun = dim ? resolveCode(popref, dim, { codes: ["PMUN"], labelRe: /municipale/i }) : null;
    const crit = dim && pmun ? { [dim]: pmun } : {};
    const pts = timeSeries(popref, crit);
    if (pts.length) {
      out.series.push({
        id: "pop_historique",
        label: "Population municipale",
        theme: "demographie",
        unit: "habitants",
        geo,
        source: srcRef(ctx, popref, `${pts[0].x}-${pts[pts.length - 1].x}`),
        points: pts,
        note: "Populations de référence (recensements et populations légales annuelles).",
      });
    }
  }

  /* Structure par âge */
  const pop = loaded.get("DS_RP_POPULATION_PRINC");
  if (pop) {
    const tot = latestValue(pop, {});
    if (tot) out.indicators.push(mkInd({ id: "pop_rp", label: "Population (recensement)", theme: "demographie", unit: "habitants", limits: RP_LIMITS }, pop, tot.value, tot.year));
    const ageDim = resolveDim(pop, ["AGE", "AGE_GROUP"]);
    const sexDim = resolveDim(pop, ["SEX", "SEXE"]);
    if (ageDim && tot) {
      const bands = [...(pop.dimValues.get(ageDim) ?? [])].map(parseAgeCode).filter((b): b is NonNullable<typeof b> => !!b);
      const part = choosePartition(bands);
      if (part) {
        const rows = part.map((b) => ({ b, v: latestValue(pop, { [ageDim]: b.code }, tot.year) }));
        if (rows.every((r) => r.v)) {
          const sum = rows.reduce((s, r) => s + r.v!.value, 0);
          out.ages = rows.map((r) => ({ label: ageLabel(r.b), value: r.v!.value, share: (100 * r.v!.value) / sum, min: r.b.min, max: r.b.max }));
          out.agesYear = tot.year;
          out.agesSource = srcRef(ctx, pop, tot.year);
          const shareFrom = (min: number) => {
            if (!part.some((b) => b.min === min)) return null;
            return out.ages!.filter((a) => a.min >= min).reduce((s, a) => s + a.share, 0);
          };
          const shareUnder = (max: number) => {
            if (!part.some((b) => b.max === max)) return null;
            return out.ages!.filter((a) => a.max <= max).reduce((s, a) => s + a.share, 0);
          };
          const method = "Somme des tranches d'âge correspondantes / population totale × 100.";
          for (const [id, label, val] of [
            ["part_moins_30", "Part des moins de 30 ans", shareUnder(30)],
            ["part_moins_15", "Part des moins de 15 ans", shareUnder(15)],
            ["part_60_plus", "Part des 60 ans et plus", shareFrom(60)],
            ["part_75_plus", "Part des 75 ans et plus", shareFrom(75)],
          ] as const) {
            if (val != null)
              out.indicators.push(mkInd({ id, label, theme: "demographie", unit: "%", method, limits: RP_LIMITS }, pop, val, tot.year, { denominator: sum }));
          }
          if (sexDim) {
            const f = resolveCode(pop, sexDim, { codes: ["F", "2"], labelRe: /femme/i });
            const m = resolveCode(pop, sexDim, { codes: ["M", "1"], labelRe: /homme/i });
            if (f && m) {
              const bySex = part.map((b) => ({
                label: ageLabel(b),
                femmes: latestValue(pop, { [ageDim]: b.code, [sexDim]: f }, tot.year)?.value ?? NaN,
                hommes: latestValue(pop, { [ageDim]: b.code, [sexDim]: m }, tot.year)?.value ?? NaN,
              }));
              if (bySex.every((r) => Number.isFinite(r.femmes) && Number.isFinite(r.hommes))) out.agesBySex = bySex;
            }
          }
        }
      }
    }
  }

  /* Indicateurs déclarés */
  for (const def of INDICATOR_DEFS) {
    const ds = def.datasets.map((d) => loaded.get(d)).find(Boolean);
    if (!ds) continue;
    const numCombos = def.num.length ? resolveCriteria(ds, def.num) : [{}];
    if (!numCombos) continue;
    const num = sumAt(ds, numCombos);
    if (!num) continue;
    if (def.kind === "value") {
      out.indicators.push(mkInd(def, ds, num.value, num.year));
      continue;
    }
    let den: { value: number; year: string } | null = null;
    if (!def.den || def.den.length === 0) den = latestValue(ds, {}, num.year);
    else {
      let s = 0;
      for (const crit of def.den) {
        const combos = crit.length ? resolveCriteria(ds, crit) : [{}];
        const v = combos ? sumAt(ds, combos, num.year) : null;
        if (!v) {
          s = NaN;
          break;
        }
        s += v.value;
      }
      if (Number.isFinite(s)) den = { value: s, year: num.year };
    }
    if (!den || den.value <= 0) continue;
    out.indicators.push(
      mkInd(def, ds, (100 * num.value) / den.value, num.year, { numerator: num.value, denominator: den.value }),
    );
  }

  /* Distributions (graphiques) */
  for (const d of DISTRIBUTIONS) {
    const ds = d.datasets.map((x) => loaded.get(x)).find(Boolean);
    if (!ds) continue;
    const dim = resolveDim(ds, d.dims);
    if (!dim) continue;
    const tot = latestValue(ds, {});
    if (!tot) continue;
    const lab = ds.labels.get(dim);
    const items: Distribution["items"] = [];
    for (const v of ds.dimValues.get(dim) ?? []) {
      if (v === "_T") continue;
      const val = latestValue(ds, { [dim]: v }, tot.year);
      if (val) items.push({ code: v, label: lab?.get(v) ?? v, value: val.value, share: 0 });
    }
    const sum = items.reduce((s, i) => s + i.value, 0);
    if (!items.length || sum <= 0) continue;
    // Si les modalités se recouvrent (somme ≠ total), on ne présente pas la distribution.
    if (Math.abs(sum - tot.value) / tot.value > 0.02) continue;
    items.forEach((i) => (i.share = (100 * i.value) / sum));
    out.distributions.push({ id: d.id, label: d.label, theme: d.theme, geo, year: tot.year, items, source: srcRef(ctx, ds, tot.year) });
  }

  /* Indicateur de concentration d'emploi */
  const emplLt = out.indicators.find((i) => i.id === "emplois_lieu_travail");
  const lr = loaded.get("DS_RP_EMPLOI_LR_PRINC");
  if (emplLt?.value && lr) {
    const combos = resolveCriteria(lr, [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["1", "EMP"], labelRe: /(ayant un emploi|occup)/i } }]);
    const occ = combos ? sumAt(lr, combos, emplLt.year) : null;
    if (occ && occ.value > 0)
      out.indicators.push({
        ...emplLt,
        id: "concentration_emploi",
        label: "Indicateur de concentration d'emploi",
        unit: "nombre",
        value: (100 * emplLt.value) / occ.value,
        method:
          "Emplois au lieu de travail / actifs occupés résidents (15-64 ans) × 100. Au-delà de 100, le territoire offre plus d'emplois qu'il n'a d'actifs occupés résidents (pôle d'emploi).",
        numerator: emplLt.value,
        denominator: occ.value,
      });
  }
  return out;
}
