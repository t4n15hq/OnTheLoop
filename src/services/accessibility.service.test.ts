import { beforeEach, describe, expect, it, vi } from 'vitest';

// axios.get is what fetchFresh calls; CacheService is mocked so we control
// cache hits/misses and can assert the feed is fetched at most once.
const axiosGet = vi.fn();
vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => axiosGet(...args) },
}));

const cacheStore = new Map<string, unknown>();
vi.mock('./cache.service', () => ({
  CacheService: {
    get: vi.fn(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    }),
  },
}));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// One elevator outage impacting a station (40530), plus a non-accessibility
// alert that must be ignored.
const FEED = {
  data: {
    CTAAlerts: {
      ErrorCode: '0',
      Alert: [
        {
          AlertId: '900',
          Headline: 'Elevator at Diversey out of service',
          ShortDescription: 'The elevator to the platform is temporarily out.',
          Impact: 'Elevator Status',
          AlertURL: { '#cdata-section': 'https://cta.example/900' },
          ImpactedService: {
            Service: { ServiceType: 'T', ServiceName: 'Diversey', ServiceId: '40530' },
          },
        },
        {
          AlertId: '901',
          Headline: 'Red Line delays',
          ShortDescription: 'Residual delays.',
          Impact: 'Minor Delays',
          ImpactedService: { Service: { ServiceType: 'R', ServiceName: 'Red', ServiceId: 'Red' } },
        },
      ],
    },
  },
};

describe('AccessibilityService', () => {
  beforeEach(() => {
    vi.resetModules();
    cacheStore.clear();
    axiosGet.mockReset().mockResolvedValue(FEED);
  });

  it('parses only elevator/escalator alerts into per-station outages', async () => {
    const { AccessibilityService } = await import('./accessibility.service');
    const outages = await AccessibilityService.getActiveOutages();

    expect(outages).toHaveLength(1);
    expect(outages[0]).toMatchObject({
      id: '900:40530',
      alertId: '900',
      stationId: '40530',
      stationName: 'Diversey',
      equipment: 'ELEVATOR',
      url: 'https://cta.example/900',
    });
  });

  it('serves from cache and does not hammer the upstream on repeated calls', async () => {
    const { AccessibilityService } = await import('./accessibility.service');
    await AccessibilityService.getActiveOutages();
    await AccessibilityService.getActiveOutages();

    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('getForStations filters to matching saved stations only', async () => {
    const { AccessibilityService } = await import('./accessibility.service');

    expect(await AccessibilityService.getForStations(['40530'])).toHaveLength(1);
    expect(await AccessibilityService.getForStations(['99999'])).toHaveLength(0);
    expect(await AccessibilityService.getForStations([])).toHaveLength(0);
  });

  it('falls back to stale last-good when the upstream errors', async () => {
    const { AccessibilityService } = await import('./accessibility.service');
    // Prime the stale cache with a successful fetch.
    await AccessibilityService.getActiveOutages();
    cacheStore.delete('cta:accessibility:v1'); // fresh cache expires
    axiosGet.mockRejectedValueOnce(new Error('CTA down'));

    const outages = await AccessibilityService.getActiveOutages();
    expect(outages).toHaveLength(1);
    expect(outages[0].stationId).toBe('40530');
  });
});
