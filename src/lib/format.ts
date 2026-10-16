import type { Unit } from "./types";

/** Formatage français des nombres (espace fine insécable pour les milliers, virgule décimale). */
export function fmtNumber(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "n.d.";
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(v)
    .replace(/ /g, " ");
}

export function defaultDigits(unit: Unit, v?: number | null): number {
  if (unit === "%") return 1;
  if (unit === "hab/km²") return v != null && Math.abs(v) < 10 ? 1 : 0;
  if (unit === "km²" || unit === "km") return 1;
  if (unit === "nombre") return v != null && Math.abs(v) < 20 && !Number.isInteger(v) ? 1 : 0;
  if (unit === "points") return 1;
  return 0;
}

export function fmtValue(v: number | null | undefined, unit: Unit, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return "n.d.";
  const d = digits ?? defaultDigits(unit, v);
  const s = fmtNumber(v, d);
  switch (unit) {
    case "%":
      return `${s} %`;
    case "€":
      return `${s} €`;
    case "€/m²":
      return `${s} €/m²`;
    case "hab/km²":
      return `${s} hab./km²`;
    case "km²":
      return `${s} km²`;
    case "km":
      return `${s} km`;
    case "habitants":
      return `${s} hab.`;
    case "points":
      return `${s} pt${Math.abs(v) >= 2 ? "s" : ""}`;
    default:
      return s;
  }
}

export function fmtSigned(v: number, unit: Unit, digits?: number) {
  const s = fmtValue(Math.abs(v), unit, digits);
  return (v > 0 ? "+" : v < 0 ? "−" : "") + s;
}

export function fmtDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

/** « à Compiègne », « au Lamentin », « aux Abymes », « à la Rochelle ». */
export function aNom(nom: string): string {
  if (/^Le /.test(nom)) return `au ${nom.slice(3)}`;
  if (/^Les /.test(nom)) return `aux ${nom.slice(4)}`;
  if (/^La /.test(nom)) return `à la ${nom.slice(3)}`;
  if (/^L'/.test(nom)) return `à l'${nom.slice(2)}`;
  return `à ${nom}`;
}
/** « de Compiègne », « du Lamentin », « des Abymes », « d'Ivry-sur-Seine ». */
export function deNom(nom: string): string {
  if (/^Le /.test(nom)) return `du ${nom.slice(3)}`;
  if (/^Les /.test(nom)) return `des ${nom.slice(4)}`;
  if (/^La /.test(nom)) return `de la ${nom.slice(3)}`;
  if (/^L'/.test(nom)) return `de l'${nom.slice(2)}`;
  return /^[aeiouyàâéèêëîïôûüœh]/i.test(nom) && !/^(Hy|Ha|He|Ho|Hu)/.test(nom) ? `d'${nom}` : `de ${nom}`;
}

// Article des départements (« la Creuse », « le Nord », « l'Oise », « les Landes ») ; sans article : Paris, Mayotte.
const DEP_LE = ["Nord", "Calvados", "Cantal", "Cher", "Doubs", "Finistère", "Gard", "Gers", "Jura", "Lot", "Loiret", "Morbihan", "Pas-de-Calais", "Rhône", "Tarn", "Var", "Val-d'Oise", "Val-de-Marne", "Bas-Rhin", "Haut-Rhin", "Lot-et-Garonne", "Maine-et-Loire", "Puy-de-Dôme", "Tarn-et-Garonne", "Territoire de Belfort", "Loir-et-Cher", "Vaucluse"];
const DEP_LES = ["Ardennes", "Bouches-du-Rhône", "Côtes-d'Armor", "Deux-Sèvres", "Hautes-Alpes", "Hautes-Pyrénées", "Hauts-de-Seine", "Landes", "Pyrénées-Atlantiques", "Pyrénées-Orientales", "Vosges", "Yvelines", "Alpes-Maritimes", "Alpes-de-Haute-Provence"];
const DEP_SANS = ["Paris", "Mayotte"];
function depKind(nom: string): "le" | "la" | "l" | "les" | "" {
  if (DEP_SANS.includes(nom)) return "";
  if (DEP_LES.includes(nom)) return "les";
  if (DEP_LE.includes(nom)) return "le";
  if (/^[aeiouyàâéèêëîïôûüœ]/i.test(nom) || /^Hérault$/.test(nom)) return "l";
  return "la";
}
/** « la Creuse », « le Nord », « l'Oise », « les Landes », « Paris ». */
export function leDep(nom: string): string {
  const k = depKind(nom);
  return k === "" ? nom : k === "l" ? `l'${nom}` : `${k} ${nom}`;
}
/** « de la Creuse », « du Nord », « de l'Oise », « des Landes », « de Paris ». */
export function deDep(nom: string): string {
  const k = depKind(nom);
  return k === "" ? `de ${nom}` : k === "le" ? `du ${nom}` : k === "les" ? `des ${nom}` : k === "l" ? `de l'${nom}` : `de la ${nom}`;
}
/** « dans la Creuse », « dans le Nord », « à Paris ». */
export function dansDep(nom: string): string {
  return depKind(nom) === "" ? `à ${nom}` : `dans ${leDep(nom)}`;
}

/** Nom du territoire d'un ciblage : département, intercommunalité ou « 2e circonscription de l'Oise ». */
export function territoryName(r: { query: { scope: string }; perimeter: { label: string }; commune: { departement: { nom: string } } }): string {
  return r.query.scope === "circonscription" || r.query.scope === "epci" ? r.perimeter.label.replace(/^./, (x) => x.toUpperCase()) : r.commune.departement.nom;
}

/** Couleur d'un score de 0 à 100 : rouge (faible), ambre, vert (élevé). */
export function scoreColor(v: number): string {
  const x = Math.max(0, Math.min(100, v)) / 100;
  const stops: [number, number, number][] = [
    [214, 69, 65],
    [233, 165, 40],
    [47, 143, 78],
  ];
  const [a, b, t] = x < 0.5 ? [stops[0], stops[1], x / 0.5] : [stops[1], stops[2], (x - 0.5) / 0.5];
  const c = a.map((v0, i) => Math.round(v0 + (b[i] - v0) * t));
  return `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
