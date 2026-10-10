import { NextResponse } from "next/server";
import { getReport } from "@/lib/report/store";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getReport(id);
  if (!r) return NextResponse.json({ error: "Rapport introuvable" }, { status: 404 });
  return NextResponse.json(r);
}
