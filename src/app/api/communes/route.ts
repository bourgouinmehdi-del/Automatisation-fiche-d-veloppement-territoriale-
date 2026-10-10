import { NextResponse } from "next/server";
import { epciMembers, searchCommunes } from "@/lib/collectors/admin";

export const runtime = "nodejs";

/** Recherche de communes par code postal, code INSEE ou nom (référentiel embarqué, sans réseau). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const epci = url.searchParams.get("epci");
  if (epci) return NextResponse.json({ communes: epciMembers(epci) });
  try {
    return NextResponse.json({ query: q, communes: searchCommunes(q) });
  } catch (e) {
    return NextResponse.json({ query: q, communes: [], error: `Référentiel des communes illisible sur ce serveur : ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
}
