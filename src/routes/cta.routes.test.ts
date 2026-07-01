import { describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/rate-limit.middleware', () => ({
  aiLimiter: (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock('../middleware/auth.middleware', () => ({
  optionalAuthMiddleware: (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock('../controllers/cta.controller', () => ({
  CTAController: {
    getBusRoutes: vi.fn(),
    getBusDirections: vi.fn(),
    getBusStops: vi.fn(),
    findNearbyStops: vi.fn(),
    getTrainLines: vi.fn(),
    getTrainStations: vi.fn(),
    resolveLocation: vi.fn(),
    findStopsNearNaturalLocation: vi.fn(),
    getTransitSuggestion: vi.fn(),
    getArrivals: vi.fn(),
    parseRouteConfig: vi.fn(),
    getAlerts: vi.fn(),
  },
}));

async function runMiddleware(middleware: any, req: any, res: any): Promise<boolean> {
  let nextCalled = false;
  await new Promise<void>((resolve, reject) => {
    const next = (err?: unknown) => {
      if (err) reject(err);
      nextCalled = true;
      resolve();
    };
    const result = middleware(req, res, next);
    if (result && typeof result.then === 'function') {
      result.then(() => {
        if (!nextCalled) resolve();
      }, reject);
    } else {
      setImmediate(() => {
        if (!nextCalled) resolve();
      });
    }
  });
  return nextCalled;
}

describe('CTA AI route abuse controls', () => {
  it('rejects oversized AI parse-route queries', async () => {
    const { parseRouteValidation } = await import('./cta.routes');
    const req = { body: { query: 'x'.repeat(301) } };
    const res: any = {
      status: vi.fn(() => res),
      json: vi.fn(() => res),
    };

    for (const middleware of parseRouteValidation) {
      const continued = await runMiddleware(middleware, req, res);
      if (!continued) break;
    }

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      errors: expect.arrayContaining([
        expect.objectContaining({ msg: 'Query is too long' }),
      ]),
    });
  });
});
