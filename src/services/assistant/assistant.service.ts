/**
 * Transit assistant orchestrator.
 *
 * `answer()` is a pure-ish coordinator: it composes the intent/match/enrich/
 * format modules and returns an {@link AssistantResult}. All external calls go
 * through {@link AssistantDeps}, so the whole flow can be unit-tested with fakes.
 * The controller is a thin wrapper around this.
 *
 * Load protection (issue #58): before touching Gemini we try, in order, (1) a
 * signed-in user's favorites and (2) a conservative rule-based fast-path — both
 * answer straight from the CTA API with ZERO Gemini calls. Only genuinely
 * ambiguous / open-ended queries reach the (cached, coalesced, concurrency-
 * capped) Gemini pipeline. Every Gemini-dependent step is wrapped so that
 * saturation / timeout / error degrades to a helpful non-LLM answer, never a
 * 500.
 */
import logger from '../../utils/logger';
import prisma from '../../utils/db';
import { reportError } from '../../utils/sentry';
import { AISMSService } from '../ai-sms.service';
import { GeminiMapsService } from '../gemini-maps.service';
import { CTAService } from '../cta.service';
import { CTALookupService } from '../cta-lookup.service';

import type { AssistantDeps } from './deps';
import type {
  AssistantInput,
  AssistantResult,
  ParsedIntent,
  RealTimeArrivals,
} from './types';
import { extractRoutesFromDirections, looksLikeAddress } from './intent';
import { favoriteStopId, selectFavorite } from './match';
import { parseFastPath, type FastPathParse } from './fast-path';
import {
  enrichDirectionsArrivals,
  enrichFavoriteArrivals,
  enrichRouteArrivals,
  isValidArrival,
} from './enrich';
import {
  formatDirectionsAnswer,
  formatFavoriteArrivals,
  formatNoService,
  formatRouteArrivals,
  formatTrainStationArrivals,
} from './format';

/** Deterministic fallback when we took the fast-path but found no live data. */
const FASTPATH_FALLBACK =
  "I couldn't find live arrivals for that right now. Try a specific route like " +
  '"next 22", or check transitchicago.com.';

/** Deterministic fallback when the Gemini pipeline is unavailable/saturated. */
const DEGRADED_FALLBACK =
  'The assistant is busy right now. Try a specific route like "next 22" or ' +
  '"Red line at Belmont", or check transitchicago.com.';

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
  getTrainStations: (line) => CTALookupService.getTrainStations(line),
};

/** Case-insensitive station-name match: exact first, then substring either way. */
function findStation<T extends { station_name: string }>(
  stations: T[],
  query: string
): T | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = stations.find((s) => s.station_name.toLowerCase() === q);
  if (exact) return exact;
  return (
    stations.find(
      (s) =>
        s.station_name.toLowerCase().includes(q) ||
        q.includes(s.station_name.toLowerCase())
    ) ?? null
  );
}

/**
 * Answer a deterministic train fast-path parse ("Red line at Belmont") straight
 * from the CTA API — never calls Gemini. Always produces a helpful string, even
 * when there's nothing to show.
 */
async function answerTrainFastPath(
  fp: Extract<FastPathParse, { kind: 'train' }>,
  deps: AssistantDeps
): Promise<{ answer: string; realTimeArrivals: RealTimeArrivals }> {
  if (!fp.station) {
    return {
      answer: `Which ${fp.line} Line station? Try e.g. "${fp.line} line at Belmont".`,
      realTimeArrivals: null,
    };
  }

  try {
    const stations = await deps.getTrainStations(fp.code);
    const station = findStation(stations, fp.station);

    if (!station) {
      return {
        answer:
          `I couldn't find a ${fp.line} Line station matching "${fp.station}". ` +
          `Try the exact station name, e.g. "${fp.line} line at Belmont".`,
        realTimeArrivals: null,
      };
    }

    const arrivals = await deps.getTrainArrivals(station.map_id, fp.code, fp.direction);
    const valid = arrivals.filter(isValidArrival);

    if (valid.length === 0) {
      return {
        answer: `No ${fp.line} Line trains at ${station.station_name} right now.`,
        realTimeArrivals: null,
      };
    }

    const formatted = formatTrainStationArrivals(
      fp.line,
      fp.code,
      station.station_name,
      station.map_id,
      fp.direction,
      valid
    );
    return { answer: formatted.answer, realTimeArrivals: formatted.realTimeArrivals };
  } catch (err) {
    reportError(err, { route: 'cta/assistant/fast-path-train', line: fp.code });
    return { answer: FASTPATH_FALLBACK, realTimeArrivals: null };
  }
}

/**
 * Answer a natural-language transit query with an optional live-arrivals
 * payload.
 *
 * Order of resolution (cheapest / safest first):
 *   1. Favorites (signed-in, non-address) — CTA only, no Gemini.
 *   2. Rule-based fast-path — CTA only, no Gemini.
 *   3. Gemini pipeline (intent parse → directions), cached + coalesced +
 *      concurrency-capped, with graceful degradation on failure.
 */
export async function answer(
  input: AssistantInput,
  deps: AssistantDeps = defaultDeps
): Promise<AssistantResult> {
  const { query, userId } = input;

  let realTimeArrivals: RealTimeArrivals = null;
  let conversationalResponse: string | null = null;

  // 1. Favorite match — only for signed-in users, and never for address-style
  //    queries (those always go to Maps-grounded routing). No Gemini here.
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

  // 2. Determine intent. Prefer the deterministic fast-path (no Gemini); only
  //    fall back to the Gemini parse for queries it isn't confident about.
  let parsed: ParsedIntent | null = null;
  let tookFastPath = false;

  if (!realTimeArrivals && !conversationalResponse) {
    const fast = parseFastPath(query);
    if (fast) {
      tookFastPath = true;
      if (fast.kind === 'train') {
        const tr = await answerTrainFastPath(fast, deps);
        conversationalResponse = tr.answer;
        realTimeArrivals = tr.realTimeArrivals;
      } else {
        // Bus route → reuse the existing (Gemini-free) route_arrivals branch.
        parsed = { intent: 'route_arrivals', routeNumber: fast.routeNumber };
      }
    } else {
      // Ambiguous / open-ended → Gemini intent parse (cached, coalesced, capped).
      // parseQuery already swallows its own errors, but guard defensively so a
      // hard failure degrades gracefully instead of 500-ing.
      try {
        parsed = await deps.parseQuery(query);
      } catch (err) {
        reportError(err, { route: 'cta/assistant/parse', userId, queryLength: query.length });
        parsed = { intent: 'unknown' };
      }
    }
  }

  // 3. Intent-based handling when no favorite / train fast-path produced an answer.
  if (!realTimeArrivals && !conversationalResponse && parsed) {
    if (parsed.intent === 'transit_directions' && parsed.origin && parsed.destination) {
      try {
        // Get AI-powered directions, then append a bounded live-arrivals footer.
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
        // getTransitSuggestion degrades internally, but guard against a throw
        // so we never 500 the endpoint.
        try {
          conversationalResponse = await deps.getTransitSuggestion(query);
        } catch {
          conversationalResponse = DEGRADED_FALLBACK;
        }
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

  // 4. Terminal fallback.
  //    - An answer from above wins.
  //    - A fast-pathed query never falls back to Gemini (keeps its zero-Gemini
  //      guarantee); it degrades to a deterministic hint instead.
  //    - Otherwise defer to the Gemini suggestion, degrading gracefully on error.
  let finalAnswer: string;
  if (conversationalResponse) {
    finalAnswer = conversationalResponse;
  } else if (tookFastPath) {
    finalAnswer = FASTPATH_FALLBACK;
  } else {
    try {
      finalAnswer = await deps.getTransitSuggestion(query);
    } catch (err) {
      reportError(err, { route: 'cta/assistant/terminal', userId, queryLength: query.length });
      finalAnswer = DEGRADED_FALLBACK;
    }
  }

  return { query, answer: finalAnswer, realTimeArrivals };
}
