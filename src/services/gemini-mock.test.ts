/**
 * Proves GEMINI_MOCK=1 gates EVERY Gemini entry point (issue #58 item 5): the
 * SDKs are never called, deterministic results come back, and the shared
 * invocation counter increments once per logical call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// SDK clients must never be reached in mock mode; stub them so construction is
// safe and any accidental call would be observable.
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        generateContent: vi.fn(async () => {
          throw new Error('real Gemini called in mock mode');
        }),
      };
    }
  },
  HarmCategory: {},
  HarmBlockThreshold: {},
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: vi.fn(async () => {
        throw new Error('real Gemini called in mock mode');
      }),
    };
  },
  Tool: class {},
}));

// In-memory cache, cleared per test so counts are deterministic.
const store = new Map<string, unknown>();
vi.mock('./cache.service', () => ({
  CacheService: {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    generateKey: (prefix: string, ...parts: string[]) => `${prefix}:${parts.join(':')}`,
  },
}));
vi.mock('../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { AISMSService } from './ai-sms.service';
import { GeminiMapsService } from './gemini-maps.service';
import { getGeminiInvocationCount, resetGeminiInvocationCount } from './gemini-guard';

beforeEach(() => {
  store.clear();
  resetGeminiInvocationCount();
  process.env.GEMINI_MOCK = '1';
});

afterEach(() => {
  delete process.env.GEMINI_MOCK;
});

describe('GEMINI_MOCK gating + counter', () => {
  it('parseQuery returns a deterministic parse and counts one invocation', async () => {
    const unknown = await AISMSService.parseQuery('asdf qwerty');
    expect(unknown.intent).toBe('unknown');

    const directions = await AISMSService.parseQuery('from Northwestern to Willis Tower');
    expect(directions.intent).toBe('transit_directions');
    expect(directions.origin).toBe('Northwestern');
    expect(directions.destination).toBe('Willis Tower');

    expect(getGeminiInvocationCount()).toBe(2);
  });

  it('parseRouteConfig returns a deterministic config and counts one invocation', async () => {
    const config = await AISMSService.parseRouteConfig('Red Line from Howard to Loop');
    expect(config).toMatchObject({ routeType: 'BUS', routeId: '22' });
    expect(getGeminiInvocationCount()).toBe(1);
  });

  it('resolveLocation returns a deterministic location and counts one invocation', async () => {
    const loc = await GeminiMapsService.resolveLocation('Willis Tower');
    expect(loc).not.toBeNull();
    expect(loc?.coordinates).toEqual({ lat: 41.882, lon: -87.6278 });
    expect(getGeminiInvocationCount()).toBe(1);
  });

  it('getTransitSuggestion returns deterministic text and counts one invocation', async () => {
    const text = await GeminiMapsService.getTransitSuggestion('how do I get downtown');
    expect(text).toContain('Route 22');
    expect(getGeminiInvocationCount()).toBe(1);
  });

  it('all four entry points together count exactly four invocations', async () => {
    resetGeminiInvocationCount();
    await AISMSService.parseQuery('unique query one');
    await AISMSService.parseRouteConfig('unique query two');
    await GeminiMapsService.resolveLocation('unique query three');
    await GeminiMapsService.getTransitSuggestion('unique query four');
    expect(getGeminiInvocationCount()).toBe(4);
  });
});
