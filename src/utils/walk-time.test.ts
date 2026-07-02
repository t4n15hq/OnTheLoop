import { describe, it, expect } from 'vitest';
import {
  haversineMiles,
  estimateWalkMinutes,
  leaveTime,
  scheduleWalkMinutes,
} from './walk-time';

// Two points exactly ~1 mile apart along latitude. One degree of latitude is
// EARTH_RADIUS_MILES * (π/180) ≈ 69.09 miles, so a 1/69.09 ≈ 0.0144736 deg step
// is one mile — lets us assert the walk math without re-deriving haversine.
const HOME = { lat: 41.94, lon: -87.6532 };
const ONE_MILE_NORTH = { lat: 41.94 + 1 / (3959 * (Math.PI / 180)), lon: -87.6532 };

describe('walk-time', () => {
  it('haversineMiles measures ~1 mile between the two fixtures', () => {
    expect(haversineMiles(HOME, ONE_MILE_NORTH)).toBeCloseTo(1.0, 3);
  });

  it('estimateWalkMinutes = ceil(miles * 1.3 detour / 3mph * 60) → 26 min for 1 mile', () => {
    // 1 mi * 1.3 = 1.3 mi; 1.3 / 3 mph = 0.4333 h = 26 min exactly.
    expect(estimateWalkMinutes(HOME, ONE_MILE_NORTH)).toBe(26);
  });

  it('estimateWalkMinutes honors a custom walking speed', () => {
    // Same 1.3 mi at 4 mph = 0.325 h = 19.5 min → ceil = 20.
    expect(estimateWalkMinutes(HOME, ONE_MILE_NORTH, 4)).toBe(20);
  });

  it('given two coords + a train time, computes the expected leave time', () => {
    // Rider catches an 08:12 train, wants a 4-min heads-up (leadMinutes).
    const arrival = new Date('2026-07-01T08:12:00.000Z');
    const walk = estimateWalkMinutes(HOME, ONE_MILE_NORTH); // 26 min
    const leave = leaveTime(arrival, 4, walk);
    // 08:12 − 4 (lead) − 26 (walk) = 07:42.
    expect(leave.toISOString()).toBe('2026-07-01T07:42:00.000Z');
  });

  it('scheduleWalkMinutes returns walk minutes when the full geometry is present', () => {
    expect(
      scheduleWalkMinutes({
        startLat: HOME.lat,
        startLon: HOME.lon,
        stopLat: ONE_MILE_NORTH.lat,
        stopLon: ONE_MILE_NORTH.lon,
      })
    ).toBe(26);
  });

  it('scheduleWalkMinutes returns 0 when no start location is set (backward compatible)', () => {
    expect(scheduleWalkMinutes({})).toBe(0);
    expect(scheduleWalkMinutes({ startLat: HOME.lat, startLon: HOME.lon })).toBe(0);
    expect(
      scheduleWalkMinutes({ stopLat: ONE_MILE_NORTH.lat, stopLon: ONE_MILE_NORTH.lon })
    ).toBe(0);
  });
});
