/**
 * Live-arrivals enrichment for the transit assistant.
 *
 * This is the only place that fans out to the CTA services; every call goes
 * through the injected {@link AssistantDeps} so it can be mocked. The fan-out is
 * *bounded* (issue #14): a small candidate set of stops is queried concurrently
 * via `Promise.all` with a per-stop `.catch`, never a deep serial loop over
 * every stop on a route.
 */
import logger from '../../utils/logger';
import { reportError } from '../../utils/sentry';
import type { AssistantDeps } from './deps';
import type {
  ArrivalLike,
  DirectionsArrival,
  DirectionsRouteArrival,
  FavoriteLike,
  StopArrivals,
} from './types';

/**
 * Upper bound on how many stops a single route-arrivals lookup will poll for
 * live predictions, across all directions combined. Keeps the assistant from
 * fanning out to hundreds of CTA calls for a long route (#14).
 */
export const MAX_ASSISTANT_STOP_LOOKUPS = 8;

/** An arrival is "valid" if it has a concrete ETA or is actively approaching. */
export function isValidArrival(a: ArrivalLike): boolean {
  return a.minutesAway !== null || a.isApproaching;
}

/** Live arrivals for a favorite's boarding stop/station, filtered to valid ones. */
export async function enrichFavoriteArrivals(
  favorite: FavoriteLike,
  stopId: string,
  deps: AssistantDeps
): Promise<ArrivalLike[]> {
  const arrivals =
    favorite.routeType === 'TRAIN'
      ? await deps.getTrainArrivals(
          stopId,
          favorite.routeId,
          favorite.direction || undefined
        )
      : await deps.getBusPredictions(
          stopId,
          favorite.routeId,
          3,
          favorite.direction || undefined
        );

  return arrivals.filter(isValidArrival);
}

/**
 * Collect up to 3 stops with live arrivals for a bus route. Bounded (#14): at
 * most {@link MAX_ASSISTANT_STOP_LOOKUPS} stops are polled in total, each batch
 * fetched concurrently with a per-stop `.catch`. Mirrors the integrated
 * controller's route_arrivals fan-out exactly.
 */
export async function enrichRouteArrivals(
  routeNumber: string,
  deps: AssistantDeps
): Promise<StopArrivals[]> {
  const directions = await deps.getBusDirections(routeNumber);
  const collected: StopArrivals[] = [];

  let checkedStops = 0;
  for (const direction of directions) {
    if (collected.length >= 3) break;
    if (checkedStops >= MAX_ASSISTANT_STOP_LOOKUPS) break;

    try {
      const stops = await deps.getBusStops(routeNumber, direction);
      const remaining = MAX_ASSISTANT_STOP_LOOKUPS - checkedStops;
      const candidates = stops.slice(0, remaining);
      checkedStops += candidates.length;

      const results = await Promise.all(
        candidates.map((stop) =>
          deps
            .getBusPredictions(stop.stpid, routeNumber, 3)
            .then((arrivals) => ({ stop, arrivals }))
            .catch(() => null)
        )
      );

      for (const result of results) {
        if (!result || collected.length >= 3) continue;
        const valid = result.arrivals.filter(isValidArrival);

        if (valid.length > 0) {
          collected.push({
            stopName: result.stop.stpnm,
            stopId: result.stop.stpid,
            direction,
            arrivals: valid.map((a) => ({
              destination: a.destination,
              minutesAway: a.minutesAway,
              isApproaching: a.isApproaching,
              isDelayed: a.isDelayed,
            })),
          });
        }
      }
    } catch {
      continue;
    }
  }

  return collected;
}

/**
 * For a set of bus routes mentioned in AI directions, find the first stop per
 * route that has live arrivals. Bounded (#14): first 3 routes, and for each
 * direction only the first 5 stops are polled — concurrently via `Promise.all`
 * with a per-stop `.catch`. Per-route failures are reported to Sentry and
 * skipped. Results are sorted by soonest arrival.
 */
export async function enrichDirectionsArrivals(
  busRoutes: string[],
  deps: AssistantDeps
): Promise<DirectionsRouteArrival[]> {
  const routeArrivals: DirectionsRouteArrival[] = [];

  for (const routeNum of busRoutes.slice(0, 3)) {
    try {
      logger.info(`Fetching arrivals for bus route ${routeNum}`);
      const routes = await deps.getBusRoutes();
      const route = routes.find((r) => r.rt === routeNum);

      if (!route) {
        logger.warn(`Bus route ${routeNum} not found in CTA routes`);
        continue;
      }

      const directions = await deps.getBusDirections(routeNum);
      for (const direction of directions) {
        const stops = await deps.getBusStops(routeNum, direction);
        const candidates = stops.slice(0, 5);

        const results = await Promise.all(
          candidates.map((stop) =>
            deps
              .getBusPredictions(stop.stpid, routeNum, 2)
              .then((arrivals) => ({ stop, arrivals }))
              .catch((err) => {
                logger.error(`Error fetching arrivals for stop ${stop.stpid}:`, err);
                return null;
              })
          )
        );

        for (const result of results) {
          if (!result) continue;
          const valid = result.arrivals.filter(isValidArrival);

          if (valid.length > 0) {
            logger.info(
              `Found ${valid.length} arrivals for route ${routeNum} at ${result.stop.stpnm}`
            );
            const clientArrivals: DirectionsArrival[] = valid.slice(0, 2).map((a) => ({
              destination: a.destination,
              minutesAway: a.minutesAway,
              isApproaching: a.isApproaching,
            }));
            routeArrivals.push({
              type: 'bus',
              route: routeNum,
              routeName: route.rtnm,
              stopName: result.stop.stpnm,
              direction,
              nextArrival: valid[0].minutesAway || 0,
              arrivals: clientArrivals,
            });
            break; // Found arrivals for this route, move to next
          }
        }

        if (routeArrivals.some((r) => r.route === routeNum)) break;
      }
    } catch (err) {
      reportError(err, {
        route: 'cta/transit-suggestion/bus-route',
        routeNumber: routeNum,
      });
      continue;
    }
  }

  logger.info(`Total route arrivals found: ${routeArrivals.length}`);
  routeArrivals.sort((a, b) => a.nextArrival - b.nextArrival);
  return routeArrivals;
}
