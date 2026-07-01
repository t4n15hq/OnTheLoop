import { describe, it, expect } from 'vitest';
import { scoreFavorites, selectFavorite, favoriteStopId } from './match';
import type { FavoriteLike } from './types';

const busFav: FavoriteLike = {
  name: 'Home Express',
  routeType: 'BUS',
  routeId: '22',
  direction: 'Northbound',
  stopId: 'bus-stop-1',
  boardingStopId: 'board-1',
  boardingStopName: 'Clark & Diversey',
};

const trainFav: FavoriteLike = {
  name: 'Gym Red Line',
  routeType: 'TRAIN',
  routeId: 'Red',
  direction: '1',
  stationId: 'station-9',
  boardingStopId: 'board-9',
  boardingStopName: 'Belmont',
};

describe('scoreFavorites', () => {
  it('returns null when the query has no usable tokens', () => {
    expect(scoreFavorites('when is the next bus', [busFav])).toBeNull();
  });

  it('scores by fraction of query tokens that hit a favorite name', () => {
    const best = scoreFavorites('home express please', [busFav, trainFav]);
    expect(best?.favorite).toBe(busFav);
    expect(best?.score).toBeCloseTo(2 / 3);
  });
});

describe('selectFavorite', () => {
  it('returns the favorite when the score clears the threshold', () => {
    const match = selectFavorite('when is my Home Express', [busFav, trainFav]);
    expect(match).toBe(busFav);
  });

  it('returns null when the best score is below the threshold', () => {
    // Only "gym" overlaps out of 3 tokens -> 0.33 < 0.5
    const match = selectFavorite('gym coffee downtown', [busFav, trainFav]);
    expect(match).toBeNull();
  });
});

describe('favoriteStopId', () => {
  it('uses the station id for trains', () => {
    expect(favoriteStopId(trainFav)).toBe('station-9');
  });

  it('uses the stop id for buses', () => {
    expect(favoriteStopId(busFav)).toBe('bus-stop-1');
  });

  it('falls back to the boarding-stop id', () => {
    expect(
      favoriteStopId({ ...busFav, stopId: null, boardingStopId: 'fallback' })
    ).toBe('fallback');
  });

  it('returns null when no id is set', () => {
    expect(
      favoriteStopId({ ...busFav, stopId: null, boardingStopId: null })
    ).toBeNull();
  });
});
