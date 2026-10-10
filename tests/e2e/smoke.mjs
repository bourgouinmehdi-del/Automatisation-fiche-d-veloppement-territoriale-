/**
 * Test de fumée de bout en bout (serveur lancé au préalable) :
 *   BASE_URL=http://localhost:3000 CHROMIUM_PATH=/chemin/chrome node tests/e2e/smoke.mjs [dossier-captures]
 * Parcours : code postal ambigu (60350) → choix de Pierrefonds → génération → rapport → exports.
 */
import { chromium } from "playwright-core";
const S = process.argv[2] ?? ".";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await p.goto(BASE + "/");
await p.fill("#q", "60350");
await p.waitForSelector("text=communes correspondent");
await p.screenshot({ path: S + "/ui-home.png" });
await p.click("text=Pierrefonds");
await p.click("text=Générer la fiche");
await p.waitForURL(/generation/);
await p.waitForTimeout(1500);
await p.screenshot({ path: S + "/ui-progress.png" });
await p.waitForURL(/rapport/, { timeout: 120000 });
await p.waitForTimeout(1500);
await p.screenshot({ path: S + "/ui-report.png", fullPage: false });
await p.click("button:has-text(\"Sources\")");
await p.waitForTimeout(500);
await p.screenshot({ path: S + "/ui-sources.png" });
const id = p.url().split("/").pop();
for (const f of ["pdf", "docx", "csv", "json"]) {
  const r = await p.request.get(`${BASE}/api/reports/${id}/export/${f}`);
  console.log(f, r.status(), r.headers()["content-type"], (await r.body()).length);
}
console.log("errors", errors);
if (errors.length) process.exitCode = 1;
await b.close();
