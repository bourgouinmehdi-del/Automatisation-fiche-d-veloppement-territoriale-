import { strFromU8, unzipSync } from "fflate";

/**
 * Lecture minimale d'un classeur Excel (.xlsx) : texte des cellules, feuille
 * par feuille. Suffit pour les catalogues tabulaires déposés par les
 * militants (pas de formules recalculées : on lit la dernière valeur stockée).
 */

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** Texte d'un nœud (concatène les <t> d'un texte enrichi). */
const textOf = (xml: string) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decodeXml(m[1])).join("");

const colIndex = (ref: string) => {
  const letters = ref.replace(/\d+$/, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Feuilles du classeur : nom → lignes (tableaux de cellules texte). */
export function readXlsx(buf: Uint8Array): Map<string, string[][]> {
  const files = unzipSync(buf);
  const get = (p: string) => {
    const k = p.replace(/^\//, "");
    return files[k] ? strFromU8(files[k]) : null;
  };
  const shared: string[] = [];
  const sst = get("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(textOf(m[1]));
  const rels = new Map<string, string>();
  for (const m of (get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const out = new Map<string, string[][]>();
  for (const m of (get("xl/workbook.xml") ?? "").matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = decodeXml(m[0].match(/\bname="([^"]*)"/)?.[1] ?? "");
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    const xml = rid && rels.get(rid) ? get(rels.get(rid)!) : null;
    if (!xml) continue;
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const row: string[] = [];
      for (const c of r[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? "";
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const t = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
        let val = "";
        if (t === "s") val = shared[Number(v)] ?? "";
        else if (t === "inlineStr") val = textOf(body);
        else if (v != null) val = decodeXml(v);
        row[ref ? colIndex(ref) : row.length] = val;
      }
      rows.push(Array.from(row, (x) => x ?? ""));
    }
    out.set(name, rows);
  }
  return out;
}

/**
 * Lignes d'une feuille en objets, à partir de la première ligne d'en-tête
 * contenant `headerMarker` (les catalogues ont souvent un titre au-dessus).
 */
export function sheetObjects(rows: string[][], headerMarker: RegExp): Record<string, string>[] {
  const h = rows.findIndex((r) => r.some((c) => headerMarker.test(c)));
  if (h < 0) return [];
  const header = rows[h].map((x) => x.trim());
  return rows
    .slice(h + 1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(header.map((k, i) => [k, (r[i] ?? "").trim()]).filter(([k]) => k)));
}
