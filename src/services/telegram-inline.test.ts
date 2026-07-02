/**
 * Inline-mode result builder (#52). Uses injected deps so it's hermetic — the
 * real CTA lookups aren't hit; we just stub station + arrival data. (escapeHtml
 * from telegram.service is real and side-effect free.)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildInlineResults,
  describeArrivals,
  formatInlineBoard,
  type InlineDeps,
} from './telegram-inline';

// Keep the module graph light: these are only referenced by defaultInlineDeps,
// which the tests never use (deps are injected).
vi.mock('./cta-lookup.service', () => ({ CTALookupService: { getTrainStations: vi.fn() } }));
vi.mock('./cta.service', () => ({ CTAService: { getTrainArrivals: vi.fn() } }));

const STATIONS = [
  { map_id: '41320', station_name: 'Belmont' }, // Red/Brown/Purple share this map_id
  { map_id: '41320', station_name: 'Belmont' }, // duplicate → should be de-duped
  { map_id: '40060', station_name: 'Belmont' }, // Blue line Belmont, distinct map_id
  { map_id: '41220', station_name: 'Fullerton' },
];

function makeDeps(overrides: Partial<InlineDeps> = {}): InlineDeps {
  return {
    getTrainStations: vi.fn().mockResolvedValue(STATIONS),
    getTrainArrivals: vi.fn().mockResolvedValue([
      { routeName: 'Red Line', destination: 'Howard', minutesAway: 3, isApproaching: false, isDelayed: false },
      { routeName: 'Red Line', destination: '95th', minutesAway: 7, isApproaching: false, isDelayed: false },
    ]),
    ...overrides,
  };
}

describe('buildInlineResults (#52 inline mode)', () => {
  it('returns tappable arrival articles for matching stations, de-duped by map_id', async () => {
    const deps = makeDeps();
    const results = await buildInlineResults('Belmont', deps);

    // Two distinct Belmont map_ids (41320, 40060) → two articles; dup dropped.
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(['stn-41320', 'stn-40060']);
    expect(results[0]).toMatchObject({ type: 'article', title: 'Belmont' });

    // The tapped message carries a live board with the arrivals.
    expect(results[0].input_message_content.message_text).toContain('Belmont');
    expect(results[0].input_message_content.message_text).toContain('Howard');
    expect(results[0].input_message_content.parse_mode).toBe('HTML');
    expect(results[0].description).toContain('Next:');

    // Arrivals fetched once per distinct station.
    expect(deps.getTrainArrivals).toHaveBeenCalledTimes(2);
  });

  it('is case-insensitive and matches on substring', async () => {
    const deps = makeDeps();
    const results = await buildInlineResults('full', deps);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Fullerton');
  });

  it('returns nothing for empty or 1-char queries (does not dump the system)', async () => {
    const deps = makeDeps();
    expect(await buildInlineResults('', deps)).toEqual([]);
    expect(await buildInlineResults('b', deps)).toEqual([]);
    expect(deps.getTrainStations).not.toHaveBeenCalled();
  });

  it('returns nothing when no station matches', async () => {
    const deps = makeDeps();
    expect(await buildInlineResults('Nonexistent Stop', deps)).toEqual([]);
  });

  it('degrades gracefully when a station arrivals fetch throws', async () => {
    const deps = makeDeps({ getTrainArrivals: vi.fn().mockRejectedValue(new Error('CTA down')) });
    const results = await buildInlineResults('Fullerton', deps);
    expect(results).toHaveLength(1);
    expect(results[0].input_message_content.message_text).toContain('No arrivals right now');
    expect(results[0].description).toBe('No arrivals right now');
  });
});

describe('inline formatting helpers', () => {
  it('describeArrivals summarizes the next few times', () => {
    expect(
      describeArrivals([
        { destination: 'A', minutesAway: 2, isApproaching: false },
        { destination: 'B', minutesAway: 1, isApproaching: false },
        { destination: 'C', minutesAway: 0, isApproaching: true },
      ])
    ).toBe('Next: 2 min, 1 min, Due');
    expect(describeArrivals([])).toBe('No arrivals right now');
  });

  it('formatInlineBoard renders a numbered board (or a graceful empty state)', () => {
    const board = formatInlineBoard('Belmont', [
      { routeName: 'Red Line', destination: 'Howard', minutesAway: 4, isApproaching: false, isDelayed: false },
    ]);
    expect(board).toContain('<b>Belmont</b>');
    expect(board).toContain('1. Red Line to Howard — 4 min');
    expect(formatInlineBoard('Empty', [])).toContain('No arrivals right now.');
  });
});
