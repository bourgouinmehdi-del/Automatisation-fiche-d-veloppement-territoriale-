import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";

export const metadata: Metadata = {
  title: "Fiches territoriales",
  description: "Génération automatisée de fiches de diagnostic territorial à partir de données publiques françaises",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen antialiased">
        <header className="no-print border-b border-[var(--line)] bg-white">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
            <a href="/" className="font-bold text-[var(--accent-strong)] no-underline">
              Fiches territoriales
            </a>
            <nav className="text-sm text-[var(--ink-2)]">
              <a href="/methodologie" className="text-[var(--ink-2)]">
                Méthodologie et sources
              </a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
