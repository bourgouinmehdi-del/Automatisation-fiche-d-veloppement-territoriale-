import { fmtValue } from "../format";
import type { Indicator, SourceRef } from "../types";

/** Utilitaires de citation partagés par le rendu HTML, le DOCX et l'interface web. */

export function sourceLabel(s: SourceRef) {
  return `${s.name}${s.dataset ? ` — ${s.dataset}` : ""}${s.vintage ? `, millésime ${s.vintage}` : ""}`;
}

/** Index des sources citées → numéro de note. */
export class Citations {
  private list: SourceRef[] = [];
  cite(s: SourceRef): number {
    const key = (x: SourceRef) => `${x.id}|${x.dataset ?? ""}|${x.vintage ?? ""}|${x.id === "insee_melodi" ? "" : x.url}`;
    const i = this.list.findIndex((x) => key(x) === key(s));
    if (i >= 0) return i + 1;
    this.list.push(s);
    return this.list.length;
  }
  all() {
    return this.list;
  }
}

/** Découpe un texte balisé `**gras**` en segments. */
export function inlineParts(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((s) => (s.startsWith("**") && s.endsWith("**") && s.length > 4 ? { text: s.slice(2, -2), bold: true } : { text: s, bold: false }));
}

/** Retire le balisage de mise en évidence (exports texte). */
export const stripMarks = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1");

export function cellText(v: string | number | null, unit?: string) {
  if (v == null || (typeof v === "number" && !Number.isFinite(v))) return "n.d.";
  if (typeof v === "number") return fmtValue(v, (unit as Indicator["unit"]) ?? "nombre", unit === "%" ? 1 : Number.isInteger(v) ? 0 : 1);
  return v;
}

