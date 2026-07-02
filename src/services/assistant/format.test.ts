import { describe, it, expect } from 'vitest';
import {
  formatFavoriteArrivals,
  formatRouteArrivals,
  formatNoService,
  formatDirectionsAnswer,
} from './format';
import type { ArrivalLike, FavoriteLike, StopArrivals } from './types';

const favorite: FavoriteLike = {
  name: 'Home Express',
  routeType: 'BUS',
  routeId: '22',
  direction: 'Northbound',
  boardingStopName: 'Clark & Diversey',
};

describe('formatFavoriteArrivals', () => {
  it('builds the favorite answer and payload', () => {
    const arrivals: ArrivalLike[] = [
      { destination: 'Howard', minutesAway: 5, isApproaching: false, isDelayed: false },
    ];
    const { answer, realTimeArrivals } = formatFavoriteArrivals(favorite, 'stop-1', arrivals);

    expect(answer).toContain('🚌 Home Express');
    expect(answer).toContain('📍 Clark & Diversey');
    expect(answer).toContain('Next: 5 min → Howard');
    expect(realTimeArrivals.route).toBe('22');
    expect(realTimeArrivals.routeName).toBe('Home Express');
    expect(realTimeArrivals.stops[0].stopId).toBe('stop-1');
    expect(realTimeArrivals.stops[0].arrivals).toHaveLength(1);
  });

  it('renders NOW for an approaching arrival', () => {
    const arrivals: ArrivalLike[] = [
      { destination: 'Howard', minutesAway: 0, isApproaching: true, isDelayed: false },
    ];
    const { answer } = formatFavoriteArrivals(favorite, 'stop-1', arrivals);
    expect(answer).toContain('Next: NOW → Howard');
  });
});

describe('formatRouteArrivals', () => {
  const stops: StopArrivals[] = [
    {
      stopName: 'Racine',
      stopId: '5',
      direction: 'Eastbound',
      arrivals: [
        { destination: 'Downtown', minutesAway: 2, isApproaching: false, isDelayed: true },
        { destination: 'Downtown', minutesAway: 12, isApproaching: false, isDelayed: false },
      ],
    },
  ];

  it('marks delays and lists following arrivals', () => {
    const { answer, realTimeArrivals } = formatRouteArrivals('60', 'Blue Island/26th', stops);
    expect(answer).toContain('🚌 Route 60 Eastbound');
    expect(answer).toContain('📍 Racine');
    expect(answer).toContain('Next: 2 min → Downtown ⚠️ DELAYED');
    expect(answer).toContain('Following: 12 min');
    expect(realTimeArrivals.route).toBe('60');
    expect(realTimeArrivals.routeName).toBe('Blue Island/26th');
  });
});

describe('formatNoService', () => {
  it('produces the out-of-service message', () => {
    const msg = formatNoService('99', 'Test Route');
    expect(msg).toContain('🚌 Route 99 - Test Route');
    expect(msg).toContain('No buses are currently running on this route.');
    expect(msg).toContain('transitchicago.com');
  });
});

describe('formatDirectionsAnswer', () => {
  it('returns trimmed directions and null payload with no live routes', () => {
    const { answer, realTimeArrivals } = formatDirectionsAnswer('  Take the Red Line.  ', []);
    expect(answer).toBe('Take the Red Line.');
    expect(realTimeArrivals).toBeNull();
  });

  it('appends a live footer when routes are present', () => {
    const { answer, realTimeArrivals } = formatDirectionsAnswer('Take Route 22.', [
      {
        type: 'bus',
        route: '22',
        routeName: 'Clark',
        stopName: 'Clark & Foster',
        direction: 'Northbound',
        nextArrival: 4,
        arrivals: [{ destination: 'Howard', minutesAway: 4, isApproaching: false }],
      },
    ]);
    expect(answer).toContain('⚡ Live right now:');
    expect(answer).toContain('🚌 Route 22 → 4 min @ Clark & Foster');
    expect(realTimeArrivals?.routes[0].route).toBe('22');
  });
});
