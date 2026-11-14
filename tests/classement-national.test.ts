import { describe, expect, it } from "vitest";
import { centiles, classer, ecartsLg24, parseNegos, scoreOf, type NatCommune } from "@/lib/national/score";

// Communes fictives.
const C = (code: string, inscrits: number, votants: number, lfi: number, gauche: number, circo: string, nfp: number, rn: number): NatCommune => ({
  code,
  nom: `Ville ${code}`,
  dep: "99",
  reg: "00",
  pop: null,
  circo,
  circoPart: 1,
  pr22: { inscrits, votants, exprimes: votants - 100, lfi, gauche },
  eu24: { inscrits, votants: inscrits / 2, exprimes: inscrits / 2 - 50, lfi: lfi / 2 },
  lg24: { inscrits, exprimes: votants - 100, nfp, adv: { rn, ens: 100, lr: 50, rec: 10 } },
});
const cs = [
  C("99001", 10000, 6000, 2000, 600, "99-01", 2500, 2400), // circo serrée, gros réservoir
  C("99002", 10000, 8000, 800, 400, "99-02", 1500, 4000), // circo perdue
  C("99003", 4000, 2500, 900, 200, "99-01", 1000, 900),
  C("99004", 800, 500, 100, 20, "99-02", 100, 200), // sous le seuil
];

describe("classement national", () => {
  it("centiles : du plus faible (0) au plus fort (100), ex aequo au rang moyen", () => {
    expect(centiles([3, 1, 2, null])).toEqual([100, 0, 50, null]);
    expect(centiles([1, 1, 2])).toEqual([25, 25, 100]);
  });
  it("écart des législatives par circonscription (union de la gauche − premier adversaire)", () => {
    const e = ecartsLg24(cs);
    expect(e.get("99-01")!).toBeGreaterThan(0);
    expect(e.get("99-02")!).toBeLessThan(-10);
  });
  it("trois facteurs, seuil d'inscrits, bilan et négos", () => {
    const bilan = new Map([
      ["99001", { ga: 0, actions: 0, soutiens: 10 }],
      ["99002", { ga: 2, actions: 80, soutiens: 300 }],
      ["99003", { ga: 1, actions: 10, soutiens: 40 }],
    ]);
    const negos = parseNegos([{ circo: "99-1", "écart projeté": "-1,5" }, { circo: "99-02", "écart projeté": "12" }]);
    expect(negos.get("99-01")).toBe(-1.5);
    const l = classer(cs, { minInscrits: 1000, bilan, negos });
    expect(l.map((x) => x.code)).toEqual(["99001", "99002", "99003"]);
    const v1 = l.find((x) => x.code === "99001")!;
    expect(v1.ecartSource).toBe("negos");
    // Gros réservoir, aucun militant, circo serrée : premier (la circo seule départage 99001 et 99002).
    for (const w of [{ p: 45, m: 35, c: 20 }, { p: 0, m: 100, c: 0 }]) {
      const best = [...l].sort((a, b) => scoreOf(b, w) - scoreOf(a, w))[0];
      expect(best.code).toBe("99001");
    }
    expect(scoreOf(v1, { p: 0, m: 0, c: 100 })).toBeGreaterThan(scoreOf(l.find((x) => x.code === "99002")!, { p: 0, m: 0, c: 100 }));
    // Sans bilan : facteur militant absent, les autres poids rééchelonnés.
    const sans = classer(cs, { minInscrits: 1000 });
    expect(sans[0].f2).toBeNull();
    expect(scoreOf({ f1: 80, f2: null, f3: 40 }, { p: 50, m: 30, c: 20 })).toBeCloseTo((80 * 50 + 40 * 20) / 70);
  });
});

describe("potentiel pour un convoi", () => {
  // 99011 : grosse réserve de voix mais vote insoumis faible ; 99012 : vote insoumis fort, réserve moyenne.
  const villes = [
    C("99011", 6000, 5000, 400, 900, "99-03", 1200, 1500),
    C("99012", 6000, 4000, 1300, 200, "99-03", 1200, 1500),
    C("99013", 6000, 4500, 700, 300, "99-03", 1200, 1500),
  ];
  const mob = new Map([
    ["99011", 400],
    ["99012", 150],
    ["99013", 60],
  ]);
  it("le vote LFI compte autant que la réserve : un terrain difficile ne passe plus en tête", () => {
    const l = classer(villes, { minInscrits: 1000, mobilisables: mob });
    const a = l.find((x) => x.code === "99011")!;
    const b = l.find((x) => x.code === "99012")!;
    expect(a.noteReserve).toBeGreaterThan(b.noteReserve);
    expect(b.noteVote).toBeGreaterThan(a.noteVote);
    expect(b.f1).toBeGreaterThanOrEqual(a.f1);
    expect(a.raisons).toContain("vote LFI faible");
    expect(a.raisons).toContain("beaucoup de mobilisables");
    expect(b.raisons).toContain("vote LFI fort");
    // Mélenchon en part des exprimés, comme sur les fiches.
    expect(b.melExpPct).toBeCloseTo((100 * 1300) / 3900);
  });
  it("actions et soutiens rapportés aux voix Mélenchon, pas aux mobilisables", () => {
    const bilan = new Map([["99012", { ga: 1, actions: 13, soutiens: 26 }]]);
    const l = classer(villes, { minInscrits: 1000, mobilisables: mob, bilan });
    const b = l.find((x) => x.code === "99012")!;
    expect(b.actionsPour1000).toBeCloseTo(10);
    expect(b.soutiensPour1000).toBeCloseTo(20);
    expect(l.find((x) => x.code === "99011")!.raisons).toContain("aucun groupe d'action");
  });
  it("réserve de gauche signalée sur la fiche seulement quand elle est forte", async () => {
    const { mobilisablesRepere } = await import("@/lib/report/lfi");
    expect(mobilisablesRepere(320, 5500)).toEqual({ n: 320, pct: (100 * 320) / 5500, tres: true });
    expect(mobilisablesRepere(140, 5000)).toMatchObject({ n: 140, tres: false });
    expect(mobilisablesRepere(100, 10000)).toBeNull();
    expect(mobilisablesRepere(80, 2000)).toBeNull();
    expect(mobilisablesRepere(null, 2000)).toBeNull();
  });
});

describe("jeu de données national (API simulées)", () => {
  it("construit les communes d'un département avec leur circonscription", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const { vi } = await import("vitest");
    const { mockFetch } = await import("./fixtures/mock-apis");
    process.env.DATA_DIR = path.join(os.tmpdir(), `nat-${process.pid}`);
    process.env.INSEE_MIN_INTERVAL_MS = "0";
    vi.stubGlobal("fetch", mockFetch());
    vi.resetModules();
    const { buildNational, readNational, natJob } = await import("@/lib/national/donnees");
    await buildNational(["60"]);
    const nat = await readNational();
    vi.unstubAllGlobals();
    expect(natJob().done).toBe(1);
    expect(nat!.communes.length).toBeGreaterThan(0);
    const c = nat!.communes.find((x) => x.code === "60159")!;
    expect(c.pr22!.lfi).toBeGreaterThan(0);
    expect(c.circo).toMatch(/^60-\d{2}$/);
  }, 120000);
});

describe("export de Damien (mobilisables)", () => {
  it("lu par code INSEE ou par nom et département ; seules ces communes sont classées", async () => {
    const { parseMobilisables, classer, nomCle } = await import("@/lib/national/score");
    const idx = new Map([["99|ville 99001", "99001"]]);
    const m = parseMobilisables(
      [
        { rang: "1", commune: "Ville 99001", dept: "99", mobilisables: "500" },
        { rang: "2", commune: "Inconnue", dept: "99", mobilisables: "40" },
      ],
      (n, d) => idx.get(`${d}|${nomCle(n)}`) ?? null,
    );
    expect([...m]).toEqual([["99001", 500]]);
    const l = classer(cs, { minInscrits: 1000, mobilisables: m });
    expect(l.map((x) => x.code)).toEqual(["99001"]);
    expect(l[0].reservoir).toBe(500);
  });
});

describe("communes nouvelles", () => {
  it("une ancienne commune déléguée renvoie à sa commune nouvelle (référentiel public)", async () => {
    const { communeActuelle, anciennesCommunes } = await import("@/lib/collectors/admin");
    expect(communeActuelle("93059")).toBe("93066");
    expect(communeActuelle("93066")).toBe("93066");
    expect(anciennesCommunes("93066")).toContain("93059");
  });
  it("le classement additionne l'ancienne commune à la commune nouvelle", async () => {
    const { fusionnerCommunes } = await import("@/lib/national/score");
    const a = C("99021", 10000, 6000, 2000, 600, "99-05", 2500, 2400);
    const b = { ...C("99022", 5000, 3000, 1500, 200, "99-05", 1200, 900), circo: null, circoPart: null };
    const f = fusionnerCommunes([a, b, cs[1]], (k) => (k === "99022" ? "99021" : k), (k) => (k === "99021" ? "Ville nouvelle" : undefined));
    expect(f).toHaveLength(2);
    const n = f.find((x) => x.code === "99021")!;
    expect(n.nom).toBe("Ville nouvelle");
    expect(n.pr22).toEqual({ inscrits: 15000, votants: 9000, exprimes: 8800, lfi: 3500, gauche: 800 });
    expect(n.lg24!.adv.rn).toBe(3300);
    expect(n.circo).toBe("99-05");
  });
});
