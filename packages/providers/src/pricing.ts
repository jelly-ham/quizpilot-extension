import { z } from 'zod';

/** Upstream price per million tokens, in micro-USD (1 USD = 1_000_000). */
export const ModelPricing = z.object({
  inputMicroUsdPerMTok: z.number().int().nonnegative(),
  outputMicroUsdPerMTok: z.number().int().nonnegative(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

/** Jev: $0.042 / M input tokens, output free (docs.typesafe.ai/models). */
export const JEV_PRICING: ModelPricing = { inputMicroUsdPerMTok: 42_000, outputMicroUsdPerMTok: 0 };

export function costMicroUsd(p: ModelPricing, inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (inputTokens * p.inputMicroUsdPerMTok + outputTokens * p.outputMicroUsdPerMTok) / 1_000_000,
  );
}

/**
 * Usage for one upstream call. Prefer the cost the upstream reports (OpenRouter's `usage.cost`, USD);
 * otherwise compute it from our price table, if we have one.
 */
export function usageFrom(
  inputTokens: number,
  outputTokens: number,
  reportedCostUsd: number | undefined,
  pricing: ModelPricing | undefined,
): { inputTokens: number; outputTokens: number; costMicroUsd: number } {
  const cost =
    reportedCostUsd !== undefined
      ? Math.ceil(reportedCostUsd * 1_000_000)
      : pricing
        ? costMicroUsd(pricing, inputTokens, outputTokens)
        : 0;
  return { inputTokens, outputTokens, costMicroUsd: cost };
}
