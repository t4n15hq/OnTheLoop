import prisma from '../utils/db';
import logger from '../utils/logger';
import { FormattedArrival } from '../types/cta.types';

/**
 * #39 Phase 1 — piggyback reliability capture.
 *
 * Persist a snapshot of the live predictions we ALREADY fetched for a saved
 * stop. This adds NO upstream CTA traffic: the caller (the scheduler / notify
 * path) already has `arrivals` in hand.
 *
 * Fire-and-forget by design: reliability logging must never delay or break a
 * user's notification, so all failures are swallowed and logged. Stale arrivals
 * (served from cache after an upstream error) are skipped — they'd double-count
 * a single real observation across ticks.
 */
export async function recordArrivalObservations(params: {
  stopId: string;
  routeId: string;
  direction?: string | null;
  arrivals: FormattedArrival[];
}): Promise<void> {
  const { stopId, routeId, direction = null, arrivals } = params;

  const fresh = arrivals.filter((a) => !a.isStale);
  if (fresh.length === 0) return;

  try {
    await prisma.arrivalObservation.createMany({
      data: fresh.map((a) => ({
        stopId,
        routeId,
        direction: direction ?? null,
        predictedMin: Number.isFinite(a.minutesAway) ? a.minutesAway : null,
        delayed: a.isDelayed === true,
      })),
    });
    logger.debug(
      `Recorded ${fresh.length} arrival observation(s) for stop ${stopId} route ${routeId}`
    );
  } catch (err) {
    logger.error('Failed to record arrival observations:', err);
  }
}
