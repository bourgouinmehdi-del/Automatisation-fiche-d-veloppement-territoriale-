import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR ??= path.join(os.tmpdir(), `fiche-runtime-${process.pid}`);

describe("exécution", () => {
  it("la file lourde limite le nombre de tâches simultanées", async () => {
    const { Lane } = await import("@/lib/runtime");
    const lane = new Lane(2);
    let now = 0;
    let max = 0;
    const task = () =>
      lane.run(async () => {
        now++;
        max = Math.max(max, now);
        await new Promise((r) => setTimeout(r, 20));
        now--;
        return 1;
      });
    const out = await Promise.all(Array.from({ length: 7 }, task));
    expect(out).toHaveLength(7);
    expect(max).toBe(2);
  });

  it("le cache disque conserve les Map et ne fige pas un résultat incomplet", async () => {
    const { cachedExtract } = await import("@/lib/runtime");
    const key = `test|${Date.now()}`;
    let calls = 0;
    const compute = async () => {
      calls++;
      return { m: new Map([["a", 1]]), ok: calls > 1 };
    };
    // 1er appel : incomplet → non mis en cache, recalcul au 2e appel.
    const a = await cachedExtract(key, 1, compute, (v) => v.ok);
    expect(a.ok).toBe(false);
    const b = await cachedExtract(key, 1, compute, (v) => v.ok);
    expect(b.ok).toBe(true);
    expect(b.m.get("a")).toBe(1);
    const c = await cachedExtract(key + "x", 1, compute);
    const d = await cachedExtract(key + "x", 1, compute);
    expect(d).toBe(c);
    expect(calls).toBe(3);
  });
});
