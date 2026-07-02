import { describe, it, expect, vi } from 'vitest';

// Mock the heavy service graph so importing the orchestrator never touches the
// network, Redis, or Prisma. Tests drive `answer()` with injected fake deps, so
// these mocks only need to exist — their implementations are never called.
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/db', () => ({ default: { favorite: { findMany: vi.fn() } } }));
vi.mock('../ai-sms.service', () => ({ AISMSService: { parseQuery: vi.fn() } }));
vi.mock('../gemini-maps.service', () => ({
  GeminiMapsService: { getTransitSuggestion: vi.fn() },
}));
vi.mock('../cta.service', () => ({
  CTAService: { getBusPredictions: vi.fn(), getTrainArrivals: vi.fn() },
}));
vi.mock('../cta-lookup.service', () => ({
  CTALookupService: {
    getBusRoutes: vi.fn(),
    getBusDirections: vi.fn(),
    getBusStops: vi.fn(),
    getTrainStations: vi.fn(),
  },
}));

import { answer } from './assistant.service';
import type { AssistantDeps } from './deps';
import type { ArrivalLike, ParsedIntent } from './types';

function makeDeps(overrides: Partial<AssistantDeps> = {}): AssistantDeps {
  return {
    parseQuery: vi.fn(async (): Promise<ParsedIntent> => ({ intent: 'unknown' })),
    getFavorites: vi.fn(async () => []),
    getTransitSuggestion: vi.fn(async () => 'AI directions.'),
    getBusRoutes: vi.fn(async () => []),
    getBusDirections: vi.fn(async () => []),
    getBusStops: vi.fn(async () => []),
    getBusPredictions: vi.fn(async () => [] as ArrivalLike[]),
    getTrainArrivals: vi.fn(async () => [] as ArrivalLike[]),
    getTrainStations: vi.fn(async () => []),
    ...overrides,
  };
}

describe('assistant.answer — favorite lookup', () => {
  it('answers from a matching bus favorite', async () => {
    const deps = makeDeps({
      getFavorites: vi.fn(async () => [
        {
          name: 'Home Express',
          routeType: 'BUS',
          routeId: '22',
          direction: 'Northbound',
          stopId: 'stop-1',
          boardingStopName: 'Clark & Diversey',
        },
      ]),
      getBusPredictions: vi.fn(async () => [
        { destination: 'Howard', minutesAway: 5, isApproaching: false, isDelayed: false },
      ]),
    });

    const result = await answer({ query: 'when is my Home Express', userId: 'u1' }, deps);

    expect(result.answer).toContain('🚌 Home Express');
    expect(result.realTimeArrivals).toMatchObject({ route: '22', routeName: 'Home Express' });
    expect(deps.getBusPredictions).toHaveBeenCalledWith('stop-1', '22', 3, 'Northbound');
    // Favorite short-circuits before the AI fallback.
    expect(deps.getTransitSuggestion).not.toHaveBeenCalled();
  });

  it('answers from a matching train favorite (train-line lookup)', async () => {
    const getTrainArrivals = vi.fn(async () => [
      { destination: '95th', minutesAway: 3, isApproaching: false, isDelayed: false },
    ]);
    const deps = makeDeps({
      getFavorites: vi.fn(async () => [
        {
          name: 'Gym Red trip',
          routeType: 'TRAIN',
          routeId: 'Red',
          direction: '1',
          stationId: 'station-9',
          boardingStopName: 'Belmont',
        },
      ]),
      getTrainArrivals,
    });

    const result = await answer({ query: 'next Red gym train', userId: 'u1' }, deps);

    expect(getTrainArrivals).toHaveBeenCalledWith('station-9', 'Red', '1');
    expect(result.realTimeArrivals).toMatchObject({ route: 'Red' });
  });

  it('skips favorites for anonymous callers', async () => {
    const getFavorites = vi.fn(async () => []);
    const deps = makeDeps({
      getFavorites,
      parseQuery: vi.fn(async (): Promise<ParsedIntent> => ({ intent: 'unknown' })),
    });
    await answer({ query: 'when is my Home Express' }, deps);
    expect(getFavorites).not.toHaveBeenCalled();
  });
});

describe('assistant.answer — route arrivals', () => {
  it('returns live route arrivals with a following list', async () => {
    const deps = makeDeps({
      parseQuery: vi.fn(async (): Promise<ParsedIntent> => ({
        intent: 'route_arrivals',
        routeNumber: '60',
      })),
      getBusRoutes: vi.fn(async () => [{ rt: '60', rtnm: 'Blue Island/26th' }]),
      getBusDirections: vi.fn(async () => ['Eastbound']),
      getBusStops: vi.fn(async () => [{ stpid: '5', stpnm: 'Racine' }]),
      getBusPredictions: vi.fn(async () => [
        { destination: 'Downtown', minutesAway: 2, isApproaching: false, isDelayed: false },
        { destination: 'Downtown', minutesAway: 12, isApproaching: false, isDelayed: false },
      ]),
    });

    const result = await answer({ query: 'next 60 bus' }, deps);

    expect(result.answer).toContain('🚌 Route 60 Eastbound');
    expect(result.answer).toContain('Following: 12 min');
    expect(result.realTimeArrivals).toMatchObject({ route: '60', routeName: 'Blue Island/26th' });
    expect(deps.getTransitSuggestion).not.toHaveBeenCalled();
  });

  it('returns the no-service message when a route has no live arrivals', async () => {
    const deps = makeDeps({
      parseQuery: vi.fn(async (): Promise<ParsedIntent> => ({
        intent: 'route_arrivals',
        routeNumber: '99',
      })),
      getBusRoutes: vi.fn(async () => [{ rt: '99', rtnm: 'Test Route' }]),
      getBusDirections: vi.fn(async () => ['Northbound']),
      getBusStops: vi.fn(async () => [{ stpid: '1', stpnm: 'Main' }]),
      getBusPredictions: vi.fn(async () => [] as ArrivalLike[]),
    });

    const result = await answer({ query: 'next 99 bus' }, deps);

    expect(result.answer).toContain('No buses are currently running on this route.');
    expect(result.realTimeArrivals).toBeNull();
  });
});

describe('assistant.answer — directions', () => {
  it('leads with AI directions and appends a live footer', async () => {
    const getTransitSuggestion = vi.fn(async () => 'Take Route 22 north.');
    const deps = makeDeps({
      parseQuery: vi.fn(async (): Promise<ParsedIntent> => ({
        intent: 'transit_directions',
        origin: 'A',
        destination: 'B',
      })),
      getTransitSuggestion,
      getBusRoutes: vi.fn(async () => [{ rt: '22', rtnm: 'Clark' }]),
      getBusDirections: vi.fn(async () => ['Northbound']),
      getBusStops: vi.fn(async () => [{ stpid: '9', stpnm: 'Clark & Foster' }]),
      getBusPredictions: vi.fn(async () => [
        { destination: 'Howard', minutesAway: 4, isApproaching: false, isDelayed: false },
      ]),
    });

    const result = await answer({ query: 'A to B' }, deps);

    expect(result.answer).toContain('Take Route 22 north.');
    expect(result.answer).toContain('⚡ Live right now:');
    expect(result.answer).toContain('🚌 Route 22 → 4 min @ Clark & Foster');
    // Directions AI call happens exactly once — no re-run for the answer.
    expect(getTransitSuggestion).toHaveBeenCalledTimes(1);
  });

  it('keeps the directions answer and calls the AI once when enrichment fails (double-call fix)', async () => {
    const getTransitSuggestion = vi.fn(async () => 'Directions text');
    const deps = makeDeps({
      parseQuery: vi.fn(async (): Promise<ParsedIntent> => ({
        intent: 'transit_directions',
        origin: 'A',
        destination: 'B',
      })),
      getTransitSuggestion,
      getBusRoutes: vi.fn(async () => {
        throw new Error('CTA down');
      }),
    });

    const result = await answer({ query: 'A to B' }, deps);

    expect(result.answer).toBe('Directions text');
    expect(result.realTimeArrivals).toBeNull();
    expect(getTransitSuggestion).toHaveBeenCalledTimes(1);
  });
});

describe('assistant.answer — malformed AI / unknown intent', () => {
  it('falls back to the AI suggestion without throwing', async () => {
    const getTransitSuggestion = vi.fn(async () => 'Here are some directions.');
    const deps = makeDeps({
      // parseQuery already swallows malformed AI JSON and yields 'unknown'.
      parseQuery: vi.fn(async (): Promise<ParsedIntent> => ({ intent: 'unknown' })),
      getTransitSuggestion,
    });

    const result = await answer({ query: 'asdf qwerty', userId: 'u1' }, deps);

    expect(result.answer).toBe('Here are some directions.');
    expect(result.realTimeArrivals).toBeNull();
    expect(getTransitSuggestion).toHaveBeenCalledTimes(1);
  });
});

describe('assistant.answer — fast-path (zero Gemini)', () => {
  it('answers "next 22" from the CTA API without touching Gemini', async () => {
    const parseQuery = vi.fn(async (): Promise<ParsedIntent> => ({ intent: 'unknown' }));
    const getTransitSuggestion = vi.fn(async () => 'AI directions.');
    const deps = makeDeps({
      parseQuery,
      getTransitSuggestion,
      getBusRoutes: vi.fn(async () => [{ rt: '22', rtnm: 'Clark' }]),
      getBusDirections: vi.fn(async () => ['Northbound']),
      getBusStops: vi.fn(async () => [{ stpid: '9', stpnm: 'Clark & Foster' }]),
      getBusPredictions: vi.fn(async () => [
        { destination: 'Howard', minutesAway: 4, isApproaching: false, isDelayed: false },
      ]),
    });

    const result = await answer({ query: 'next 22' }, deps);

    expect(result.answer).toContain('🚌 Route 22');
    expect(result.realTimeArrivals).toMatchObject({ route: '22' });
    // The whole point: NO Gemini calls (neither parse nor suggestion).
    expect(parseQuery).not.toHaveBeenCalled();
    expect(getTransitSuggestion).not.toHaveBeenCalled();
  });

  it('answers a bare route number with zero Gemini calls', async () => {
    const parseQuery = vi.fn(async (): Promise<ParsedIntent> => ({ intent: 'unknown' }));
    const deps = makeDeps({
      parseQuery,
      getBusRoutes: vi.fn(async () => [{ rt: '60', rtnm: 'Blue Island/26th' }]),
      getBusDirections: vi.fn(async () => ['Eastbound']),
      getBusStops: vi.fn(async () => [{ stpid: '5', stpnm: 'Racine' }]),
      getBusPredictions: vi.fn(async () => [
        { destination: 'Downtown', minutesAway: 3, isApproaching: false, isDelayed: false },
      ]),
    });

    const result = await answer({ query: '60' }, deps);

    expect(result.realTimeArrivals).toMatchObject({ route: '60' });
    expect(parseQuery).not.toHaveBeenCalled();
  });

  it('answers "when\'s the blue line at Belmont" from train arrivals, no Gemini', async () => {
    const parseQuery = vi.fn(async (): Promise<ParsedIntent> => ({ intent: 'unknown' }));
    const getTransitSuggestion = vi.fn(async () => 'AI directions.');
    const getTrainStations = vi.fn(async () => [
      { map_id: '41320', station_name: 'Belmont', directions: ['1', '5'] },
      { map_id: '40060', station_name: 'Damen', directions: ['1', '5'] },
    ]);
    const getTrainArrivals = vi.fn(async () => [
      { destination: 'O\'Hare', minutesAway: 6, isApproaching: false, isDelayed: false },
    ]);
    const deps = makeDeps({ parseQuery, getTransitSuggestion, getTrainStations, getTrainArrivals });

    const result = await answer({ query: "when's the blue line at Belmont" }, deps);

    expect(getTrainStations).toHaveBeenCalledWith('Blue');
    expect(getTrainArrivals).toHaveBeenCalledWith('41320', 'Blue', undefined);
    expect(result.answer).toContain('🚊 Blue Line');
    expect(result.answer).toContain('Belmont');
    expect(result.realTimeArrivals).toMatchObject({ route: 'Blue', routeName: 'Blue Line' });
    expect(parseQuery).not.toHaveBeenCalled();
    expect(getTransitSuggestion).not.toHaveBeenCalled();
  });

  it('gives a deterministic hint (no Gemini) when a fast-pathed route has no arrivals', async () => {
    const parseQuery = vi.fn(async (): Promise<ParsedIntent> => ({ intent: 'unknown' }));
    const getTransitSuggestion = vi.fn(async () => 'AI directions.');
    const deps = makeDeps({
      parseQuery,
      getTransitSuggestion,
      // Route not found in CTA routes → no answer, but must NOT hit Gemini.
      getBusRoutes: vi.fn(async () => []),
    });

    const result = await answer({ query: 'next 999' }, deps);

    expect(parseQuery).not.toHaveBeenCalled();
    expect(getTransitSuggestion).not.toHaveBeenCalled();
    expect(result.answer).toContain('next 22');
  });
});

describe('assistant.answer — graceful degradation (never 500)', () => {
  it('returns a fallback when the Gemini parse + suggestion both throw', async () => {
    const deps = makeDeps({
      parseQuery: vi.fn(async () => {
        throw new Error('gemini saturated');
      }),
      getTransitSuggestion: vi.fn(async () => {
        throw new Error('gemini saturated');
      }),
    });

    // A non-fast-path, non-favorite query forces the Gemini pipeline.
    const result = await answer({ query: 'plan me something clever' }, deps);

    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.answer).toContain('next 22');
  });
});
