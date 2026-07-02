import { Queue, Worker } from 'bullmq';
import redis from '../utils/redis';
import logger from '../utils/logger';
import prisma from '../utils/db';
import config from '../config';
import { reportError } from '../utils/sentry';

// #39 Phase 1 — nightly rollup + retention for per-stop reliability history.
// `ponytail: raw + nightly rollup, not a timeseries DB.` We fold the raw
// snapshots into per-(stop,route,direction,hour-of-week) buckets and drop raw
// rows older than the retention window, so storage stays bounded while the
// aggregate history keeps accumulating for Phase 2.

const RELIABILITY_QUEUE_NAME = 'reliability-rollup';

/** Drop raw observation rows older than this. Aggregate buckets are kept. */
const RAW_RETENTION_DAYS = 30;

/** Fire nightly at 03:15 in the schedule timezone (quiet hour). */
const NIGHTLY_CRON = '15 3 * * *';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** A raw observation row, as read for aggregation. */
export interface ObservationRow {
  stopId: string;
  routeId: string;
  direction: string | null;
  predictedMin: number | null;
  delayed: boolean;
  observedAt: Date;
}

/** One aggregated bucket produced from a batch of observations. */
export interface AggregatedBucket {
  stopId: string;
  routeId: string;
  direction: string; // "" when the observation had no direction
  hourOfWeek: number; // 0–167
  sampleCount: number;
  delayedCount: number;
  sumPredictedMin: number; // sum over rows that had a predictedMin
  predictedSampleCount: number; // count of rows that had a predictedMin
  /** Convenience for this batch only: sumPredictedMin / predictedSampleCount. */
  avgPredictedMin: number | null;
}

/**
 * localDayOfWeek(0=Sun) * 24 + localHour, evaluated in the given IANA zone.
 * Uses Intl (built into Node) so it's independent of the host TZ, matching how
 * the scheduler interprets wall-clock time.
 */
export function hourOfWeek(date: Date, timeZone: string = config.scheduleTimezone): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = parseInt(get('hour'), 10) % 24; // "24" → 0 on some locales
  const dow = DAYS.indexOf(get('weekday') as (typeof DAYS)[number]);
  return dow * 24 + hour;
}

/**
 * Pure aggregation: fold raw observations into per-(stop,route,direction,
 * hour-of-week) buckets. Kept side-effect free so it's trivially unit-testable;
 * the DB read/write lives in {@link runReliabilityRollup}.
 */
export function aggregateObservations(
  rows: ObservationRow[],
  timeZone: string = config.scheduleTimezone
): AggregatedBucket[] {
  const buckets = new Map<string, AggregatedBucket>();

  for (const r of rows) {
    const direction = r.direction ?? '';
    const how = hourOfWeek(r.observedAt, timeZone);
    const key = `${r.stopId}|${r.routeId}|${direction}|${how}`;

    let b = buckets.get(key);
    if (!b) {
      b = {
        stopId: r.stopId,
        routeId: r.routeId,
        direction,
        hourOfWeek: how,
        sampleCount: 0,
        delayedCount: 0,
        sumPredictedMin: 0,
        predictedSampleCount: 0,
        avgPredictedMin: null,
      };
      buckets.set(key, b);
    }

    b.sampleCount += 1;
    if (r.delayed) b.delayedCount += 1;
    if (typeof r.predictedMin === 'number') {
      b.sumPredictedMin += r.predictedMin;
      b.predictedSampleCount += 1;
    }
  }

  for (const b of buckets.values()) {
    b.avgPredictedMin =
      b.predictedSampleCount > 0 ? b.sumPredictedMin / b.predictedSampleCount : null;
  }

  return [...buckets.values()];
}

/**
 * Nightly job body: aggregate the un-rolled-up raw observations into buckets
 * (incrementing running totals), mark them rolled up, then prune raw rows older
 * than the retention window. Idempotent-ish: each raw row is folded exactly
 * once thanks to the `rolledUp` flag.
 */
export async function runReliabilityRollup(
  now: Date = new Date()
): Promise<{ buckets: number; pruned: number }> {
  const batch = await prisma.arrivalObservation.findMany({
    where: { rolledUp: false },
    select: {
      id: true,
      stopId: true,
      routeId: true,
      direction: true,
      predictedMin: true,
      delayed: true,
      observedAt: true,
    },
  });

  const buckets = aggregateObservations(batch as ObservationRow[]);

  for (const b of buckets) {
    await prisma.reliabilityBucket.upsert({
      where: {
        stopId_routeId_direction_hourOfWeek: {
          stopId: b.stopId,
          routeId: b.routeId,
          direction: b.direction,
          hourOfWeek: b.hourOfWeek,
        },
      },
      create: {
        stopId: b.stopId,
        routeId: b.routeId,
        direction: b.direction,
        hourOfWeek: b.hourOfWeek,
        sampleCount: b.sampleCount,
        delayedCount: b.delayedCount,
        sumPredictedMin: b.sumPredictedMin,
        predictedSampleCount: b.predictedSampleCount,
      },
      update: {
        sampleCount: { increment: b.sampleCount },
        delayedCount: { increment: b.delayedCount },
        sumPredictedMin: { increment: b.sumPredictedMin },
        predictedSampleCount: { increment: b.predictedSampleCount },
      },
    });
  }

  if (batch.length > 0) {
    await prisma.arrivalObservation.updateMany({
      where: { id: { in: batch.map((r) => r.id) } },
      data: { rolledUp: true },
    });
  }

  const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 86_400_000);
  const pruned = await prisma.arrivalObservation.deleteMany({
    where: { observedAt: { lt: cutoff } },
  });

  logger.info(
    `Reliability rollup: folded ${batch.length} observation(s) into ${buckets.length} bucket(s); ` +
      `pruned ${pruned.count} raw row(s) older than ${RAW_RETENTION_DAYS}d`
  );

  return { buckets: buckets.length, pruned: pruned.count };
}

export const reliabilityQueue = new Queue(RELIABILITY_QUEUE_NAME, {
  connection: redis,
});

export function createReliabilityWorker() {
  const worker = new Worker(
    RELIABILITY_QUEUE_NAME,
    async () => {
      await runReliabilityRollup();
    },
    { connection: redis }
  );

  worker.on('failed', (job, err) => {
    reportError(err, { queue: RELIABILITY_QUEUE_NAME, jobId: job?.id });
  });

  return worker;
}

/**
 * Register the nightly repeatable rollup. Idempotent: BullMQ dedupes repeatable
 * jobs by key, so calling this from every process (in-process API + dedicated
 * worker) is safe.
 */
export async function scheduleReliabilityRollup(): Promise<void> {
  await reliabilityQueue.add(
    'rollup',
    {},
    {
      repeat: { pattern: NIGHTLY_CRON, tz: config.scheduleTimezone },
      jobId: 'reliability-rollup-nightly',
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 100 },
    }
  );
  logger.info(`Reliability rollup scheduled (${NIGHTLY_CRON} ${config.scheduleTimezone})`);
}
