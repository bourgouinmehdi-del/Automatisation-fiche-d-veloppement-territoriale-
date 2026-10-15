import { NextResponse } from "next/server";
import { epciMembers, intercoOf, searchCommunes } from "@/lib/collectors/admin";

export const runtime = "nodejs";

/** Recherche de communes par code postal, code INSEE ou nom (référentiel embarqué, sans réseau). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const epci = url.searchParams.get("epci");
  if (epci) return NextResponse.json({ communes: epciMembers(epci) });
  try {
    const communes = searchCommunes(q).map((c) => {
      const i = intercoOf(c.code);
      return { ...c, interco: i ? { nom: i.nom, communes: i.membres.length } : null };
    });
    return NextResponse.json({ query: q, communes });
  } catch (e) {
    return NextResponse.json({ query: q, communes: [], error: `Référentiel des communes illisible sur ce serveur : ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
}
