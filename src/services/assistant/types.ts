/**
 * DTO types for the transit assistant.
 *
 * These are intentionally *structural* (not tied to Prisma or the CTA service
 * classes) so the pure modules — intent, match, format — can be unit-tested
 * without a database or network stack. The real Prisma `Favorite` and
 * `FormattedArrival` types are structurally assignable to `FavoriteLike` and
 * `ArrivalLike`, so no adapters are needed at the call sites.
 */

export type AssistantIntent =
  | 'route_arrivals'
  | 'find_stops'
  | 'transit_directions'
  | 'favorites'
  | 'unknown';

/** Parsed intent + slots, as produced by the (mockable) AI parse step. */
export interface ParsedIntent {
  intent: AssistantIntent;
  routeNumber?: string;
  location?: string;
  stopId?: string;
  origin?: string;
  destination?: string;
}

/**
 * Minimal shape of a saved favorite the assistant needs. The Prisma `Favorite`
 * model is assignable to this, but tests can construct plain objects.
 */
export interface FavoriteLike {
  name: string;
  routeType: string; // 'TRAIN' | 'BUS'
  routeId: string;
  direction?: string | null;
  stopId?: string | null;
  stationId?: string | null;
  boardingStopId?: string | null;
  boardingStopName?: string | null;
}

/** Minimal shape of a normalized arrival. `FormattedArrival` is assignable. */
export interface ArrivalLike {
  destination: string;
  minutesAway: number | null;
  isApproaching: boolean;
  isDelayed: boolean;
}

/** A single arrival as surfaced to the client. */
export interface ClientArrival {
  destination: string;
  minutesAway: number | null;
  isApproaching: boolean;
  isDelayed: boolean;
}

/** One stop with its live arrivals. */
export interface StopArrivals {
  stopName: string;
  stopId: string;
  direction: string;
  arrivals: ClientArrival[];
}

/** Real-time payload for a favorite or route-arrivals lookup. */
export interface RouteRealTimeArrivals {
  route: string;
  routeName: string;
  stops: StopArrivals[];
}

/**
 * A directions-footer arrival. Intentionally omits `isDelayed` to match the
 * exact JSON the original controller emitted on the directions path.
 */
export interface DirectionsArrival {
  destination: string;
  minutesAway: number | null;
  isApproaching: boolean;
}

/** One route's live info within a directions answer. */
export interface DirectionsRouteArrival {
  type: 'bus' | 'train';
  route: string;
  routeName: string;
  stopName: string;
  direction: string;
  nextArrival: number;
  arrivals: DirectionsArrival[];
}

/** Real-time payload for a directions lookup. */
export interface DirectionsRealTimeArrivals {
  routes: DirectionsRouteArrival[];
}

export type RealTimeArrivals =
  | RouteRealTimeArrivals
  | DirectionsRealTimeArrivals
  | null;

/** Final result returned by the assistant orchestrator. */
export interface AssistantResult {
  query: string;
  answer: string;
  realTimeArrivals: RealTimeArrivals;
}

/** Input to the assistant orchestrator. */
export interface AssistantInput {
  query: string;
  userId?: string;
}
