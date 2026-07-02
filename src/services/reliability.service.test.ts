import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedArrival } from '../types/cta.types';

// Prisma: capture what the capture path writes.
const createMany = vi.fn();
vi.mock('../utils/db', () => ({
  default: {
    arrivalObservation: {
      createMany: (...args: unknown[]) => createMany(...args),
    },
  },
}));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { recordArrivalObservations } from './reliability.service';

function arrival(over: Partial<FormattedArrival> = {}): FormattedArrival {
  return {
    routeName: 'Route 22',
    destination: 'Howard',
    arrivalTime: new Date('2026-07-01T12:00:00Z'),
    minutesAway: 6,
    isApproaching: false,
    isDelayed: false,
    confidence: 'live',
    ...over,
  };
}

describe('recordArrivalObservations (piggyback capture)', () => {
  beforeEach(() => {
    createMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('writes one observation per fresh arrival on a saved-stop fetch', async () => {
    await recordArrivalObservations({
      stopId: '15895',
      routeId: '22',
      direction: 'Northbound',
      arrivals: [arrival({ minutesAway: 6 }), arrival({ minutesAway: 12, isDelayed: true })],
    });

    expect(createMany).toHaveBeenCalledTimes(1);
    const { data } = createMany.mock.calls[0][0] as { data: any[] };
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      stopId: '15895',
      routeId: '22',
      direction: 'Northbound',
      predictedMin: 6,
      delayed: false,
    });
    expect(data[1]).toMatchObject({ predictedMin: 12, delayed: true });
  });

  it('coalesces a missing direction to null', async () => {
    await recordArrivalObservations({
      stopId: '30001',
      routeId: 'Blue',
      arrivals: [arrival()],
    });

    const { data } = createMany.mock.calls[0][0] as { data: any[] };
    expect(data[0].direction).toBeNull();
  });

  it('skips stale (cache-fallback) arrivals so a single arrival is not double-counted', async () => {
    await recordArrivalObservations({
      stopId: '15895',
      routeId: '22',
      arrivals: [arrival({ isStale: true }), arrival({ minutesAway: 9 })],
    });

    const { data } = createMany.mock.calls[0][0] as { data: any[] };
    expect(data).toHaveLength(1);
    expect(data[0].predictedMin).toBe(9);
  });

  it('writes nothing when there are no fresh arrivals', async () => {
    await recordArrivalObservations({ stopId: '1', routeId: '2', arrivals: [] });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('never throws when the DB write fails (fire-and-forget)', async () => {
    createMany.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordArrivalObservations({ stopId: '1', routeId: '2', arrivals: [arrival()] })
    ).resolves.toBeUndefined();
  });
});
