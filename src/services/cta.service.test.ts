import { afterEach, describe, expect, it, vi } from 'vitest';
import { minutesFromNow, parseTrainTime } from './cta.service';

vi.mock('./cache.service', () => ({
  CacheService: {
    get: vi.fn(),
    set: vi.fn(),
    generateKey: vi.fn((prefix: string, ...parts: string[]) => `${prefix}:${parts.join(':')}`),
  },
}));

describe('CTA timestamp parsing', () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it('interprets train timestamps as Chicago time when the host runs in UTC', () => {
    process.env.TZ = 'UTC';

    const arrival = parseTrainTime('2026-04-20T14:02:02');
    const now = new Date('2026-04-20T18:52:02.000Z');

    expect(arrival.toISOString()).toBe('2026-04-20T19:02:02.000Z');
    expect(minutesFromNow(arrival, now)).toBe(10);
  });
});
