import { promises as fs } from "node:fs";
import path from "node:path";
import { parseCatalogue } from "../src/lib/collectors/residences-etudiantes";

/**
 * Met à jour la copie embarquée du catalogue des résidences étudiantes et
 * foyers de jeunes travailleurs à partir du classeur Excel mensuel :
 *   npm run import:residences -- chemin/vers/catalogue-logements-etudiants.xlsx
 */
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage : npm run import:residences -- <fichier.xlsx>");
  const cat = parseCatalogue(new Uint8Array(await fs.readFile(file)));
  if (!cat.list.length) throw new Error("Aucune résidence lue (onglets « Résidences » et « Adresses » attendus)");
  const out = path.join(__dirname, "../src/lib/collectors/data/residences-etudiantes.json");
  await fs.writeFile(out, JSON.stringify({ retrievedAt: cat.retrievedAt, list: cat.list }) + "\n");
  console.log(`${cat.list.length} résidences (relevé du ${cat.retrievedAt}) → ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
