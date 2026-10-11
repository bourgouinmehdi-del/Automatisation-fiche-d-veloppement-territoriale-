import { createReadStream } from "node:fs";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

/**
 * Lecture d'archives ZIP en flux (fflate), sans décompresser l'archive entière
 * en mémoire : les fichiers nationaux de l'INSEE (IRIS, BPE) ou de la SNCF
 * (GTFS) dépassent plusieurs centaines de Mo une fois décompressés. Seules les
 * lignes retenues par le filtre sont conservées.
 */

/** Parcourt les lignes des entrées choisies. `onLine` reçoit le nom de l'entrée et la ligne. */
export function zipLines(file: string, pick: (name: string) => boolean, onLine: (entry: string, line: string, index: number) => void): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    let pending = 0;
    let inputDone = false;
    let failed = false;
    const finish = () => {
      if (!failed && inputDone && pending === 0) resolve(seen);
    };
    const uz = new Unzip((f) => {
      if (!pick(f.name)) return;
      seen.push(f.name);
      pending++;
      const dec = new TextDecoder("utf-8");
      let rest = "";
      let idx = 0;
      f.ondata = (err, chunk, final) => {
        if (err) {
          failed = true;
          reject(err);
          return;
        }
        const text = rest + dec.decode(chunk, { stream: !final });
        const lines = text.split(/\r?\n/);
        rest = final ? "" : (lines.pop() ?? "");
        for (const l of lines) if (l) onLine(f.name, idx === 0 ? l.replace(/^﻿/, "") : l, idx++);
        if (final) {
          pending--;
          finish();
        }
      };
      f.start();
    });
    uz.register(UnzipInflate);
    uz.register(UnzipPassThrough);
    const rs = createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on("data", (b) => {
      try {
        uz.push(b as Uint8Array);
      } catch (e) {
        failed = true;
        rs.destroy();
        reject(e);
      }
    });
    rs.on("end", () => {
      try {
        uz.push(new Uint8Array(0), true);
      } catch (e) {
        failed = true;
        reject(e);
        return;
      }
      inputDone = true;
      finish();
    });
    rs.on("error", reject);
  });
}

/** Contenu texte complet d'une entrée (petits fichiers : GeoJSON d'un département, métadonnées). */
export async function zipText(file: string, pick: (name: string) => boolean): Promise<{ name: string; text: string }[]> {
  const parts = new Map<string, string[]>();
  await zipLines(file, pick, (name, line) => {
    if (!parts.has(name)) parts.set(name, []);
    parts.get(name)!.push(line);
  });
  return [...parts].map(([name, lines]) => ({ name, text: lines.join("\n") }));
}

/** Découpe une ligne CSV simple (séparateur donné, guillemets doubles). */
export function splitCsvLine(line: string, sep: string): string[] {
  if (!line.includes('"')) return line.split(sep);
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export const guessSep = (header: string) => [";", ",", "\t", "|"].reduce((b, d) => (header.split(d).length > header.split(b).length ? d : b), ";");

/**
 * Lignes d'un CSV zippé dont une colonne vérifie un prédicat (ex. code commune
 * commençant par le département). Renvoie l'en-tête et les lignes en objets.
 */
export async function zipCsvRows(
  file: string,
  pick: (name: string) => boolean,
  keep: (row: Record<string, string>) => boolean,
  prefilter?: (line: string) => boolean,
): Promise<{ header: string[]; rows: Record<string, string>[]; entries: string[] }> {
  const headers = new Map<string, { cols: string[]; sep: string }>();
  const rows: Record<string, string>[] = [];
  const entries = await zipLines(file, pick, (name, line, i) => {
    if (i === 0) {
      const sep = guessSep(line);
      headers.set(name, { cols: splitCsvLine(line, sep).map((c) => c.trim()), sep });
      return;
    }
    if (prefilter && !prefilter(line)) return;
    const h = headers.get(name)!;
    const v = splitCsvLine(line, h.sep);
    const r: Record<string, string> = {};
    h.cols.forEach((c, k) => (r[c] = (v[k] ?? "").trim()));
    if (keep(r)) rows.push(r);
  });
  return { header: [...headers.values()][0]?.cols ?? [], rows, entries };
}
