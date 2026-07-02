/**
 * Rule-based fast-path for the transit assistant (issue #58).
 *
 * A conservative, deterministic parser for the most common query shapes:
 *   • a bus route number, optionally wrapped in filler — "22", "next 22",
 *     "when's the next 22 bus", "/next 60"
 *   • a train line, optionally with a station — "next Red", "Red line",
 *     "when's the blue line at Belmont", "brown at Belmont"
 *
 * When it is confident, the assistant answers straight from the CTA API and
 * SKIPS Gemini entirely. It is intentionally conservative: anything ambiguous
 * (directions "A to B", addresses, extra unknown words, multiple routes) returns
 * `null` and falls through to the existing Gemini pipeline. False negatives just
 * cost a Gemini call; false positives would give wrong answers, so we bias hard
 * toward returning `null`.
 *
 * Pure and network-free — trivially unit-testable.
 */
import { looksLikeAddress } from './intent';

/** CTA train line: the color word and its CTA route/station code. */
interface TrainLine {
  /** Human name, e.g. "Red". */
  name: string;
  /** CTA route code used for arrivals + station lookup, e.g. "Red", "Brn". */
  code: string;
  /** Recognized words that map to this line. */
  words: string[];
}

const TRAIN_LINES: TrainLine[] = [
  { name: 'Red', code: 'Red', words: ['red'] },
  { name: 'Blue', code: 'Blue', words: ['blue'] },
  { name: 'Brown', code: 'Brn', words: ['brown', 'brn'] },
  { name: 'Green', code: 'G', words: ['green'] },
  { name: 'Orange', code: 'Org', words: ['orange', 'org'] },
  { name: 'Purple', code: 'P', words: ['purple'] },
  { name: 'Pink', code: 'Pink', words: ['pink'] },
  { name: 'Yellow', code: 'Y', words: ['yellow'] },
];

const DIRECTION_WORDS = [
  'northbound',
  'southbound',
  'eastbound',
  'westbound',
  'inbound',
  'outbound',
];

/**
 * Filler words that carry no routing information. Deliberately excludes words
 * that signal a different intent ("to", "from", "near", "my", "stops",
 * "directions") so those queries fall through to Gemini.
 */
const FILLER = new Set([
  'next',
  'when',
  'whens',
  "when's",
  'when’s',
  'what',
  'whats',
  "what's",
  'what’s',
  'is',
  'are',
  'the',
  'a',
  'an',
  'arrival',
  'arrivals',
  'arriving',
  'eta',
  'coming',
  'come',
  'show',
  'me',
  'please',
  'time',
  'times',
  'schedule',
  'due',
]);

const SLASH_COMMANDS = new Set([
  '/next',
  '/n',
  '/bus',
  '/train',
  '/arrivals',
  '/eta',
  '/when',
]);

export type FastPathParse =
  | { kind: 'bus'; routeNumber: string }
  | { kind: 'train'; line: string; code: string; station?: string; direction?: string };

/**
 * Attempt a confident deterministic parse. Returns `null` when not confident so
 * the caller falls through to the Gemini pipeline.
 */
export function parseFastPath(rawQuery: string): FastPathParse | null {
  if (!rawQuery) return null;

  let q = rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return null;

  // Directions and addresses are never fast-pathed — they need Gemini/Maps.
  if (/\b(to|from|near|between|vs|versus)\b/.test(q)) return null;
  if (looksLikeAddress(rawQuery)) return null;

  // Strip a single leading slash command ("/next Red").
  const firstSpace = q.indexOf(' ');
  const firstTok = firstSpace === -1 ? q : q.slice(0, firstSpace);
  if (firstTok.startsWith('/')) {
    if (!SLASH_COMMANDS.has(firstTok)) return null; // unknown command → defer
    q = firstSpace === -1 ? '' : q.slice(firstSpace + 1).trim();
    if (!q) return null;
  }

  // Tokenize, dropping punctuation-only noise and pure filler.
  const tokens = q
    .split(' ')
    .map((t) => t.replace(/[?!.,]+$/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  // ── Train line? ──────────────────────────────────────────────────────────
  const lineIdx = tokens.findIndex((t) => TRAIN_LINES.some((l) => l.words.includes(t)));
  if (lineIdx !== -1) {
    const line = TRAIN_LINES.find((l) => l.words.includes(tokens[lineIdx]))!;

    // Everything after an "at" marker is treated as the station name.
    const atIdx = tokens.indexOf('at');
    let station: string | undefined;
    let head = tokens;
    if (atIdx !== -1) {
      const stationTokens = tokens.slice(atIdx + 1);
      station = stationTokens.join(' ').trim() || undefined;
      head = tokens.slice(0, atIdx);
    }

    // A direction word anywhere is captured (and not treated as leftover noise).
    const direction = DIRECTION_WORDS.find((d) => head.includes(d));

    // The "head" (before any station) must contain only: the line word, the
    // word "line", a direction, and filler. Anything else → not confident.
    const leftover = head.filter(
      (t) =>
        !line.words.includes(t) &&
        t !== 'line' &&
        !FILLER.has(t) &&
        !DIRECTION_WORDS.includes(t)
    );
    if (leftover.length > 0) return null;

    return { kind: 'train', line: line.name, code: line.code, station, direction };
  }

  // ── Bus route number? ──────────────────────────────────────────────────────
  const numberTokens = tokens.filter((t) => /^\d{1,3}[a-z]?$/.test(t));
  if (numberTokens.length !== 1) return null; // 0 or >1 numbers → defer

  const routeNumber = numberTokens[0];

  // Everything else must be filler / "bus" / a direction word, else defer. (The
  // pipeline's route_arrivals branch enriches all directions, so a direction
  // word here is accepted but not acted on — still a correct, if broader, answer.)
  const leftover = tokens.filter(
    (t) => t !== routeNumber && t !== 'bus' && !FILLER.has(t) && !DIRECTION_WORDS.includes(t)
  );
  if (leftover.length > 0) return null;

  return { kind: 'bus', routeNumber };
}
