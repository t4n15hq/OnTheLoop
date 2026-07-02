/**
 * Transit assistant orchestrator.
 *
 * `answer()` is a pure-ish coordinator: it composes the intent/match/enrich/
 * format modules and returns an {@link AssistantResult}. All external calls go
 * through {@link AssistantDeps}, so the whole flow can be unit-tested with fakes.
 * The controller is a thin wrapper around this.
 */
import logger from '../../utils/logger';
import prisma from '../../utils/db';
import { reportError } from '../../utils/sentry';
import { AISMSService } from '../ai-sms.service';
import { GeminiMapsService } from '../gemini-maps.service';
import { CTAService } from '../cta.service';
import { CTALookupService } from '../cta-lookup.service';

import type { AssistantDeps } from './deps';
import type { AssistantInput, AssistantResult, RealTimeArrivals } from './types';
import { extractRoutesFromDirections, looksLikeAddress } from './intent';
import { favoriteStopId, selectFavorite } from './match';
import {
  enrichDirectionsArrivals,
  enrichFavoriteArrivals,
  enrichRouteArrivals,
} from './enrich';
import {
  formatDirectionsAnswer,
  formatFavoriteArrivals,
  formatNoService,
  formatRouteArrivals,
} from './format';

/** Real-service wiring. Each call is wrapped so `this`-binding is never an issue. */
export const defaultDeps: AssistantDeps = {
  parseQuery: (query) => AISMSService.parseQuery(query),
  getFavorites: (userId) => prisma.favorite.findMany({ where: { userId } }),
  getTransitSuggestion: (query) => GeminiMapsService.getTransitSuggestion(query),
  getBusRoutes: () => CTALookupService.getBusRoutes(),
  getBusDirections: (routeId) => CTALookupService.getBusDirections(routeId),
  getBusStops: (routeId, direction) => CTALookupService.getBusStops(routeId, direction),
  getBusPredictions: (stopId, routeId, limit, direction) =>
    CTAService.getBusPredictions(stopId, routeId, limit, direction),
  getTrainArrivals: (stationId, routeCode, direction) =>
    CTAService.getTrainArrivals(stationId, routeCode, direction),
};

/**
 * Answer a natural-language transit query with an optional live-arrivals
 * payload. Behavior is byte-for-byte equivalent to the integrated
 * `CTAController.getTransitSuggestion`: same favorite match, same bounded
 * live-arrivals fan-out (#14), same Sentry reporting (#13), and the same
 * terminal `conversationalResponse || getTransitSuggestion(query)` fallback.
 */
export async function answer(
  input: AssistantInput,
  deps: AssistantDeps = defaultDeps
): Promise<AssistantResult> {
  const { query, userId } = input;

  const parsed = await deps.parseQuery(query);
  let realTimeArrivals: RealTimeArrivals = null;
  let conversationalResponse: string | null = null;

  // 1. Favorite match — only for signed-in users, and never for address-style
  //    queries (those always go to Maps-grounded routing).
  if (userId && !looksLikeAddress(query)) {
    const favorites = await deps.getFavorites(userId);
    const matchingFavorite = selectFavorite(query, favorites);

    if (matchingFavorite) {
      logger.info(`Found matching favorite: ${matchingFavorite.name}`);
      const stopId = favoriteStopId(matchingFavorite);

      if (stopId) {
        const validArrivals = await enrichFavoriteArrivals(matchingFavorite, stopId, deps);
        if (validArrivals.length > 0) {
          const formatted = formatFavoriteArrivals(matchingFavorite, stopId, validArrivals);
          realTimeArrivals = formatted.realTimeArrivals;
          conversationalResponse = formatted.answer;
        }
      }
    }
  }

  // 2. Fall back to intent-based handling when no favorite produced arrivals.
  if (!realTimeArrivals) {
    if (parsed.intent === 'transit_directions' && parsed.origin && parsed.destination) {
      try {
        // Get AI-powered directions, then append a bounded live-arrivals footer.
        // The whole block is one try (as in the integrated controller): if it
        // throws, we report to Sentry and re-run the suggestion once.
        const directions = await deps.getTransitSuggestion(query);
        const { busRoutes } = extractRoutesFromDirections(directions, query);
        const routeArrivals = await enrichDirectionsArrivals(busRoutes, deps);
        const formatted = formatDirectionsAnswer(directions, routeArrivals);
        conversationalResponse = formatted.answer;
        realTimeArrivals = formatted.realTimeArrivals;
      } catch (err) {
        reportError(err, {
          route: 'cta/transit-suggestion/directions',
          userId,
          queryLength: query.length,
        });
        conversationalResponse = await deps.getTransitSuggestion(query);
      }
    } else if (parsed.intent === 'route_arrivals' && parsed.routeNumber) {
      try {
        const routeNumber = parsed.routeNumber;
        const routes = await deps.getBusRoutes();
        const route = routes.find((r) => r.rt === routeNumber);

        if (route) {
          const stops = await enrichRouteArrivals(routeNumber, deps);
          if (stops.length > 0) {
            const formatted = formatRouteArrivals(routeNumber, route.rtnm, stops);
            realTimeArrivals = formatted.realTimeArrivals;
            conversationalResponse = formatted.answer;
          } else {
            conversationalResponse = formatNoService(routeNumber, route.rtnm);
          }
        }
      } catch (err) {
        reportError(err, {
          route: 'cta/transit-suggestion/route-arrivals',
          routeNumber: parsed.routeNumber,
          userId,
        });
      }
    }
  }

  // 3. Terminal fallback — mirrors the controller's `answer:` expression. Fires
  //    when no branch produced an answer (find_stops / favorites / unknown
  //    intents, an unresolved route, or a directions failure above).
  const finalAnswer =
    conversationalResponse || (await deps.getTransitSuggestion(query));

  return { query, answer: finalAnswer, realTimeArrivals };
}
