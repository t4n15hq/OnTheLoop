import { describe, it, expect } from 'vitest';
import { validationResult } from 'express-validator';
import { createFavoriteValidation } from './favorite.controller';

// Run the express-validator chains directly against a mock request so we can
// assert the conditional cross-field rules without wiring up the middleware.
async function runFavoriteValidation(body: Record<string, unknown>) {
  const req: any = { body };
  for (const chain of createFavoriteValidation) {
    await chain.run(req);
  }
  return validationResult(req);
}

describe('createFavoriteValidation', () => {
  it('rejects a BUS favorite without a stopId', async () => {
    const result = await runFavoriteValidation({
      routeType: 'BUS',
      routeId: '157',
      name: 'Morning bus',
    });

    expect(result.isEmpty()).toBe(false);
    expect(result.array().some((e) => e.msg === 'Bus favorites require a stopId')).toBe(true);
  });

  it('rejects a TRAIN favorite without a stationId', async () => {
    const result = await runFavoriteValidation({
      routeType: 'TRAIN',
      routeId: 'Blue',
      name: 'Morning train',
    });

    expect(result.isEmpty()).toBe(false);
    expect(result.array().some((e) => e.msg === 'Train favorites require a stationId')).toBe(true);
  });

  it('accepts a complete BUS favorite', async () => {
    const result = await runFavoriteValidation({
      routeType: 'BUS',
      routeId: '157',
      stopId: '1234',
      name: 'Morning bus',
    });

    expect(result.isEmpty()).toBe(true);
  });
});
