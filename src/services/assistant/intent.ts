/**
 * Pure intent/heuristic helpers for the transit assistant.
 *
 * The AI-backed intent classification lives in `AISMSService.parseQuery`
 * (kept injectable so it can be mocked). Everything here is deterministic and
 * network-free: address detection and pulling CTA route/line identifiers back
 * out of a free-text directions answer.
 */

/** Chicago-address heuristic: a street number + directional, or a street-type word. */
export function looksLikeAddress(query: string): boolean {
  return /\b\d{2,5}\s+[nsew]\b|\b(st|ave|avenue|blvd|road|rd|drive|dr|street)\b/i.test(
    query
  );
}

export interface ExtractedRoutes {
  busRoutes: string[];
  trainLines: string[];
}

/**
 * Extract bus route numbers and train line colors from a free-text directions
 * answer. Falls back to scanning the original query for a bare route number
 * when the directions text yields nothing.
 *
 * Deterministic and tolerant of malformed / empty AI output: any input that
 * contains no recognizable routes yields empty arrays (never throws).
 */
export function extractRoutesFromDirections(
  directions: string,
  query: string
): ExtractedRoutes {
  const text = directions || '';

  // Bus routes: "route 60", "bus 157", "#66", "Route 22"
  const busPattern = /(?:route|bus|#|Route)\s*(\d+)/gi;
  const busMatches = [...text.matchAll(busPattern)];
  let busRoutes = busMatches.map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);

  // Markdown-emphasized numbers like "**157**" or "**Route 60**"
  const markdownPattern = /\*\*(?:Route\s*)?(\d+)/gi;
  const markdownMatches = [...text.matchAll(markdownPattern)];
  busRoutes = [...new Set([...busRoutes, ...markdownMatches.map((m) => m[1])])];

  // Train lines: "Red Line", "Blue Line", etc.
  const trainPattern = /(Red|Blue|Brown|Green|Orange|Pink|Purple|Yellow)\s+Line/gi;
  const trainMatches = [...text.matchAll(trainPattern)];
  const trainLines = trainMatches.map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);

  // Nothing in the directions text — try a bare route number in the query.
  if (busRoutes.length === 0 && trainLines.length === 0) {
    const queryRouteMatch = (query || '').match(/\b(\d{1,3})\b/);
    if (queryRouteMatch) {
      busRoutes.push(queryRouteMatch[1]);
    }
  }

  return { busRoutes, trainLines };
}
