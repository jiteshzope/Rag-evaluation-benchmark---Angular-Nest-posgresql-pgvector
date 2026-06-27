/**
 * USD per 1M tokens. Used by the cost metric so the dashboard can answer the
 * question the whole benchmark exists for: does the retrieval improvement
 * justify the extra spend?
 *
 * Override with OPENAI_PRICE_* env vars if list prices move.
 */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

const PER_MILLION: Record<string, ModelPrice> = {
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'text-embedding-3-small': { input: 0.02, cachedInput: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, cachedInput: 0.13, output: 0 },
};

const FALLBACK: ModelPrice = { input: 0.05, cachedInput: 0.005, output: 0.4 };

export function priceFor(model: string): ModelPrice {
  return PER_MILLION[model] ?? PER_MILLION[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')] ?? FALLBACK;
}

/** Cost in USD for a single call. `cachedInputTokens` is a subset of `inputTokens`. */
export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const p = priceFor(model);
  const fresh = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (fresh * p.input) / 1_000_000 +
    (cachedInputTokens * p.cachedInput) / 1_000_000 +
    (outputTokens * p.output) / 1_000_000
  );
}
