import { NextResponse } from "next/server";
import { epciMembers, searchCommunes } from "@/lib/collectors/admin";

export const runtime = "nodejs";

/** Recherche de communes par code postal, code INSEE ou nom (référentiel embarqué, sans réseau). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const epci = url.searchParams.get("epci");
  if (epci) return NextResponse.json({ communes: epciMembers(epci) });
  return NextResponse.json({ query: q, communes: searchCommunes(q) });
}
