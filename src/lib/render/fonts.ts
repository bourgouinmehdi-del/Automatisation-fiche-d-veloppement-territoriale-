import fs from "node:fs";
import path from "node:path";

/**
 * Polices de la charte (Archivo condensé pour les titres, Stack Sans Text pour
 * le texte) intégrées au HTML imprimé : le PDF ne dépend ni d'Internet ni des
 * polices installées sur le serveur. Union Gothic, police de la campagne, est
 * utilisée en priorité si elle est installée.
 */
let cached: string | null = null;

export function embeddedFontsCss(): string {
  if (cached != null) return cached;
  const root = path.join(process.cwd(), "node_modules", "@fontsource-variable");
  const face = (family: string, file: string, extra: string) => {
    try {
      const b64 = fs.readFileSync(path.join(root, file)).toString("base64");
      return `@font-face{font-family:'${family}';font-style:normal;font-display:block;${extra}src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
    } catch {
      return "";
    }
  };
  cached =
    face("Archivo Variable", "archivo/files/archivo-latin-wdth-normal.woff2", "font-weight:100 900;font-stretch:62% 125%;") +
    face("Stack Sans Text Variable", "stack-sans-text/files/stack-sans-text-latin-wght-normal.woff2", "font-weight:200 700;");
  return cached;
}
