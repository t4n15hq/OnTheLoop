import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CTAController } from './cta.controller';

const mocks = vi.hoisted(() => ({
  getBusRoutes: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../services/cta-lookup.service', () => ({
  CTALookupService: {
    getBusRoutes: mocks.getBusRoutes,
  },
}));

vi.mock('../services/gemini-maps.service', () => ({
  GeminiMapsService: {},
}));

vi.mock('../services/cta.service', () => ({
  CTAService: {},
}));

vi.mock('../services/ai-sms.service', () => ({
  AISMSService: {},
}));

vi.mock('../services/alerts.service', () => ({
  AlertsService: {},
}));

vi.mock('../utils/sentry', () => ({
  reportError: mocks.reportError,
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

describe('CTAController error reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports swallowed CTA controller errors with route context', async () => {
    const err = new Error('CTA lookup failed');
    mocks.getBusRoutes.mockRejectedValueOnce(err);
    const res = mockResponse();

    await CTAController.getBusRoutes({} as any, res);

    expect(mocks.reportError).toHaveBeenCalledWith(err, { route: 'cta/bus-routes' });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'CTA lookup failed' });
  });
});
