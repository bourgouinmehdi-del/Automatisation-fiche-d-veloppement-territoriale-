import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, readSession, SESSION_COOKIE } from "@/lib/auth";

/**
 * Toutes les pages et API exigent une session lorsque des comptes sont
 * déclarés (AUTH_USERS). Exceptions : page et API de connexion, ressources
 * statiques.
 */
export function middleware(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) return NextResponse.next();
  if (readSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Connexion requise" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  runtime: "nodejs",
  // Dépôt des gros fichiers (demandeurs d'emploi) : hors middleware, qui
  // recopierait le corps de la requête en mémoire (limite de 10 Mo) ; la
  // session y est vérifiée par la route elle-même.
  matcher: ["/((?!_next/|api/interne/emploi|icon\\.svg|favicon\\.ico|.*\\.(?:woff2?|png|svg|css|js)$).*)"],
};
