/**
 * Modèle de données central de l'application.
 *
 * Principe : toute valeur chiffrée affichée dans un rapport est un `Indicator`
 * (ou un point d'une `Series`) qui porte sa propre traçabilité : source, URL,
 * date de récupération, millésime, échelle géographique, unité, méthode, limites.
 * Une valeur absente est représentée par `value: null` + `status` explicite,
 * jamais par une estimation.
 */

export type GeoLevel =
  | "commune"
  | "epci"
  | "departement"
  | "region"
  | "france"
  | "bureau_vote"
  | "quartier";

export interface GeoRef {
  level: GeoLevel;
  code: string;
  name: string;
}

export type Unit =
  | "habitants"
  | "hab/km²"
  | "km²"
  | "%"
  | "€"
  | "€/m²"
  | "nombre"
  | "km"
  | "logements"
  | "emplois"
  | "établissements"
  | "an"
  | "points";

export type ThemeId =
  | "identite"
  | "demographie"
  | "menages"
  | "revenus"
  | "emploi"
  | "formation"
  | "logement"
  | "economie"
  | "equipements"
  | "sante"
  | "education"
  | "mobilite"
  | "immobilier"
  | "risques"
  | "elections"
  | "strategie";

/** Référence documentaire d'une donnée. */
export interface SourceRef {
  /** Identifiant dans le catalogue `sources/catalog.ts`. */
  id: string;
  /** Nom lisible du producteur / jeu de données. */
  name: string;
  /** URL de la requête ou du jeu de données. */
  url: string;
  /** Identifiant du jeu de données chez le producteur (ex. DS_FILOSOFI_CC). */
  dataset?: string;
  /** Date ISO de récupération effective (ou de mise en cache). */
  retrievedAt: string;
  /** Millésime statistique (année de référence de la donnée). */
  vintage?: string;
}

export type DataStatus = "ok" | "missing" | "error" | "partial";

export interface Indicator {
  /** Identifiant stable de l'indicateur (ex. "pop_municipale"). Le même id est
   *  utilisé pour toutes les échelles afin de permettre les comparaisons. */
  id: string;
  label: string;
  theme: ThemeId;
  value: number | null;
  unit: Unit;
  /** Millésime de la valeur. */
  year?: string;
  geo: GeoRef;
  source: SourceRef;
  /** Méthode de calcul lorsque la valeur est dérivée. */
  method?: string;
  /** Limites d'interprétation. */
  limits?: string;
  status: DataStatus;
  /** Effectifs ayant servi au calcul d'un ratio (permet de signaler les petits effectifs). */
  numerator?: number;
  denominator?: number;
  /** Plus la valeur est élevée, plus la situation est favorable (true), défavorable (false), neutre (undefined). */
  higherIsBetter?: boolean;
}

export interface SeriesPoint {
  x: string;
  y: number | null;
}

export interface Series {
  id: string;
  label: string;
  theme: ThemeId;
  unit: Unit;
  geo: GeoRef;
  source: SourceRef;
  points: SeriesPoint[];
  note?: string;
}

export interface TableColumn {
  key: string;
  label: string;
  unit?: Unit;
  align?: "left" | "right";
  /** Colonne de texte à ne pas comprimer (libellés). */
  wide?: boolean;
}

export interface DataTable {
  id: string;
  title: string;
  theme: ThemeId;
  columns: TableColumn[];
  rows: Record<string, string | number | null>[];
  sources: SourceRef[];
  note?: string;
  /** Indices des lignes mises en évidence (ex. le territoire étudié). */
  highlight?: number[];
}

export interface ChartSpec {
  id: string;
  title: string;
  type: "bar" | "hbar" | "line" | "pyramid";
  /** Données tabulaires : chaque ligne contient `xKey` et une clé par série. */
  data: Record<string, string | number | null>[];
  xKey: string;
  series: { key: string; label: string }[];
  unit: Unit;
  sources: SourceRef[];
  note?: string;
}

/* ------------------------------------------------------------------ cartes */

export interface MapLayer {
  id: string;
  label: string;
  kind: "polygons" | "points" | "lines";
  /** GeoJSON FeatureCollection (WGS84). */
  data: GeoJSON.FeatureCollection;
  /** Propriété numérique utilisée pour une représentation choroplèthe. */
  valueProperty?: string;
  /** Propriété utilisée pour la catégorie (couleur) des points. */
  categoryProperty?: string;
  color?: string;
  /** Contour seul, sans remplissage. */
  outlineOnly?: boolean;
  /** Propriété affichée en étiquette au centre des polygones. */
  labelProperty?: string;
  /** Couche affichée par défaut. */
  visible: boolean;
  source: SourceRef;
}

export interface MapLegend {
  title: string;
  unit?: Unit;
  /** Classes de la choroplèthe : bornes et couleurs. */
  classes?: { min: number; max: number; color: string }[];
  categories?: { label: string; color: string }[];
  missingLabel?: string;
}

export interface MapSpec {
  id: string;
  title: string;
  theme: ThemeId;
  layers: MapLayer[];
  legend?: MapLegend;
  /** Cartes d'un même groupe = millésimes alternatifs (sélecteur de période dans la visionneuse). */
  group?: string;
  period?: string;
  /** [ouest, sud, est, nord] */
  bbox?: [number, number, number, number];
  note?: string;
}

/* --------------------------------------------------------------- analyses */

export type FindingKind = "constat" | "atout" | "vigilance" | "hypothese" | "piste" | "a_verifier";

export interface Finding {
  id: string;
  kind: FindingKind;
  theme: ThemeId;
  text: string;
  /** Identifiants d'indicateurs (ou de séries) qui fondent l'affirmation. */
  evidence: string[];
  /** Importance relative (0-100) utilisée pour sélectionner les enseignements clés. */
  weight: number;
}

/**
 * Les textes des blocs acceptent une mise en évidence minimale : `**texte**`
 * est rendu en gras (HTML, interface, DOCX) et retiré des exports CSV.
 */
export type Block =
  | { type: "paragraph"; text: string; evidence?: string[] }
  | { type: "kpis"; indicatorIds: string[] }
  | { type: "comparison"; indicatorIds: string[]; title?: string }
  | { type: "table"; tableId: string }
  | { type: "chart"; chartId: string }
  | { type: "map"; mapId: string }
  /** Deux cartes côte à côte (ex. vote LFI / participation par bureau de vote). */
  | { type: "mapPair"; mapIds: [string, string]; title?: string }
  /**
   * Constats. `ids` restreint à des constats précis ; `style: "prose"` les rend
   * en paragraphes rédigés (sans étiquette), comme dans une fiche rédigée.
   */
  | { type: "findings"; kinds?: FindingKind[]; themes?: ThemeId[]; ids?: string[]; title?: string; style?: "tags" | "prose" }
  | { type: "note"; text: string }
  /** Encadré (avertissement, implantation militante, accessibilité…). */
  | { type: "callout"; text: string; title?: string; tone?: "warning" | "info" | "accent" }
  /** Intertitre à l'intérieur d'une partie. */
  | { type: "heading"; text: string }
  /** Chiffres clés rédigés (valeur + comparaison). */
  | { type: "glance"; items: { label: string; value: string; detail?: string; tone?: "up" | "down" | "neutral" }[] }
  /** Actions regroupées par type de lieu (porte-à-porte, marchés, gares…). */
  | { type: "actions"; title?: string; groups: { title: string; hint?: string; items: string[] }[] }
  | { type: "missing"; themes: ThemeId[] }
  /** Notes de terrain saisies dans l'application (lues dans `Report.fieldNotes` au moment du rendu). */
  | { type: "fieldNotes" }
  /** Propositions de ciblage (mode département) : une carte par territoire, avec son tableau. */
  | {
      type: "targets";
      items: { code: string; codes: string[]; nom: string; kind: "commune" | "groupement"; focus?: string[]; color: string; raisons: string[]; tableId: string; evidence: string[] }[];
    }
  /** Carte de localisation nationale (fond SVG embarqué, fonctionne hors ligne). */
  | { type: "locator" }
  | { type: "list"; title?: string; items: { text: string; url?: string; evidence?: string[] }[] };

export interface Section {
  id: string;
  letter: string;
  title: string;
  blocks: Block[];
}

/* --------------------------------------------------------------- collecte */

export interface SourceRun {
  sourceId: string;
  name: string;
  step: string;
  status: "ok" | "cache" | "stale" | "partial" | "failed" | "skipped";
  message?: string;
  durationMs: number;
  requests: number;
  fromCache: number;
  retrievedAt: string;
}

export interface MissingItem {
  theme: ThemeId;
  label: string;
  reason: string;
  sourceId?: string;
}

/* -------------------------------------------------------------- territoire */

export interface CommuneInfo {
  code: string;
  nom: string;
  codesPostaux: string[];
  population: number | null;
  /** Surface en km² (lorsque connue). */
  surfaceKm2: number | null;
  departement: { code: string; nom: string };
  region: { code: string; nom: string };
  epci: { code: string; nom: string; type?: string } | null;
  arrondissement: { code: string; nom: string } | null;
  centre: [number, number] | null; // [lon, lat]
  contour: GeoJSON.Geometry | null;
  siren?: string;
  /** Anciennes communes (communes déléguées/associées) rattachées. */
  communesDeleguees: { code: string; nom: string; type: string }[];
}

export type Scope = "commune" | "epci" | "departement" | "custom";

/** Territoire principal d'analyse (selon le périmètre choisi). */
export interface Focus {
  level: "commune" | "epci" | "departement";
  code: string;
  name: string;
}

export interface ReportQuery {
  codeInsee: string;
  codePostal?: string;
  scope: Scope;
  /** Codes INSEE des communes formant un territoire personnalisé. */
  customCommunes?: string[];
}

export interface Report {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  query: ReportQuery;
  commune: CommuneInfo;
  focus: Focus;
  /** Communes composant le périmètre d'analyse. */
  perimeter: { label: string; communes: { code: string; nom: string; population: number | null }[] };
  references: GeoRef[];
  indicators: Indicator[];
  series: Series[];
  tables: DataTable[];
  charts: ChartSpec[];
  maps: MapSpec[];
  findings: Finding[];
  sections: Section[];
  runs: SourceRun[];
  missing: MissingItem[];
  narrativeEngine: string;
  /** Avertissements globaux (mode hors ligne, sources indisponibles...). */
  warnings: string[];
  /** Retours du terrain saisis par les militants (conservés d'une régénération à l'autre). */
  fieldNotes?: { text: string; updatedAt: string };
}

export interface ProgressEvent {
  step: string;
  label: string;
  done: number;
  total: number;
  status: "running" | "done" | "error";
  message?: string;
  at: string;
}
