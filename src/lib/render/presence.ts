import type { Block } from "../types";

/**
 * Encart « Présence militante LFI » : une barre par indicateur (parrains,
 * groupes d'action actifs, actions), un trait pour la moyenne nationale.
 * Deux lectures : en nombre (le trait = ce qu'aurait la commune au rythme
 * national) ou rapporté aux inscrits ; la longueur des barres est la même.
 */
export type PresenceBlock = Extract<Block, { type: "presence" }>;
export type PresenceRow = PresenceBlock["rows"][number];
export type PresenceMode = "nombre" | "ratio";

const nf = (v: number, d = 0) => v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Position de la barre et du trait (0 à 1) : l'échelle va jusqu'au double de la moyenne. */
export function presenceScale(r: PresenceRow) {
  const max = Math.max(r.r, 2 * r.rRef) || 1;
  return { fill: r.r / max, tick: r.rRef / max };
}

export function presenceValue(r: PresenceRow, mode: PresenceMode) {
  if (mode === "nombre") return nf(Math.round(r.n));
  return nf(r.r, r.r >= 10 ? 1 : 2);
}

export function presenceRef(r: PresenceRow, mode: PresenceMode) {
  if (mode === "nombre") return `France : ${nf(Math.round(r.nRef))} à population égale`;
  return `France : ${nf(r.rRef, r.rRef >= 10 ? 1 : 2)}`;
}

export function presenceSub(r: PresenceRow, mode: PresenceMode) {
  return mode === "ratio" ? r.rUnit : (r.sub ?? "");
}

/** Version image (export Word). */
export function presenceSvg(b: PresenceBlock, width = 760) {
  const rowH = 46;
  const top = 8;
  const h = top + b.rows.length * rowH + 6;
  const lx = 0;
  const bx = 230;
  const bw = width - bx - 250;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const F = `font-family="Public Sans, Inter, DejaVu Sans, Arial, sans-serif"`;
  const rows = b.rows
    .map((r, i) => {
      const y = top + i * rowH;
      const s = presenceScale(r);
      return `<text x="${lx}" y="${y + 16}" ${F} font-size="15" font-weight="700" fill="#212320">${esc(r.label)}</text>
<text x="${lx}" y="${y + 34}" ${F} font-size="12" fill="#52514e">${esc(r.sub ?? "")}</text>
<rect x="${bx}" y="${y + 10}" width="${bw}" height="14" rx="3" fill="#ede5ff"/>
<rect x="${bx}" y="${y + 10}" width="${Math.max(2, s.fill * bw)}" height="14" rx="3" fill="#4c0297"/>
<rect x="${bx + s.tick * bw - 1.5}" y="${y + 5}" width="3" height="24" fill="#d1271c"/>
<text x="${bx + bw + 14}" y="${y + 18}" ${F} font-size="16" font-weight="800" fill="#4c0297">${esc(presenceValue(r, "nombre"))}</text>
<text x="${bx + bw + 14}" y="${y + 35}" ${F} font-size="11.5" fill="#52514e">${esc(`${presenceValue(r, "ratio")} ${r.rUnit} (${presenceRef(r, "ratio")})`)}</text>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"><rect width="100%" height="100%" fill="#fff"/>${rows}</svg>`;
}
