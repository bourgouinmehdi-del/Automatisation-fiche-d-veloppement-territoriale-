import path from "node:path";

/** Configuration lue depuis l'environnement (voir `.env.example`). */
export const config = {
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  cacheTtlHours: Number(process.env.CACHE_TTL_HOURS || 720),
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 20000),
  offline: process.env.OFFLINE === "1" || process.env.OFFLINE === "true",
  llmProvider: (process.env.LLM_PROVIDER || "none") as "none" | "anthropic",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  chromiumPath: process.env.CHROMIUM_PATH || "",
  /** Intervalle minimal entre deux requêtes INSEE (limite publique : 30 requêtes/minute). */
  inseeMinIntervalMs: Number(process.env.INSEE_MIN_INTERVAL_MS ?? 2100),
  overpassUrl: process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter",
  userAgent: "fiche-territoriale/0.1 (diagnostic territorial ; données publiques agrégées)",
};

export const cacheDir = () => path.join(config.dataDir, "cache");
export const reportsDir = () => path.join(config.dataDir, "reports");
