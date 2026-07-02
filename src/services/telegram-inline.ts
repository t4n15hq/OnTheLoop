/**
 * Inline-mode result builder (#52).
 *
 * Handles `@OnTheLoop_bot <query>` typed in ANY chat: match the query against
 * CTA train stations by name and return a few `InlineQueryResultArticle`s whose
 * message content is a live-arrivals board for that station. Stateless and
 * anonymous — no user, no personal data, read-only arrivals.
 *
 * External calls go through the injected {@link InlineDeps} so this is unit
 * testable with fakes, mirroring the assistant module's `defaultDeps` pattern.
 *
 * NOTE: inline mode must also be switched on once by the operator in BotFather
 * (`/setinline`). This handler is inert until then, but harmless to ship.
 */
import { CTALookupService } from './cta-lookup.service';
import { CTAService } from './cta.service';
import { escapeHtml } from './telegram.service';

/** Upper bound on articles returned — keeps us well within Telegram's cap. */
export const MAX_INLINE_RESULTS = 6;

/** Minimal station shape the builder needs (CTA lookup's TrainStation fits). */
export interface InlineStation {
  map_id: string;
  station_name: string;
}

/** Minimal arrival shape the builder needs (`FormattedArrival` is assignable). */
export interface InlineArrival {
  routeName?: string;
  destination: string;
  minutesAway: number | null;
  isApproaching?: boolean;
  isDelayed?: boolean;
}

/** A Telegram InlineQueryResultArticle (only the fields we set). */
export interface InlineQueryResultArticle {
  type: 'article';
  id: string;
  title: string;
  description: string;
  input_message_content: {
    message_text: string;
    parse_mode: 'HTML';
    disable_web_page_preview: true;
  };
}

export interface InlineDeps {
  getTrainStations: () => Promise<InlineStation[]>;
  getTrainArrivals: (stationId: string) => Promise<InlineArrival[]>;
}

/** Real-service wiring. */
export const defaultInlineDeps: InlineDeps = {
  getTrainStations: () => CTALookupService.getTrainStations() as Promise<InlineStation[]>,
  getTrainArrivals: (stationId) =>
    CTAService.getTrainArrivals(stationId) as Promise<InlineArrival[]>,
};

/** CTA route codes → friendly line names for display. */
const LINE_LABELS: Record<string, string> = {
  Red: 'Red', Blue: 'Blue', Brn: 'Brown', G: 'Green',
  Org: 'Orange', P: 'Purple', Pink: 'Pink', Y: 'Yellow',
};

/** "Brn Line" → "Brown"; unknown codes pass through unchanged. */
export function lineLabel(routeName?: string): string {
  if (!routeName) return '';
  const code = routeName.replace(/\s*Line$/i, '').trim();
  return LINE_LABELS[code] ?? code;
}

/** Distinct serving lines present in the arrivals, in soonest-first order. */
export function servingLines(arrivals: InlineArrival[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arrivals) {
    const label = lineLabel(a.routeName);
    if (label && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

/**
 * Reorder soonest-first arrivals so every distinct line's next train appears
 * before any line's second train. A multi-line station (e.g. Belmont =
 * Red/Brown/Purple) then always surfaces each line instead of, say, four Brown
 * trains that happened to be the numerically-soonest. Order within the two
 * groups is preserved, so it stays soonest-first inside each.
 */
export function diversifyByLine(arrivals: InlineArrival[]): InlineArrival[] {
  const seen = new Set<string>();
  const firstPerLine: InlineArrival[] = [];
  const rest: InlineArrival[] = [];
  for (const a of arrivals) {
    const key = a.routeName ?? '';
    if (!seen.has(key)) {
      seen.add(key);
      firstPerLine.push(a);
    } else {
      rest.push(a);
    }
  }
  return [...firstPerLine, ...rest];
}

function arrivalMinutesLabel(a: InlineArrival): string {
  if (a.isApproaching) return 'Due';
  if (a.minutesAway === null) return '—';
  if (a.minutesAway <= 0) return 'Due';
  if (a.minutesAway === 1) return '1 min';
  return `${a.minutesAway} min`;
}

/** One-line summary used as the article's grey subtitle in the picker. */
export function describeArrivals(arrivals: InlineArrival[]): string {
  if (arrivals.length === 0) return 'No arrivals right now';
  return 'Next: ' + arrivals.slice(0, 3).map(arrivalMinutesLabel).join(', ');
}

/** The HTML board sent into the chat when a result is tapped. */
export function formatInlineBoard(
  stationName: string,
  arrivals: InlineArrival[],
  servingLineNames: string[] = []
): string {
  const header = servingLineNames.length
    ? `<b>${escapeHtml(stationName)}</b> — ${escapeHtml(servingLineNames.join(', '))}`
    : `<b>${escapeHtml(stationName)}</b>`;
  if (arrivals.length === 0) {
    return `${header}\n\nNo arrivals right now.`;
  }
  const lines = arrivals.slice(0, 4).map((a, i) => {
    const who = a.routeName ? `${escapeHtml(a.routeName)} to ${escapeHtml(a.destination)}` : escapeHtml(a.destination);
    const flag = a.isDelayed ? ' <i>(delayed)</i>' : '';
    return `${i + 1}. ${who} — ${arrivalMinutesLabel(a)}${flag}`;
  });
  return [header, '', ...lines].join('\n');
}

/**
 * Build inline articles for a query. Matches train stations by name (case
 * insensitive substring), de-duplicates by station map_id, then fetches live
 * arrivals for each (bounded to {@link MAX_INLINE_RESULTS}, concurrently, with a
 * per-station catch so one slow station can't sink the batch).
 */
export async function buildInlineResults(
  rawQuery: string,
  deps: InlineDeps = defaultInlineDeps
): Promise<InlineQueryResultArticle[]> {
  const query = (rawQuery || '').trim().toLowerCase();
  // Ignore empty / 1-char queries so we don't return the whole system.
  if (query.length < 2) return [];

  const stations = await deps.getTrainStations();
  const seen = new Set<string>();
  const matches: InlineStation[] = [];
  for (const s of stations) {
    if (!s.station_name.toLowerCase().includes(query)) continue;
    if (seen.has(s.map_id)) continue;
    seen.add(s.map_id);
    matches.push(s);
    if (matches.length >= MAX_INLINE_RESULTS) break;
  }
  if (matches.length === 0) return [];

  return Promise.all(
    matches.map(async (s) => {
      let arrivals: InlineArrival[] = [];
      try {
        arrivals = await deps.getTrainArrivals(s.map_id);
      } catch {
        arrivals = [];
      }
      // Surface each serving line, not just the numerically-soonest few (a
      // multi-line station like Belmont was showing only one line). The line
      // list also disambiguates same-named stations (e.g. Belmont Red/Brown/
      // Purple vs. Belmont on the Blue line) in the inline picker.
      const ordered = diversifyByLine(arrivals);
      const lines = servingLines(ordered);
      const linePrefix = lines.length ? `${lines.join(', ')} · ` : '';
      return {
        type: 'article' as const,
        id: `stn-${s.map_id}`,
        title: s.station_name,
        description: linePrefix + describeArrivals(ordered),
        input_message_content: {
          message_text: formatInlineBoard(s.station_name, ordered, lines),
          parse_mode: 'HTML' as const,
          disable_web_page_preview: true as const,
        },
      };
    })
  );
}
