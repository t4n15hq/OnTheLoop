import { describe, it, expect, vi, beforeEach } from 'vitest';

// BullMQ + redis are touched at module import (Queue construction); stub them.
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
}));
vi.mock('../utils/redis', () => ({ default: {} }));
vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/sentry', () => ({ reportError: vi.fn() }));

// Prisma stub for the rollup DB path.
const findMany = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();
vi.mock('../utils/db', () => ({
  default: {
    arrivalObservation: {
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
    reliabilityBucket: {
      upsert: (...a: unknown[]) => upsert(...a),
    },
  },
}));

import {
  aggregateObservations,
  hourOfWeek,
  runReliabilityRollup,
  type ObservationRow,
} from './reliability.job';

function obs(over: Partial<ObservationRow> = {}): ObservationRow {
  return {
    stopId: '15895',
    routeId: '22',
    direction: 'Northbound',
    predictedMin: 6,
    delayed: false,
    // Monday 2026-07-06 14:00 UTC.
    observedAt: new Date('2026-07-06T14:00:00Z'),
    ...over,
  };
}

describe('hourOfWeek', () => {
  it('is localDayOfWeek(0=Sun)*24 + localHour in the given zone', () => {
    // Monday 14:00 UTC -> dow 1, hour 14 -> 1*24 + 14 = 38.
    expect(hourOfWeek(new Date('2026-07-06T14:00:00Z'), 'UTC')).toBe(38);
    // Sunday 00:00 UTC -> 0.
    expect(hourOfWeek(new Date('2026-07-05T00:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('aggregateObservations', () => {
  it('groups by (stop, route, direction, hour-of-week) and counts correctly', () => {
    const rows: ObservationRow[] = [
      obs({ predictedMin: 6, delayed: false }),
      obs({ predictedMin: 10, delayed: true }),
      obs({ predictedMin: null }), // no prediction -> excluded from avg
      // Different hour-of-week -> its own bucket.
      obs({ observedAt: new Date('2026-07-06T15:00:00Z'), predictedMin: 4 }),
    ];

    const buckets = aggregateObservations(rows, 'UTC');
    expect(buckets).toHaveLength(2);

    const h38 = buckets.find((b) => b.hourOfWeek === 38)!;
    expect(h38).toMatchObject({
      stopId: '15895',
      routeId: '22',
      direction: 'Northbound',
      sampleCount: 3,
      delayedCount: 1,
      sumPredictedMin: 16, // 6 + 10 (null excluded)
      predictedSampleCount: 2,
    });
    expect(h38.avgPredictedMin).toBe(8); // 16 / 2

    const h39 = buckets.find((b) => b.hourOfWeek === 39)!;
    expect(h39.sampleCount).toBe(1);
    expect(h39.avgPredictedMin).toBe(4);
  });

  it('splits distinct stops/routes/directions into distinct buckets', () => {
    const buckets = aggregateObservations(
      [
        obs({ stopId: 'A' }),
        obs({ stopId: 'B' }),
        obs({ routeId: '99' }),
        obs({ direction: 'Southbound' }),
        obs({ direction: null }), // coalesced to ""
      ],
      'UTC'
    );
    expect(buckets).toHaveLength(5);
    expect(buckets.some((b) => b.direction === '')).toBe(true);
  });

  it('yields avgPredictedMin null when no row had a prediction', () => {
    const buckets = aggregateObservations([obs({ predictedMin: null })], 'UTC');
    expect(buckets[0].avgPredictedMin).toBeNull();
    expect(buckets[0].predictedSampleCount).toBe(0);
  });
});

describe('runReliabilityRollup', () => {
  beforeEach(() => {
    findMany.mockReset();
    upsert.mockReset().mockResolvedValue({});
    updateMany.mockReset().mockResolvedValue({ count: 0 });
    deleteMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('upserts one bucket per group, marks the batch rolled up, and prunes old raw rows', async () => {
    findMany.mockResolvedValue([
      { id: 'o1', ...obs({ predictedMin: 6 }) },
      { id: 'o2', ...obs({ predictedMin: 10, delayed: true }) },
    ]);
    deleteMany.mockResolvedValue({ count: 7 });

    const now = new Date('2026-08-01T09:00:00Z');
    const result = await runReliabilityRollup(now);

    // Both rows land in the same bucket -> exactly one upsert.
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArg = upsert.mock.calls[0][0] as any;
    expect(upsertArg.update.sampleCount).toEqual({ increment: 2 });
    expect(upsertArg.update.delayedCount).toEqual({ increment: 1 });
    expect(upsertArg.update.sumPredictedMin).toEqual({ increment: 16 });

    // Only the folded rows are flagged, so a later run can't double-count them.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['o1', 'o2'] } },
      data: { rolledUp: true },
    });

    // Retention prune uses a 30-day cutoff before `now`.
    const delArg = deleteMany.mock.calls[0][0] as any;
    const cutoff = delArg.where.observedAt.lt as Date;
    expect(now.getTime() - cutoff.getTime()).toBe(30 * 86_400_000);

    expect(result).toEqual({ buckets: 1, pruned: 7 });
  });

  it('still prunes even when there is nothing new to roll up', async () => {
    findMany.mockResolvedValue([]);
    deleteMany.mockResolvedValue({ count: 3 });

    const result = await runReliabilityRollup(new Date('2026-08-01T09:00:00Z'));

    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ buckets: 0, pruned: 3 });
  });
});
