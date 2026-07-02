// Walk-time estimation for "leave now" pings (#38).
//
// v1 is deliberately dumb (ponytail: haversine * 1.3, no routing API): a
// straight-line distance scaled by a detour factor, divided by an average
// walking speed. Good enough to turn an arrival-time ping into a leave-time
// ping; swap in Maps walking directions later only if riders complain.

/** Average walking speed in mph — a common trip-planning default. */
export const DEFAULT_WALK_SPEED_MPH = 3;

/**
 * Straight-line paths underestimate real walking distance (you can't walk
 * through buildings). ~1.3× approximates a street-grid detour.
 */
export const DETOUR_FACTOR = 1.3;

/** Earth radius in miles (matches CTALookupService's haversine). */
const EARTH_RADIUS_MILES = 3959;

export interface Coordinates {
  lat: number;
  lon: number;
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two coordinates, in miles. */
export function haversineMiles(from: Coordinates, to: Coordinates): number {
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(from.lat)) *
      Math.cos(toRad(to.lat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

/**
 * Estimate walking time between two points, in whole minutes (rounded up so we
 * never tell a rider to leave later than they safely can).
 */
export function estimateWalkMinutes(
  from: Coordinates,
  to: Coordinates,
  speedMph: number = DEFAULT_WALK_SPEED_MPH
): number {
  const miles = haversineMiles(from, to) * DETOUR_FACTOR;
  return Math.ceil((miles / speedMph) * 60);
}

/**
 * The instant a rider should be pinged: `arrival − leadMinutes − walkMinutes`.
 * With walkMinutes = 0 this is the legacy `arrival − leadMinutes` behavior.
 */
export function leaveTime(arrival: Date, leadMinutes: number, walkMinutes: number): Date {
  return new Date(arrival.getTime() - (leadMinutes + walkMinutes) * 60_000);
}

/** A schedule's stored trip geometry (subset of the Prisma Schedule row). */
export interface ScheduleWalkGeometry {
  startLat?: number | null;
  startLon?: number | null;
  stopLat?: number | null;
  stopLon?: number | null;
}

/** True once both endpoints of the walk (start + boarding stop) are known. */
export function hasWalkGeometry(s: ScheduleWalkGeometry): boolean {
  return (
    s.startLat != null &&
    s.startLon != null &&
    s.stopLat != null &&
    s.stopLon != null
  );
}

/**
 * Walk minutes for a schedule, or 0 when it has no start location (so callers
 * fall back to the legacy arrival-time behavior unchanged).
 */
export function scheduleWalkMinutes(
  s: ScheduleWalkGeometry,
  speedMph: number = DEFAULT_WALK_SPEED_MPH
): number {
  if (!hasWalkGeometry(s)) return 0;
  return estimateWalkMinutes(
    { lat: s.startLat!, lon: s.startLon! },
    { lat: s.stopLat!, lon: s.stopLon! },
    speedMph
  );
}
