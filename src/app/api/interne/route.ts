import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { INTERNAL_FILES, internalDir, internalSummary, parseCsv, parseGroupes } from "@/lib/collectors/interne";

export const runtime = "nodejs";

/** État des données internes (fichiers présents, nombre de communes et de groupes reconnus). */
export async function GET() {
  return NextResponse.json(await internalSummary());
}

/**
 * Dépôt d'un fichier interne : `kind` = parrains | groupes | action-populaire.
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
