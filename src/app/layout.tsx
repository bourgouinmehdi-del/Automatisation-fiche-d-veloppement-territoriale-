import type { Metadata } from "next";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/stack-sans-text";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { cookies } from "next/headers";
import { authEnabled, readSession, SESSION_COOKIE } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Fiches territoriales",
  description: "Génération automatisée de fiches de diagnostic territorial à partir de données publiques françaises",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Lecture du cookie à chaque requête (les comptes sont déclarés à l'exécution, pas à la construction).
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = authEnabled() ? readSession(token) : null;
  return (
    <html lang="fr">
      <body className="min-h-screen antialiased">
        <header className="site-header no-print">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 gap-4 pb-3 pt-7">
            <a href="/" className="site-logo no-underline">
              <span className="iso-soft">
                <span className="l1 block">Fiches</span>
                <span className="l2 block">territoriales</span>
              </span>
            </a>
            <nav className="site-nav flex gap-3 text-right text-xs sm:gap-5 sm:text-sm">
              <a href="/donnees-internes">
                Données internes
              </a>
              <a href="/methodologie">
                Méthodologie et sources
              </a>
              {user && (
                <form action="/api/auth/logout" method="post" className="inline">
                  <button className="site-logout" title={`Connecté : ${user}`}>
                    Déconnexion
                  </button>
                </form>
              )}
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
