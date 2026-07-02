/**
 * Pure answer/DTO formatters for the transit assistant.
 *
 * Every function here takes already-fetched data and returns the exact
 * user-facing strings and `realTimeArrivals` payloads the original controller
 * produced. No network, no side effects — fully unit-testable.
 */
import type {
  ArrivalLike,
  ClientArrival,
  DirectionsRealTimeArrivals,
  DirectionsRouteArrival,
  FavoriteLike,
  RouteRealTimeArrivals,
  StopArrivals,
} from './types';

function timeText(a: { isApproaching: boolean; minutesAway: number | null }): string {
  return a.isApproaching ? 'NOW' : `${a.minutesAway} min`;
}

function toClientArrival(a: ArrivalLike): ClientArrival {
  return {
    destination: a.destination,
    minutesAway: a.minutesAway,
    isApproaching: a.isApproaching,
    isDelayed: a.isDelayed,
  };
}

export interface FormattedAnswer {
  answer: string;
  realTimeArrivals: RouteRealTimeArrivals;
}

/** Format a favorite's live arrivals. Caller guarantees `validArrivals` is non-empty. */
export function formatFavoriteArrivals(
  favorite: FavoriteLike,
  stopId: string,
  validArrivals: ArrivalLike[]
): FormattedAnswer {
  const stop: StopArrivals = {
    stopName: favorite.boardingStopName || 'Your Stop',
    stopId,
    direction: favorite.direction || '',
    arrivals: validArrivals.map(toClientArrival),
  };

  const realTimeArrivals: RouteRealTimeArrivals = {
    route: favorite.routeId,
    routeName: favorite.name,
    stops: [stop],
  };

  const nextBus = validArrivals[0];
  let answer = `🚌 ${favorite.name}\n`;
  answer += `📍 ${favorite.boardingStopName}\n`;
  answer += `⏱️ Next: ${timeText(nextBus)} → ${nextBus.destination}`;

  return { answer, realTimeArrivals };
}

/** Format route-arrivals across one or more stops. Caller guarantees `stops` is non-empty. */
export function formatRouteArrivals(
  routeNumber: string,
  routeName: string,
  stops: StopArrivals[]
): FormattedAnswer {
  const realTimeArrivals: RouteRealTimeArrivals = {
    route: routeNumber,
    routeName,
    stops,
  };

  const closestStop = stops[0];
  const nextBus = closestStop.arrivals[0];

  let answer = `🚌 Route ${routeNumber} ${closestStop.direction}\n`;
  answer += `📍 ${closestStop.stopName}\n`;
  answer += `⏱️  Next: ${timeText(nextBus)} → ${nextBus.destination}`;

  if (nextBus.isDelayed) {
    answer += ' ⚠️ DELAYED';
  }

  if (closestStop.arrivals.length > 1) {
    const following = closestStop.arrivals
      .slice(1, 3)
      .map((a) => timeText(a));
    answer += `\n    Following: ${following.join(', ')}`;
  }

  return { answer, realTimeArrivals };
}

/** Message shown when a route exists but has no live arrivals (likely out of service). */
export function formatNoService(routeNumber: string, routeName: string): string {
  let answer = `🚌 Route ${routeNumber} - ${routeName}\n\n`;
  answer += `No buses are currently running on this route.\n\n`;
  answer += `This could be because:\n`;
  answer += `• It's outside service hours (buses typically run 5 AM - 1 AM)\n`;
  answer += `• The route doesn't operate on this day\n`;
  answer += `• There's a service disruption\n\n`;
  answer += `Try again during service hours or check transitchicago.com for the route schedule.`;
  return answer;
}

/**
 * Append a compact "Live right now" footer to an AI directions answer.
 * Returns the combined answer plus the `realTimeArrivals` payload (or null when
 * there were no live routes).
 */
export function formatDirectionsAnswer(
  directions: string,
  routeArrivals: DirectionsRouteArrival[]
): { answer: string; realTimeArrivals: DirectionsRealTimeArrivals | null } {
  let answer = directions.trim();

  if (routeArrivals.length > 0) {
    answer += '\n\n⚡ Live right now:\n';
    const top = routeArrivals.slice(0, 3);
    for (const r of top) {
      const next = r.arrivals[0];
      const icon = r.type === 'train' ? '🚊' : '🚌';
      const label = r.type === 'train' ? `${r.route} Line` : `Route ${r.route}`;
      answer += `${icon} ${label} → ${timeText(next)} @ ${r.stopName}\n`;
    }
  }

  const realTimeArrivals =
    routeArrivals.length > 0 ? { routes: routeArrivals } : null;

  return { answer, realTimeArrivals };
}
