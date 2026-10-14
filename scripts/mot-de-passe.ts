/**
 * Produit une entrée chiffrée pour AUTH_USERS :
 *   npm run mot-de-passe -- prenom.nom
 * puis saisir le mot de passe. Copier la ligne affichée dans la variable
 * AUTH_USERS de l'hébergeur (plusieurs comptes séparés par « ; »).
 */
import readline from "node:readline";
import { hashPassword } from "../src/lib/auth";

const login = (process.argv[2] ?? "").trim().toLowerCase();
if (!login || login.includes(":") || login.includes(";")) {
  console.error("Usage : npm run mot-de-passe -- <identifiant>");
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`Mot de passe pour ${login} : `, (pw) => {
  rl.close();
  if (pw.length < 10) {
    console.error("Mot de passe trop court (10 caractères au moins).");
    process.exit(1);
  }
  console.log(`\n${login}:${hashPassword(pw)}\n`);
});
