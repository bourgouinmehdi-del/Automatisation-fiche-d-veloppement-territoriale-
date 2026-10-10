import { config } from "../config";

/**
 * Couche d'abstraction pour la rédaction assistée par modèle de langage.
 *
 * Le modèle n'est JAMAIS une source de données : il reçoit un paragraphe
 * déjà rédigé par les gabarits déterministes et ne peut qu'en améliorer la
 * formulation. Toute sortie contenant un nombre absent du texte d'origine
 * est rejetée (voir `numbersPreserved`) et le texte d'origine est conservé.
 */
export interface LlmProvider {
  name: string;
  rewrite(text: string, context: string): Promise<string>;
}

class NoneProvider implements LlmProvider {
  name = "gabarits déterministes";
  async rewrite(text: string) {
    return text;
  }
}

class AnthropicProvider implements LlmProvider {
  name: string;
  constructor(private apiKey: string, private model: string) {
    this.name = `gabarits déterministes + reformulation ${model}`;
  }
  async rewrite(text: string, context: string) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1200,
        system:
          "Tu reformules des paragraphes de diagnostic territorial en français administratif clair. Interdictions absolues : ajouter, retirer ou modifier un chiffre, une date, un nom propre ou une source ; ajouter une information absente du texte ; formuler une hypothèse comme un fait. Réponds uniquement par le paragraphe reformulé.",
        messages: [{ role: "user", content: `Contexte : ${context}\n\nParagraphe :\n${text}` }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    return json.content?.find((c) => c.type === "text")?.text?.trim() || text;
  }
}

export function getProvider(): LlmProvider {
  if (config.llmProvider === "anthropic" && config.anthropicApiKey) return new AnthropicProvider(config.anthropicApiKey, config.anthropicModel);
  return new NoneProvider();
}

/** Extrait les nombres d'un texte (format français : espaces de milliers, virgule décimale). */
export function extractNumbers(text: string): string[] {
  return (text.match(/\d[\d\s  ]*(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/[\s  ]/g, "").replace(",", ".")).filter(Boolean);
}

/** Vrai si tous les nombres de la sortie figurent dans le texte d'origine. */
export function numbersPreserved(original: string, rewritten: string): boolean {
  const allowed = new Set(extractNumbers(original));
  return extractNumbers(rewritten).every((n) => allowed.has(n));
}

/** Reformule avec garde-fou ; en cas d'échec ou de violation, renvoie le texte d'origine. */
export async function safeRewrite(provider: LlmProvider, text: string, context: string): Promise<string> {
  if (provider instanceof NoneProvider) return text;
  try {
    const out = await provider.rewrite(text, context);
    return numbersPreserved(text, out) ? out : text;
  } catch {
    return text;
  }
}
