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

/** Nom du territoire d'un ciblage : département, ou « 2e circonscription de l'Oise ». */
export function territoryName(r: { query: { scope: string }; perimeter: { label: string }; commune: { departement: { nom: string } } }): string {
  return r.query.scope === "circonscription" ? r.perimeter.label.replace(/^./, (x) => x.toUpperCase()) : r.commune.departement.nom;
}
