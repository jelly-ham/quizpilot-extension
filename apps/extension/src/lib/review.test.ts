import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeReviewPrompt,
  recordAnsweredRun,
  REVIEW_AFTER_RUNS,
  shouldAskForReview,
} from './review';

beforeEach(() => {
  const store: Record<string, unknown> = {};
  (chrome as unknown as { storage: unknown }).storage = {
    local: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
    },
  };
});

describe('review prompt', () => {
  it('asks only after enough answered runs', async () => {
    for (let i = 0; i < REVIEW_AFTER_RUNS - 1; i++) await recordAnsweredRun();
    expect(await shouldAskForReview()).toBe(false);
    await recordAnsweredRun();
    expect(await shouldAskForReview()).toBe(true);
  });

  it('never asks again once closed', async () => {
    for (let i = 0; i < REVIEW_AFTER_RUNS; i++) await recordAnsweredRun();
    await closeReviewPrompt();
    expect(await shouldAskForReview()).toBe(false);
    await recordAnsweredRun();
    expect(await shouldAskForReview()).toBe(false);
  });
});
