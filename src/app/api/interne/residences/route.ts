import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { internalDir } from "@/lib/collectors/interne";
import { CATALOGUE_FILE, isPorteAPorte, loadCatalogue, parseCatalogue } from "@/lib/collectors/residences-etudiantes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function summary() {
  const cat = await loadCatalogue();
  return { origin: cat.origin, retrievedAt: cat.retrievedAt, residences: cat.list.length, porte: cat.list.filter(isPorteAPorte).length };
}

/** Catalogue utilisé (classeur déposé ou copie embarquée). */
export async function GET() {
  return NextResponse.json(await summary());
}

/** Dépôt du classeur mensuel (.xlsx) : vérifié avant d'être enregistré dans data/interne/. */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "Fichier manquant" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "Fichier trop volumineux (20 Mo au plus)" }, { status: 400 });
  const buf = new Uint8Array(await file.arrayBuffer());
  let n = 0;
  try {
    n = parseCatalogue(buf).list.length;
  } catch {
    return NextResponse.json({ error: "Classeur illisible : fichier Excel (.xlsx) attendu" }, { status: 400 });
  }
  if (!n) return NextResponse.json({ error: "Aucune résidence lue : onglets « Résidences » et « Adresses » (colonne « ID résidence ») attendus" }, { status: 400 });
  await fs.mkdir(internalDir(), { recursive: true });
  await fs.writeFile(path.join(internalDir(), CATALOGUE_FILE), buf);
  return NextResponse.json({ ok: true, info: `${n.toLocaleString("fr-FR")} résidences`, summary: await summary() });
}

/** Retour à la copie embarquée dans l'application. */
export async function DELETE() {
  await fs.rm(path.join(internalDir(), CATALOGUE_FILE), { force: true });
  return NextResponse.json({ ok: true, summary: await summary() });
}
