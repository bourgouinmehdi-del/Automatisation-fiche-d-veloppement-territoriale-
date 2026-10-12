import { NextResponse } from "next/server";
import { saveFieldPlaces } from "@/lib/report/store";
import type { FieldPlace } from "@/lib/types";

export const runtime = "nodejs";

/** Enregistre les lieux d'action signalés par les militants (géolocalisés et rattachés à un bureau). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
  if (!Array.isArray(body?.items)) return NextResponse.json({ error: "Champ « items » attendu (liste de lieux)" }, { status: 400 });
  const places = await saveFieldPlaces(id, body.items as FieldPlace[]);
  if (!places) return NextResponse.json({ error: "Rapport introuvable" }, { status: 404 });
  return NextResponse.json(places);
}
