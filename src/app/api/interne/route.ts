import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { INTERNAL_FILES, bilanToCsv, internalDir, internalSummary, investie, listesLfiToCsv, parseCsv, parseGroupes, parseMunicipalesLfi, splitSheetsText } from "@/lib/collectors/interne";
import { readXlsx, sheetObjects } from "@/lib/collectors/xlsx";

export const runtime = "nodejs";

/** État des données internes (fichiers présents, nombre de communes et de groupes reconnus). */
export async function GET() {
  return NextResponse.json(await internalSummary());
}

/**
 * Dépôt d'un fichier interne : `kind` = parrains | groupes | action-populaire | bilan.
 * Le bilan peut être un classeur Excel : il est converti en CSV compact.
 * Le fichier est vérifié (lecture CSV) avant d'être enregistré dans data/interne/.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const kind = String(form?.get("kind") ?? "");
  const file = form?.get("file");
  const name = `${kind}.csv`;
  if (!(INTERNAL_FILES as readonly string[]).includes(name)) return NextResponse.json({ error: "Type de fichier inconnu" }, { status: 400 });
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "Fichier manquant" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "Fichier trop volumineux (20 Mo au plus)" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  if (kind === "bilan") {
    let rows: Record<string, string>[] = [];
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      try {
        const sheet = [...readXlsx(new Uint8Array(buf)).values()][0] ?? [];
        rows = sheetObjects(sheet, /^code_?(insee|commune)$/i);
      } catch {
        return NextResponse.json({ error: "Classeur illisible : fichier Excel (.xlsx) ou CSV attendu" }, { status: 400 });
      }
    } else rows = parseCsv(buf.toString("utf8"));
    const { csv, n } = bilanToCsv(rows);
    if (!n) return NextResponse.json({ error: "Aucune commune lue : colonnes code_insee, nb_actions…, nb_ga…, nb_parrains…, inscrits… attendues" }, { status: 400 });
    await fs.mkdir(internalDir(), { recursive: true });
    await fs.writeFile(path.join(internalDir(), name), csv);
    return NextResponse.json({ ok: true, info: `${n.toLocaleString("fr-FR")} communes`, summary: await internalSummary() });
  }
  if (kind === "municipales-lfi") {
    // Classeur de synthèse (un onglet par situation) : Excel, ou texte « ## Sheet name: … » exporté du tableur.
    let sheets: { name: string; rows: string[][] }[] = [];
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      try {
        sheets = [...readXlsx(new Uint8Array(buf))].map(([name, rows]) => ({ name, rows }));
      } catch {
        return NextResponse.json({ error: "Classeur illisible : fichier Excel (.xlsx) attendu" }, { status: 400 });
      }
    } else {
      const text = buf.toString("utf8");
      // Un seul onglet exporté en CSV : la situation se lit dans le nom du fichier (« … - UG TDL FI.csv »).
      const fname = file instanceof File ? file.name.replace(/\.[^.]+$/, "") : "";
      sheets = /^## Sheet name:/m.test(text) ? splitSheetsText(text) : splitSheetsText(`## Sheet name: ${fname.split(" - ").pop() ?? fname}\n${text}`);
    }
    const { listes, unmatched } = parseMunicipalesLfi(sheets);
    if (!listes.length) return NextResponse.json({ error: "Aucune commune lue : un onglet par situation, colonnes « Département », « Commune », « TDL 1 Prénom », « TDL 1 NOM » attendues" }, { status: 400 });
    await fs.mkdir(internalDir(), { recursive: true });
    await fs.writeFile(path.join(internalDir(), name), listesLfiToCsv(listes));
    const ok = listes.filter(investie).length;
    return NextResponse.json({ ok: true, info: `${ok.toLocaleString("fr-FR")} listes investies (« Ok »), ${(listes.length - ok).toLocaleString("fr-FR")} en attente ou plantées${unmatched.length ? ` ; commune non reconnue : ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "…" : ""}` : ""}`, summary: await internalSummary() });
  }
  // UTF-8 attendu ; repli ISO-8859-1 (exports de tableurs).
  let text = buf.toString("utf8");
  if (text.includes("�")) text = buf.toString("latin1");
  const rows = parseCsv(text);
  if (!rows.length) return NextResponse.json({ error: "Aucune ligne lisible (CSV attendu, séparateur « ; » ou « , »)" }, { status: 400 });
  let info = `${rows.length} lignes`;
  if (kind !== "parrains") {
    const g = parseGroupes(rows, name);
    if (!g.groupes.length) return NextResponse.json({ error: "Aucun groupe reconnu : colonnes « nom » et « code postal / ville » (ou « code_commune ») attendues" }, { status: 400 });
    info = `${g.groupes.length} groupes rattachés à une commune${g.unmatched ? `, ${g.unmatched} sans commune reconnue` : ""}`;
  }
  await fs.mkdir(internalDir(), { recursive: true });
  await fs.writeFile(path.join(internalDir(), name), text);
  return NextResponse.json({ ok: true, info, summary: await internalSummary() });
}

/** Suppression d'un fichier interne. */
export async function DELETE(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind") ?? "";
  const name = `${kind}.csv`;
  if (!(INTERNAL_FILES as readonly string[]).includes(name)) return NextResponse.json({ error: "Type de fichier inconnu" }, { status: 400 });
  await fs.rm(path.join(internalDir(), name), { force: true });
  return NextResponse.json({ ok: true, summary: await internalSummary() });
}
