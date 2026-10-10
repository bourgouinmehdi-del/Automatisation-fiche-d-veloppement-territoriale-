/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ces paquets embarquent des binaires natifs ou de gros fichiers JSON :
  // ils doivent rester côté serveur et ne pas être bundlés.
  serverExternalPackages: ["@resvg/resvg-js", "playwright-core", "@etalab/decoupage-administratif"],
};
export default nextConfig;
