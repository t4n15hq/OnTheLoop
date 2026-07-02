/**
 * Injectable dependencies for the transit assistant.
 *
 * Every external call the assistant makes (AI parse, Gemini directions, CTA
 * lookups, live arrivals, favorites) is funneled through this interface so the
 * orchestrator can be driven with in-memory fakes in tests. The real wiring
 * (`defaultDeps`) lives in `assistant.service.ts`.
 */
import type { ArrivalLike, FavoriteLike, ParsedIntent } from './types';

/** Minimal bus-route shape the assistant needs from the lookup service. */
export interface BusRouteInfo {
  rt: string;
  rtnm: string;
}

/** Minimal bus-stop shape the assistant needs from the lookup service. */
export interface BusStopInfo {
  stpid: string;
  stpnm: string;
}

/** Minimal train-station shape the assistant needs for the fast-path. */
export interface TrainStationInfo {
  map_id: string;
  station_name: string;
  directions: string[];
}

export interface AssistantDeps {
  /** AI intent + slot extraction (mockable). */
  parseQuery(query: string): Promise<ParsedIntent>;
  /** Favorites for a user, already scoped by userId. */
  getFavorites(userId: string): Promise<FavoriteLike[]>;
  /** Free-text AI transit directions for a query. */
  getTransitSuggestion(query: string): Promise<string>;
  /** All CTA bus routes. */
  getBusRoutes(): Promise<BusRouteInfo[]>;
  /** Valid directions for a bus route. */
  getBusDirections(routeId: string): Promise<string[]>;
  /** Stops for a bus route + direction. */
  getBusStops(routeId: string, direction: string): Promise<BusStopInfo[]>;
  /** Live bus predictions for a stop. */
  getBusPredictions(
    stopId: string,
    routeId?: string,
    limit?: number,
    direction?: string
  ): Promise<ArrivalLike[]>;
  /** Live train arrivals for a station. */
  getTrainArrivals(
    stationId: string,
    routeCode?: string,
    direction?: string
  ): Promise<ArrivalLike[]>;
  /** Stations on a train line (static CTA data), for the deterministic fast-path. */
  getTrainStations(line: string): Promise<TrainStationInfo[]>;
}
