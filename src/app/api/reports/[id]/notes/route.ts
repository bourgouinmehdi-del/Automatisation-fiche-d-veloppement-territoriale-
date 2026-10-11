import { NextResponse } from "next/server";
import { saveFieldNotes } from "@/lib/report/store";

export const runtime = "nodejs";

/** Enregistre les retours du terrain d'une fiche (texte libre, repris dans les exports). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof body?.text !== "string") return NextResponse.json({ error: "Champ « text » attendu" }, { status: 400 });
  const notes = await saveFieldNotes(id, body.text);
  if (!notes) return NextResponse.json({ error: "Rapport introuvable" }, { status: 404 });
  return NextResponse.json(notes);
}
