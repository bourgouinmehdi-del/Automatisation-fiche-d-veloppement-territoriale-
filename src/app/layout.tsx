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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,500..800&family=Public+Sans:ital,wght@0,400..700;1,400&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-screen antialiased">
        <header className="site-header no-print">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
            <a href="/" className="site-logo no-underline">
              Fiches territoriales
            </a>
            <nav className="site-nav flex gap-5 text-sm">
              <a href="/donnees-internes">
                Données internes
              </a>
              <a href="/methodologie">
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
