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
