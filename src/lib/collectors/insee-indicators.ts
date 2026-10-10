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
    num: [{ dims: ["TDW", "TYPL", "DWELLING_TYPE"], spec: { codes: ["1", "HOUSE"], labelRe: /maison/i } }],
    method: "Maisons / ensemble des logements × 100.",
    limits: RP_LIMITS,
  },
  ...(
    [
      ["part_proprietaires", "Part des ménages propriétaires de leur résidence principale", ["100", "OWN"], /propri[ée]taire/i],
      ["part_locataires_hlm", "Part des ménages locataires d'un logement HLM loué vide", ["221", "RENT_SOC"], /HLM|social/i],
      ["part_locataires_prives", "Part des ménages locataires d'un logement vide non HLM", ["211", "RENT_PRIV"], /locataire.*(priv|vide non HLM)|non HLM/i],
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
  {
    id: "part_locataires",
    label: "Part des ménages locataires (tous parcs)",
    theme: "logement",
    unit: "%",
    datasets: ["DS_RP_LOGEMENT_PRINC"],
    kind: "ratio",
    num: [
      { dims: ["OCS"], spec: { codes: ["DW_MAIN"] }, optional: true },
      { dims: ["TSH"], spec: { codes: ["200"] } },
    ],
    den: [[{ dims: ["OCS"], spec: { codes: ["DW_MAIN"] }, optional: true }]],
    method: "Ménages locataires ou sous-locataires (vide, meublé, HLM) / ensemble des résidences principales × 100.",
    limits: RP_LIMITS,
  },
  ...(
    [
      ["part_ouvriers", "Part des ouvriers parmi les 15 ans et plus", "6"],
      ["part_employes", "Part des employés parmi les 15 ans et plus", "5"],
      ["part_cadres", "Part des cadres et professions intellectuelles supérieures parmi les 15 ans et plus", "3"],
      ["part_retraites", "Part des retraités parmi les 15 ans et plus", "7"],
    ] as const
  ).map(
    ([id, label, code]): IndicatorDef => ({
      id,
      label,
      theme: "emploi",
      unit: "%",
      datasets: ["DS_RP_POPULATION_COMP"],
      kind: "ratio",
      num: [{ dims: ["PCS"], spec: { codes: [code] } }],
      method: "Population de 15 ans et plus de la catégorie socioprofessionnelle / population de 15 ans et plus × 100.",
      limits: RP_LIMITS,
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
    num: [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["2", "UNE"], labelRe: /ch[ôo]m/i } }, { dims: ["AGE"], spec: { codes: ["Y15T64"] }, optional: true }],
    den: [
      [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["1", "EMP"], labelRe: /(ayant un emploi|occup)/i } }, { dims: ["AGE"], spec: { codes: ["Y15T64"] }, optional: true }],
      [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["2", "UNE"], labelRe: /ch[ôo]m/i } }, { dims: ["AGE"], spec: { codes: ["Y15T64"] }, optional: true }],
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
    num: [{ dims: ["EMPSTA_ENQ", "EMPSTA", "ACTIVITY_STATUS"], spec: { codes: ["1", "EMP"], labelRe: /(ayant un emploi|occup)/i } }, { dims: ["AGE"], spec: { codes: ["Y15T64"] }, optional: true }],
    den: [[{ dims: ["AGE"], spec: { codes: ["Y15T64"] }, optional: true }]],
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
    num: [{ dims: ["EDUC", "DIPLOMA", "DIPL"], spec: { codes: ["001T100_RP", "200_RP", "NONE_BEPC"], labelRe: /^(?!.*bac)(?!.*brevet prof).*((aucun|sans) dipl|BEPC|brevet des coll|DNB|certificat d'[ée]tudes)/i }, all: true }],
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
    num: [{ dims: ["EDUC", "DIPLOMA", "DIPL"], spec: { codes: ["500T702_RP"] } }],
    higherIsBetter: true,
    method: "Somme des modalités de l'enseignement supérieur / population non scolarisée de 15 ans et plus × 100.",
    limits: RP_LIMITS,
  },
  /* ----------------------------------------------------------- ménages */
  {
    id: "part_personnes_seules",
    label: "Part des personnes de 15 ans ou plus vivant seules",
    theme: "menages",
    unit: "%",
    datasets: ["DS_RP_MENAGES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["RP_MEASURE"], spec: { codes: ["ONEPERS"] } }],
    den: [[{ dims: ["RP_MEASURE"], spec: { codes: ["POP"] } }]],
    method: "Personnes vivant seules / population de 15 ans ou plus × 100.",
    limits: RP_LIMITS,
  },
  {
    // Variante : la mesure « vivant seules » n'est publiée que pour les ménages ordinaires.
    id: "part_personnes_seules",
    label: "Part des personnes de 15 ans ou plus vivant seules",
    theme: "menages",
    unit: "%",
    datasets: ["DS_RP_MENAGES_PRINC"],
    kind: "ratio",
    num: [
      { dims: ["RP_MEASURE"], spec: { codes: ["ONEPERS"] } },
      { dims: ["OCS"], spec: { codes: ["DW_MAIN"] } },
    ],
    den: [[{ dims: ["RP_MEASURE"], spec: { codes: ["DWELLINGS_POPSIZE", "POP"] } }, { dims: ["OCS"], spec: { codes: ["DW_MAIN"] } }]],
    method: "Personnes vivant seules / population des ménages (15 ans ou plus) × 100.",
    limits: RP_LIMITS,
  },
  /* ----------------------------------------------------------- mobilité */
  {
    id: "part_menages_sans_voiture",
    label: "Part des ménages sans voiture",
    theme: "mobilite",
    unit: "%",
    datasets: ["DS_RP_LOGEMENT_PRINC"],
    kind: "ratio",
    num: [
      { dims: ["CARS"], spec: { codes: ["C0"] } },
      { dims: ["OCS"], spec: { codes: ["DW_MAIN"] }, optional: true },
    ],
    den: [[{ dims: ["OCS"], spec: { codes: ["DW_MAIN"] }, optional: true }]],
    method: "Résidences principales dont le ménage ne dispose d'aucune voiture / ensemble des résidences principales × 100.",
    limits: RP_LIMITS,
  },
  {
    id: "part_menages_2_voitures",
    label: "Part des ménages disposant de deux voitures ou plus",
    theme: "mobilite",
    unit: "%",
    datasets: ["DS_RP_LOGEMENT_PRINC"],
    kind: "ratio",
    num: [
      { dims: ["CARS"], spec: { codes: ["C_GE2"] } },
      { dims: ["OCS"], spec: { codes: ["DW_MAIN"] }, optional: true },
    ],
    den: [[{ dims: ["OCS"], spec: { codes: ["DW_MAIN"] }, optional: true }]],
    method: "Résidences principales dont le ménage dispose d'au moins deux voitures / ensemble des résidences principales × 100.",
    limits: RP_LIMITS,
  },
  {
    id: "part_actifs_travaillant_commune",
    label: "Part des actifs occupés travaillant dans leur commune de résidence",
    theme: "mobilite",
    unit: "%",
    datasets: ["DS_RP_NAVETTES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["WORK_AREA"], spec: { codes: ["10"] } }],
    method: "Actifs occupés travaillant dans leur commune de résidence / ensemble des actifs occupés × 100.",
    limits: RP_LIMITS,
  },
  {
    id: "part_trajets_voiture",
    label: "Part des actifs occupés se rendant au travail en voiture",
    theme: "mobilite",
    unit: "%",
    datasets: ["DS_RP_NAVETTES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["TRANS"], spec: { codes: ["5"] } }],
    method: "Actifs occupés utilisant principalement une voiture, un camion ou une fourgonnette / ensemble des actifs occupés × 100.",
    limits: RP_LIMITS,
  },
  {
    id: "part_trajets_tc",
    label: "Part des actifs occupés se rendant au travail en transports en commun",
    theme: "mobilite",
    unit: "%",
    datasets: ["DS_RP_NAVETTES_PRINC"],
    kind: "ratio",
    num: [{ dims: ["TRANS"], spec: { codes: ["6"] } }],
    method: "Actifs occupés utilisant principalement les transports en commun / ensemble des actifs occupés × 100.",
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
  "DS_RP_POPULATION_COMP",
  "DS_RP_NAVETTES_PRINC",
] as const;

/**
 * Distributions présentées en graphiques. Les modalités Melodi se recouvrent
 * souvent (ex. « 3 », « 4 » et « 3T4 ») : on déclare donc une partition
 * explicite, avec des libellés, constatée sur l'API (check:sources).
 * Si la partition ne somme pas au total (±2 %), la distribution est écartée.
 */
const DISTRIBUTIONS: {
  id: string;
  label: string;
  theme: ThemeId;
  datasets: string[];
  dims: string[];
  codes?: Record<string, string>;
  /** Critères essayés en priorité (ex. résidences principales), puis sans critère. */
  prefer?: Record<string, string>;
}[] = [
  {
    id: "dist_csp",
    label: "Population de 15 ans et plus selon la catégorie socioprofessionnelle",
    theme: "emploi",
    datasets: ["DS_RP_POPULATION_COMP"],
    dims: ["PCS"],
    codes: {
      "1": "Agriculteurs exploitants",
      "2": "Artisans, commerçants, chefs d'entreprise",
      "3": "Cadres, professions intellectuelles supérieures",
      "4": "Professions intermédiaires",
      "5": "Employés",
      "6": "Ouvriers",
      "7": "Retraités",
      "8": "Autres sans activité professionnelle",
      "9": "Autres sans activité professionnelle",
    },
  },
  {
    id: "dist_diplomes",
    label: "Population non scolarisée de 15 ans et plus selon le diplôme le plus élevé",
    theme: "formation",
    datasets: ["DS_RP_DIPLOMES_PRINC"],
    dims: ["EDUC"],
    codes: {
      "001T100_RP": "Aucun diplôme ou certificat d'études primaires",
      "200_RP": "BEPC, brevet des collèges, DNB",
      "300_RP": "CAP, BEP ou équivalent",
      "350T351_RP": "Baccalauréat ou équivalent",
      "500_RP": "Bac + 2",
      "600_RP": "Bac + 3 ou + 4",
      "700_RP": "Bac + 5 ou plus",
    },
  },
  {
    id: "dist_periode_construction",
    label: "Logements selon la période d'achèvement",
    theme: "logement",
    datasets: ["DS_RP_LOGEMENT_PRINC"],
    dims: ["BUILD_END"],
    codes: {
      Y_LT1919: "Avant 1919",
      Y1919T1945: "1919-1945",
      Y1946T1970: "1946-1970",
      Y1971T1990: "1971-1990",
      Y1991T2005: "1991-2005",
      Y2006TAAAA: "2006 et après",
    },
    prefer: { OCS: "DW_MAIN" },
  },
  {
    id: "dist_voitures",
    label: "Ménages selon le nombre de voitures",
    theme: "mobilite",
    datasets: ["DS_RP_LOGEMENT_PRINC"],
    dims: ["CARS"],
    codes: { C0: "Aucune voiture", C1: "Une voiture", C_GE2: "Deux voitures ou plus" },
    prefer: { OCS: "DW_MAIN" },
  },
  {
    id: "dist_mode_transport",
    label: "Actifs occupés selon le mode de transport domicile-travail",
    theme: "mobilite",
    datasets: ["DS_RP_NAVETTES_PRINC"],
    dims: ["TRANS"],
    codes: {
      "1": "Pas de déplacement",
      "2": "Marche à pied",
      "3": "Vélo",
      "4": "Deux-roues motorisé",
      "5": "Voiture, camion, fourgonnette",
      "6": "Transports en commun",
    },
  },
  {
    id: "dist_lieu_travail",
    label: "Actifs occupés selon le lieu de travail",
    theme: "mobilite",
    datasets: ["DS_RP_NAVETTES_PRINC"],
    dims: ["WORK_AREA"],
    codes: { "10": "Dans la commune de résidence", "20_30": "Dans une autre commune" },
  },
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
    if (pts.length >= 2) {
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
  if (pop && !out.series.some((x) => x.id === "pop_historique")) {
    // Les populations de référence ne couvrant parfois qu'un millésime, la
    // série historique est alors construite à partir des millésimes du recensement.
    const pts = timeSeries(pop, {});
    if (pts.length >= 2)
      out.series.push({
        id: "pop_historique",
        label: "Population (recensement)",
        theme: "demographie",
        unit: "habitants",
        geo,
        source: srcRef(ctx, pop, `${pts[0].x}-${pts[pts.length - 1].x}`),
        points: pts,
        note: "Populations des recensements diffusés par l'INSEE (millésimes disponibles dans l'API).",
      });
  }
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
          // Les bornes disponibles dépendent du jeu (ex. 15/25/40/55/65/80 ans en 2023) :
          // on calcule les parts pour toutes les bornes usuelles présentes.
          const shares: [string, string, number | null][] = [
            ["part_moins_15", "Part des moins de 15 ans", shareUnder(15)],
            ["part_moins_20", "Part des moins de 20 ans", shareUnder(20)],
            ["part_moins_25", "Part des moins de 25 ans", shareUnder(25)],
            ["part_moins_30", "Part des moins de 30 ans", shareUnder(30)],
            ["part_60_plus", "Part des 60 ans et plus", shareFrom(60)],
            ["part_65_plus", "Part des 65 ans et plus", shareFrom(65)],
            ["part_75_plus", "Part des 75 ans et plus", shareFrom(75)],
            ["part_80_plus", "Part des 80 ans et plus", shareFrom(80)],
          ];
          for (const [id, label, val] of shares) {
            if (val != null)
              out.indicators.push(mkInd({ id, label, theme: "demographie", unit: "%", method, limits: RP_LIMITS }, pop, val, tot.year, { denominator: sum }));
          }
          for (const [id, label, code] of [
            ["part_65_plus", "Part des 65 ans et plus", "Y_GE65"],
            ["part_80_plus", "Part des 80 ans et plus", "Y_GE80"],
            ["part_moins_20", "Part des moins de 20 ans", "Y_LT20"],
          ] as const) {
            if (out.indicators.some((i) => i.id === id)) continue;
            const v = pop.dimValues.get(ageDim)?.has(code) ? latestValue(pop, { [ageDim]: code }, tot.year) : null;
            if (v && tot.value > 0)
              out.indicators.push(
                mkInd({ id, label, theme: "demographie", unit: "%", method: "Population de la tranche / population totale × 100.", limits: RP_LIMITS }, pop, (100 * v.value) / tot.value, tot.year, { numerator: v.value, denominator: tot.value }),
              );
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
    // Une définition de repli (même identifiant) n'est utilisée que si la première a échoué.
    if (out.indicators.some((i) => i.id === def.id)) continue;
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
    const lab = ds.labels.get(dim);
    const values = ds.dimValues.get(dim) ?? new Set<string>();
    const wanted = d.codes ? Object.keys(d.codes).filter((k) => values.has(k)) : [...values].filter((v) => v !== "_T");
    const attempts = [d.prefer ? Object.fromEntries(Object.entries(d.prefer).filter(([k, v]) => ds.dimValues.get(k)?.has(v))) : null, {}].filter(
      (x): x is Record<string, string> => !!x,
    );
    let found: { items: Distribution["items"]; year: string } | null = null;
    for (const base of attempts) {
      // Total : modalité `_T` de la dimension si elle existe.
      const tot = latestValue(ds, { ...base, ...(values.has("_T") ? { [dim]: "_T" } : {}) });
      if (!tot) continue;
      const items: Distribution["items"] = [];
      for (const v of wanted) {
        const val = latestValue(ds, { ...base, [dim]: v }, tot.year);
        if (val) items.push({ code: v, label: lab?.get(v) ?? d.codes?.[v] ?? v, value: val.value, share: 0 });
      }
      const sum = items.reduce((s2, i) => s2 + i.value, 0);
      // Si les modalités se recouvrent ou sont incomplètes (somme ≠ total), on n'utilise pas cette lecture.
      if (!items.length || sum <= 0 || Math.abs(sum - tot.value) / tot.value > 0.02) continue;
      items.forEach((i) => (i.share = (100 * i.value) / sum));
      found = { items, year: tot.year };
      break;
    }
    if (!found) continue;
    const { items } = found;
    const tot = { year: found.year };
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
          "Emplois au lieu de travail / actifs occupés résidents de 15 ans ou plus × 100 (définition INSEE). Au-delà de 100, le territoire offre plus d'emplois qu'il n'a d'actifs occupés résidents (pôle d'emploi).",
        numerator: emplLt.value,
        denominator: occ.value,
      });
  }
  return out;
}
