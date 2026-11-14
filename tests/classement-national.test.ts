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
    expect(a.raisons).toContain("vote LFI sous le département");
    expect(a.raisons).toContain("beaucoup à remobiliser");
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
    expect(l.find((x) => x.code === "99011")!.raisons).toContain("aucun groupe actif");
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

describe("convois : interco et circonscriptions très perdues ou gagnées", () => {
  const villes = [
    C("99031", 8000, 5000, 1500, 300, "99-07", 1000, 1050), // circo serrée
    C("99032", 8000, 5000, 1500, 300, "99-08", 2500, 500), // circo très gagnée
    C("99033", 8000, 5000, 1500, 300, "99-07", 1000, 1050),
    C("99034", 8000, 5000, 600, 300, "99-07", 1000, 1050),
  ];
  it("un groupe actif ailleurs dans l'interco réduit le déficit militant", () => {
    const bilan = new Map([
      ["99031", { ga: 0, actions: 0, soutiens: 10 }],
      ["99033", { ga: 0, actions: 0, soutiens: 10 }],
      ["99034", { ga: 2, actions: 50, soutiens: 80 }],
      ["99099", { ga: 1, actions: 30, soutiens: 20 }], // commune voisine non classée
    ]);
    const interco = (k: string) => (k === "99031" || k === "99099" ? "EPCI-A" : k === "99034" ? "EPCI-B" : "EPCI-C");
    const l = classer(villes, { minInscrits: 1000, bilan, interco });
    const a = l.find((x) => x.code === "99031")!;
    const b = l.find((x) => x.code === "99033")!;
    expect(a.gaInterco).toBe(1);
    expect(b.gaInterco).toBe(0);
    expect(l.find((x) => x.code === "99034")!.gaInterco).toBe(0);
    expect(a.raisons).toContain("groupe actif dans l'interco");
    const sans = classer(villes, { minInscrits: 1000, bilan });
    expect(a.f2!).toBeLessThan(sans.find((x) => x.code === "99031")!.f2!);
  });
  it("note circo nulle au-delà de 25 points d'écart", () => {
    const l = classer(villes, { minInscrits: 1000 });
    expect(Math.abs(l.find((x) => x.code === "99032")!.ecartCirco!)).toBeGreaterThan(25);
    expect(l.find((x) => x.code === "99032")!.f3).toBe(0);
    expect(l.find((x) => x.code === "99031")!.f3).toBeGreaterThan(0);
  });
});

describe("convois : volume de voix, département, groupes à moins de 15 km", () => {
  it("à pourcentage égal, la commune qui a le plus de voix a une meilleure note de vote", () => {
    const petit = C("99041", 2500, 1600, 400, 50, "99-11", 500, 520);
    const grand = C("99042", 25000, 16000, 4000, 500, "99-12", 5000, 5200);
    const autre = C("99043", 8000, 5000, 900, 200, "99-13", 1500, 1500);
    const l = classer([petit, grand, autre], { minInscrits: 1000 });
    expect(l.find((x) => x.code === "99042")!.noteVote).toBeGreaterThan(l.find((x) => x.code === "99041")!.noteVote);
  });
  it("vote Mélenchon nettement sous le département : potentiel réduit et raison affichée", () => {
    // Même département 99 : 99051 vote très peu LFI par rapport aux autres.
    const vs = [C("99051", 8000, 5000, 400, 900, "99-14", 1500, 1500), C("99052", 8000, 5000, 1600, 200, "99-14", 1500, 1500), C("99053", 8000, 5000, 1500, 200, "99-15", 1500, 1500)];
    const l = classer(vs, { minInscrits: 1000 });
    const a = l.find((x) => x.code === "99051")!;
    expect(a.sousDep).toBe(true);
    expect(a.raisons).toContain("vote LFI sous le département");
    expect(l.find((x) => x.code === "99052")!.sousDep).toBe(false);
  });
  it("groupes actifs à moins de 15 km, hors commune ; prioritaire sur l'interco", async () => {
    const { groupesProches } = await import("@/lib/national/score");
    const centres = new Map<string, [number, number]>([
      ["99061", [2.0, 48.0]],
      ["99062", [2.5, 48.0]], // ~37 km à l'est
    ]);
    const gs = [
      { code: "99061", lon: 2.0, lat: 48.0 }, // dans la commune : ne compte pas pour elle
      { code: "99063", lon: 2.1, lat: 48.05 }, // ~9 km de 99061
      { code: "99064", lon: 2.9, lat: 48.0 }, // loin de tout
    ];
    const p = groupesProches(centres, gs);
    expect(p.get("99061")).toBe(1);
    expect(p.get("99062")).toBe(0);
    const v = [C("99061", 8000, 5000, 1500, 300, "99-16", 1000, 1050), C("99062", 8000, 5000, 1500, 300, "99-17", 1000, 1050)];
    const bilan = new Map([
      ["99061", { ga: 0, actions: 0, soutiens: 5 }],
      ["99062", { ga: 0, actions: 0, soutiens: 5 }],
    ]);
    const l = classer(v, { minInscrits: 1000, bilan, interco: () => "EPCI", gaProches: p });
    const a = l.find((x) => x.code === "99061")!;
    expect(a.gaVoisinage).toBe("15km");
    expect(a.raisons).toContain("groupe actif à moins de 15 km");
    expect(l.find((x) => x.code === "99062")!.raisons).toContain("aucun groupe actif");
  });
  it("position des groupes lue dans l'export SQL (point WKB)", async () => {
    const { pointWkb } = await import("@/lib/collectors/interne");
    // Point fictif (2.5, 48.5), écrit comme dans l'export : octets en représentation Python, échappés deux fois.
    const b = Buffer.alloc(21);
    b[0] = 1;
    b.writeUInt32LE(1, 1);
    b.writeDoubleLE(2.5, 5);
    b.writeDoubleLE(48.5, 13);
    const repr = "b'" + [...b].map((x) => "\\\\x" + x.toString(16).padStart(2, "0")).join("") + "'";
    expect(pointWkb(repr)).toEqual([2.5, 48.5]);
    expect(pointWkb(repr.replace(/\\\\\\\\/g, "\\\\"))).toEqual([2.5, 48.5]);
    expect(pointWkb("")).toBeNull();
  });
});

describe("terrain difficile et circonscription inconnue", () => {
  it("vote sous le département : score réduit de 15 %", () => {
    expect(scoreOf({ f1: 80, f2: 80, f3: 80, sousDep: true }, { p: 1, m: 1, c: 1 })).toBeCloseTo(68);
    expect(scoreOf({ f1: 80, f2: 80, f3: 80 }, { p: 1, m: 1, c: 1 })).toBeCloseTo(80);
  });
  it("sans circonscription connue : note circo neutre (50)", () => {
    const v = [C("99071", 8000, 5000, 1500, 300, "99-18", 1000, 1050), C("99072", 8000, 5000, 1400, 300, "99-19", 1500, 1000), { ...C("99073", 8000, 5000, 1300, 300, "99-20", 1000, 1050), circo: null }];
    const l = classer(v, { minInscrits: 1000 });
    expect(l.find((x) => x.code === "99073")!.f3).toBe(50);
  });
});
