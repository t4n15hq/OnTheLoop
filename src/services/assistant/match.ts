/**
 * Pure favorite-matching for the transit assistant.
 *
 * Favorites are passed in (already scoped to the signed-in user), so this
 * module never touches the database and is trivially unit-testable.
 */
import type { FavoriteLike } from './types';

/** Tokens too generic to be useful for matching a favorite by name. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'get',
  'can',
  'what',
  'when',
  'where',
  'next',
  'bus',
  'train',
  'line',
]);

/** Default minimum score to accept a favorite match (avoids false positives). */
export const DEFAULT_MATCH_THRESHOLD = 0.5;

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

function favoriteTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

export interface FavoriteMatch<F extends FavoriteLike = FavoriteLike> {
  favorite: F;
  score: number;
}

/**
 * Score a query against a set of favorites and return the best match with its
 * score, or `null` if there is nothing meaningful to match on. The score is the
 * fraction of query tokens that fuzzily hit a favorite-name token.
 *
 * Pure: no threshold gating here — callers decide via {@link selectFavorite}.
 */
export function scoreFavorites<F extends FavoriteLike>(
  query: string,
  favorites: F[]
): FavoriteMatch<F> | null {
  const qTokens = queryTokens(query);
  if (qTokens.length === 0) return null;

  let best: FavoriteMatch<F> | null = null;
  for (const fav of favorites) {
    const favTokens = favoriteTokens(fav.name);
    if (favTokens.length === 0) continue;

    let matches = 0;
    for (const qt of qTokens) {
      if (favTokens.some((ft) => ft === qt || ft.includes(qt) || qt.includes(ft))) {
        matches++;
      }
    }
    const score = matches / qTokens.length;
    if (!best || score > best.score) {
      best = { favorite: fav, score };
    }
  }

  return best;
}

/**
 * Return the best-matching favorite only if it clears `threshold`, else `null`.
 */
export function selectFavorite<F extends FavoriteLike>(
  query: string,
  favorites: F[],
  threshold: number = DEFAULT_MATCH_THRESHOLD
): F | null {
  const best = scoreFavorites(query, favorites);
  if (best && best.score >= threshold) return best.favorite;
  return null;
}

/**
 * Resolve the CTA stop/station id to poll for a favorite: station for trains,
 * stop for buses, falling back to the generic boarding-stop id.
 */
export function favoriteStopId(favorite: FavoriteLike): string | null {
  const id =
    favorite.routeType === 'TRAIN'
      ? favorite.stationId || favorite.boardingStopId
      : favorite.stopId || favorite.boardingStopId;
  return id ?? null;
}
