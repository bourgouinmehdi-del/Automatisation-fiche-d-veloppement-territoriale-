import { createReadStream } from "node:fs";

/**
 * Balayage JSON en flux : parcourt un document morceau par morceau et ne
 * conserve que les sous-objets demandés. Sert à lire les fichiers nationaux
 * volumineux (contours des bureaux de vote, contours des QPV : 100 à 250 Mo)
 * sans jamais les charger entiers en mémoire, ce qui faisait redémarrer les
 * serveurs à mémoire limitée (512 Mo à 1 Go).
 *
 * `depth` = nombre de conteneurs ouverts avant l'élément ; `keys[d]` = dernière
 * clé lue au niveau d (la clé de l'élément courant au niveau d).
 */
export type CaptureTest = (opener: "{" | "[", depth: number, keys: readonly string[]) => boolean;

export class JsonScanner {
  private depth = 0;
  private inStr = false;
  private esc = false;
  private keys: string[] = [];
  private str = "";
  private strTracked = false;
  private lastStr = "";
  private capDepth = -1;
  private cap: string[] = [];
  private capStart = 0;

  constructor(
    private test: CaptureTest,
    private onValue: (text: string) => void,
  ) {}

  feed(chunk: string) {
    const capturing0 = this.capDepth >= 0;
    if (capturing0) this.capStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (ch === 92) this.esc = true;
        else if (ch === 34) {
          this.inStr = false;
          if (this.strTracked) this.lastStr = this.str;
        } else if (this.strTracked && this.str.length < 64) this.str += chunk[i];
        continue;
      }
      if (ch === 34) {
        this.inStr = true;
        // Seules les chaînes des premiers niveaux peuvent être des clés utiles.
        this.strTracked = this.capDepth < 0 && this.depth <= 5;
        this.str = "";
      } else if (ch === 58) {
        this.keys[this.depth] = this.lastStr;
      } else if (ch === 123 || ch === 91) {
        if (this.capDepth < 0 && this.test(ch === 123 ? "{" : "[", this.depth, this.keys)) {
          this.capDepth = this.depth;
          this.capStart = i;
          this.cap = [];
        }
        this.depth++;
        this.keys[this.depth] = "";
      } else if (ch === 125 || ch === 93) {
        this.depth--;
        if (this.capDepth === this.depth) {
          this.cap.push(chunk.slice(this.capStart, i + 1));
          const text = this.cap.join("");
          this.cap = [];
          this.capDepth = -1;
          this.onValue(text);
        }
      }
    }
    if (this.capDepth >= 0) this.cap.push(chunk.slice(this.capStart));
  }
}

/** Passe un fichier (texte UTF-8) dans un scanner, par blocs de 1 Mo. */
export function scanFile(file: string, test: CaptureTest, onValue: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const sc = new JsonScanner(test, onValue);
    const rs = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
    rs.on("data", (c) => {
      try {
        sc.feed(c as string);
      } catch (e) {
        rs.destroy();
        reject(e);
      }
    });
    rs.on("end", () => resolve());
    rs.on("error", reject);
  });
}

/** Même balayage sur un texte déjà en mémoire (petits fichiers, tests). */
export function scanText(text: string, test: CaptureTest, onValue: (text: string) => void) {
  new JsonScanner(test, onValue).feed(text);
}

/** Lit les premiers octets d'un fichier (détection du format). */
export function fileHead(file: string, bytes = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const rs = createReadStream(file, { encoding: "utf8", start: 0, end: bytes - 1 });
    rs.on("data", (c) => (out += c));
    rs.on("end", () => resolve(out));
    rs.on("error", reject);
  });
}

/** Test : entités d'une FeatureCollection GeoJSON (`features[i]`). */
export const geoJsonFeatures: CaptureTest = (o, d, k) => o === "{" && d === 2 && k[1] === "features";
