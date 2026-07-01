import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CTAController } from './cta.controller';

const mocks = vi.hoisted(() => ({
  parseQuery: vi.fn(),
  getBusRoutes: vi.fn(),
  getBusDirections: vi.fn(),
  getBusStops: vi.fn(),
  getBusPredictions: vi.fn(),
}));

vi.mock('../services/ai-sms.service', () => ({
  AISMSService: {
    parseQuery: mocks.parseQuery,
  },
}));

vi.mock('../services/cta-lookup.service', () => ({
  CTALookupService: {
    getBusRoutes: mocks.getBusRoutes,
    getBusDirections: mocks.getBusDirections,
    getBusStops: mocks.getBusStops,
  },
}));

vi.mock('../services/cta.service', () => ({
  CTAService: {
    getBusPredictions: mocks.getBusPredictions,
  },
}));

vi.mock('../services/gemini-maps.service', () => ({
  GeminiMapsService: {
    getTransitSuggestion: vi.fn(),
  },
}));

vi.mock('../services/alerts.service', () => ({
  AlertsService: {},
}));

vi.mock('../utils/db', () => ({
  default: {
    favorite: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function mockResponse() {
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}

describe('CTAController assistant fan-out bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks at most eight stops for a route-arrivals query', async () => {
    mocks.parseQuery.mockResolvedValueOnce({ intent: 'route_arrivals', routeNumber: '63' });
    mocks.getBusRoutes.mockResolvedValueOnce([{ rt: '63', rtnm: '63rd' }]);
    mocks.getBusDirections.mockResolvedValueOnce(['Eastbound']);
    mocks.getBusStops.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => ({ stpid: `s${i}`, stpnm: `Stop ${i}` }))
    );
    mocks.getBusPredictions.mockResolvedValue([]);
    const res = mockResponse();

    await CTAController.getTransitSuggestion({ query: { query: 'next 63' } } as any, res);

    expect(mocks.getBusPredictions).toHaveBeenCalledTimes(8);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
