/** @type {import('next').NextConfig} */
const DATA_FILES = [
  "./node_modules/@etalab/decoupage-administratif/data/**/*",
  "./node_modules/@svg-maps/france.departments/index.js",
];

const nextConfig = {
  // Ces paquets embarquent des binaires natifs ou de gros fichiers JSON :
  // ils doivent rester côté serveur et ne pas être bundlés.
  serverExternalPackages: ["@resvg/resvg-js", "playwright-core", "@etalab/decoupage-administratif"],
  // Fichiers lus par fs (référentiel des communes, carte SVG) : à embarquer
  // explicitement dans les fonctions serverless (Vercel ne les détecte pas seul).
  outputFileTracingIncludes: {
    "/": DATA_FILES,
    "/**": DATA_FILES,
  },
};
export default nextConfig;
