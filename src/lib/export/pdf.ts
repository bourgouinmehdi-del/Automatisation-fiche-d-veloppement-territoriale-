import fs from "node:fs";
import { chromium } from "playwright-core";
import { config } from "../config";
import { fmtDate } from "../format";
import { renderReportHtml } from "../render/html";
import type { Report } from "../types";

/**
 * Export PDF : rendu HTML imprimable converti par Chromium (headless).
 * En-tête, pied de page et pagination sont gérés par le moteur d'impression.
 */

export function findChromium(): string | undefined {
  const candidates = [
    config.chromiumPath,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean) as string[];
  // Répertoires d'installation de Playwright (ex. /opt/pw-browsers/chromium-1194/chrome-linux/chrome).
  for (const base of ["/opt/pw-browsers", `${process.env.HOME}/.cache/ms-playwright`]) {
    try {
      for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse())
        candidates.push(`${base}/${d}/chrome-linux/chrome`, `${base}/${d}/chrome-linux64/chrome`);
    } catch {
      /* absent */
    }
  }
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export async function reportToPdf(r: Report): Promise<Buffer> {
  const executablePath = findChromium();
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--font-render-hinting=none"] });
  try {
    const page = await browser.newPage();
    await page.setContent(renderReportHtml(r), { waitUntil: "load" });
    const small = `font-family: Arial, sans-serif; font-size: 7.5pt; color: #52514e; width: 100%; padding: 0 16mm;`;
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
      headerTemplate: `<div style="${small} display:flex; justify-content:space-between;"><span>Diagnostic territorial — ${r.commune.nom.replace(/</g, "")} (${r.commune.code})</span><span>${fmtDate(r.updatedAt)}</span></div>`,
      footerTemplate: `<div style="${small} display:flex; justify-content:space-between;"><span>Données publiques — voir bibliographie</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
