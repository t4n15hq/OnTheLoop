/**
 * Chat-endpoint rigor harness.
 *
 * Sends a curated suite of queries to the running local server's chat endpoint
 * (GET /api/cta/transit/ask), applies per-case structural assertions, and
 * prints a report. Exits non-zero if any case fails.
 *
 * Usage:
 *   npm run dev  (in one terminal)
 *   npx tsx scripts/chat-harness.ts
 *
 * Optional env:
 *   CHAT_HARNESS_BASE_URL  (default http://localhost:3000)
 *   CHAT_HARNESS_TIMEOUT_MS (default 45000)
 *   CHAT_HARNESS_CONCURRENCY (default 3 — stay gentle on Gemini quota)
 */

import axios, { AxiosError } from 'axios';

type Expectation = (resp: { query: string; answer?: string; realTimeArrivals?: any }) => string | null;

interface Case {
  name: string;
  query: string;
  category: string;
  expect: Expectation[];
  // Expected HTTP status. Default 200.
  status?: number;
}

const BASE_URL = process.env.CHAT_HARNESS_BASE_URL || 'http://localhost:3000';
const TIMEOUT = parseInt(process.env.CHAT_HARNESS_TIMEOUT_MS || '45000', 10);
const CONCURRENCY = parseInt(process.env.CHAT_HARNESS_CONCURRENCY || '3', 10);

// ───────────────────────────────────────────────────────────────────────────
// Expectation helpers — small composable checks that return null on pass,
// an error string on fail.
// ───────────────────────────────────────────────────────────────────────────
const nonEmptyAnswer: Expectation = (r) => {
  if (!r.answer || r.answer.trim().length === 0) return 'answer was empty';
  return null;
};

const answerMinLength = (n: number): Expectation => (r) => {
  if (!r.answer || r.answer.length < n) return `answer too short (${r.answer?.length ?? 0} < ${n})`;
  return null;
};

const answerContainsAny = (needles: string[]): Expectation => (r) => {
  const body = (r.answer || '').toLowerCase();
  if (!needles.some((n) => body.includes(n.toLowerCase()))) {
    return `answer missing any of: ${needles.join(' | ')}`;
  }
  return null;
};

const answerContainsAll = (needles: string[]): Expectation => (r) => {
  const body = (r.answer || '').toLowerCase();
  const missing = needles.filter((n) => !body.includes(n.toLowerCase()));
  if (missing.length) return `answer missing: ${missing.join(', ')}`;
  return null;
};

const answerDoesNotContain = (needles: string[]): Expectation => (r) => {
  const body = r.answer || '';
  for (const n of needles) {
    // Plain substring — case-sensitive for artifacts like "(236 chars)".
    if (body.includes(n)) return `answer unexpectedly contains: ${n}`;
  }
  return null;
};

const answerDoesNotMatch = (pattern: RegExp): Expectation => (r) => {
  if ((r.answer || '').match(pattern)) return `answer matches forbidden pattern: ${pattern}`;
  return null;
};

// ───────────────────────────────────────────────────────────────────────────
// Test suite. Grouped by the branch of the controller they exercise.
// ───────────────────────────────────────────────────────────────────────────
const cases: Case[] = [
  // ─────────────── Trip-planning: landmarks ───────────────
  {
    name: 'landmarks: Willis Tower → Wrigley Field',
    query: 'how do I get from Willis Tower to Wrigley Field',
    category: 'directions',
    expect: [
      nonEmptyAnswer,
      answerMinLength(40),
      answerContainsAny(['Red Line', 'Brown Line', 'Addison', 'CTA', 'bus', 'train']),
      answerDoesNotMatch(/\(\d+\s*(chars?|characters?|words?)\)/i),
    ],
  },
  {
    name: 'landmarks: Union Station → Navy Pier',
    query: 'directions from Union Station to Navy Pier using CTA',
    category: 'directions',
    expect: [
      nonEmptyAnswer,
      answerContainsAny(['bus', 'train', 'Line', 'Route', 'walk']),
    ],
  },
  {
    name: 'neighborhoods: Wicker Park → Hyde Park',
    query: 'how do I get from Wicker Park to Hyde Park on the CTA?',
    category: 'directions',
    expect: [nonEmptyAnswer, answerMinLength(40)],
  },
  // ─────────────── Trip-planning: street addresses ───────────────
  {
    name: 'addresses: S Lytle → S Wolcott',
    query: 'how do I get from 1029 S Lytle to 820 S Wolcott',
    category: 'directions',
    expect: [nonEmptyAnswer, answerContainsAny(['bus', 'Line', 'walk', 'Route', 'stop'])],
  },
  {
    name: 'addresses: informal phrasing',
    query: 'best way from 200 S Michigan Ave to 600 W Chicago Ave',
    category: 'directions',
    expect: [nonEmptyAnswer],
  },
  // ─────────────── Route arrivals (no favorites for anon caller) ───────────────
  {
    name: 'route arrivals: numeric bus',
    query: "when's the next 157 bus?",
    category: 'arrivals',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'route arrivals: just a number',
    query: '60',
    category: 'arrivals',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'route arrivals: train line',
    query: "when's the next blue line?",
    category: 'arrivals',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'route arrivals: train line alt phrasing',
    query: 'Red Line Howard',
    category: 'arrivals',
    expect: [nonEmptyAnswer],
  },
  // ─────────────── Find stops ───────────────
  {
    name: 'find stops: route + location',
    query: 'Route 60 stops near Northwestern',
    category: 'find_stops',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'find stops: near intersection',
    query: 'Route 22 stops near Clark and Division',
    category: 'find_stops',
    expect: [nonEmptyAnswer],
  },
  // ─────────────── Edge cases ───────────────
  {
    name: 'edge: empty query',
    query: '',
    category: 'edge',
    expect: [() => null],
    status: 400,
  },
  {
    name: 'edge: whitespace-only query',
    query: '   ',
    category: 'edge',
    // Whitespace should 400 — a blank message is not a query. Prevents us
    // from burning Gemini calls on empty input.
    expect: [() => null],
    status: 400,
  },
  {
    name: 'edge: nonsense input',
    query: 'asdf qwerty zxcvb',
    category: 'edge',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'edge: single greeting',
    query: 'hello',
    category: 'edge',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'edge: non-Chicago trip',
    query: 'how do I get from Boston to New York on the CTA?',
    category: 'edge',
    // Expect a graceful answer, not a crash. Don't assert it refuses — the
    // model can go either way, and forcing a refusal is brittle.
    expect: [nonEmptyAnswer],
  },
  {
    name: 'edge: ambiguous single word',
    query: 'Northwestern',
    category: 'edge',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'edge: special chars + apostrophe',
    query: "what's the next bus to O'Hare?",
    category: 'edge',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'edge: unicode emoji in query',
    query: '🚆 next blue line please',
    category: 'edge',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'edge: very long query',
    query: 'how do I get from ' + 'Willis Tower and also stopping at Grant Park and Millennium Park '.repeat(8) + 'to Navy Pier',
    category: 'edge',
    expect: [nonEmptyAnswer],
  },
  {
    name: 'edge: favorites intent (anon)',
    query: 'show me my favorites',
    category: 'edge',
    // Anon user has no favorites; we just want a sane response.
    expect: [nonEmptyAnswer],
  },
  // ─────────────── Artifact-leak guards ───────────────
  {
    name: 'artifact guard: no (N chars) leaked',
    query: 'short directions from Clark/Lake to Fullerton',
    category: 'artifacts',
    expect: [
      nonEmptyAnswer,
      answerDoesNotMatch(/\(\d+\s*(chars?|characters?|words?)\)/i),
      answerDoesNotContain(['[Mock Search Result']),
    ],
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Runner
// ───────────────────────────────────────────────────────────────────────────
interface CaseResult {
  name: string;
  category: string;
  status: number | 'ERR';
  ms: number;
  pass: boolean;
  failures: string[];
  answerPreview: string;
  error?: string;
}

// The service falls back to this exact string when Gemini is slow/refusing.
// It's a valid user-facing response but won't satisfy content assertions.
// Treat seeing it + a failing assertion as a transient flake worth retrying.
const FALLBACK_STRING = "I couldn't generate directions right now. Try rephrasing, or check transitchicago.com.";

async function runOnce(c: Case): Promise<{ status: number | 'ERR'; data: any; ms: number; axErr?: AxiosError }> {
  const started = Date.now();
  const url = `${BASE_URL}/api/cta/transit/ask?query=${encodeURIComponent(c.query)}`;
  try {
    const resp = await axios.get(url, {
      timeout: TIMEOUT,
      validateStatus: () => true,
    });
    return { status: resp.status, data: resp.data, ms: Date.now() - started };
  } catch (err) {
    return { status: 'ERR', data: null, ms: Date.now() - started, axErr: err as AxiosError };
  }
}

async function runCase(c: Case): Promise<CaseResult> {
  const expectedStatus = c.status ?? 200;
  let attempt = await runOnce(c);
  let totalMs = attempt.ms;

  // One retry if the response was the fallback string AND at least one
  // content assertion depends on transit keywords. The retry also helps
  // when the request itself errored (ECONNABORTED etc.) — Gemini latency
  // variance is high enough that a single retry catches most flakes.
  const isFallback = typeof attempt.data?.answer === 'string' && attempt.data.answer === FALLBACK_STRING;
  const isNetworkError = attempt.status === 'ERR';
  if (isFallback || isNetworkError) {
    const second = await runOnce(c);
    if (!second.axErr && (second.status === expectedStatus)) {
      attempt = second;
    } else if (isNetworkError && !second.axErr) {
      attempt = second;
    }
    totalMs += second.ms;
  }

  const failures: string[] = [];
  if (attempt.status === 'ERR') {
    return {
      name: c.name,
      category: c.category,
      status: 'ERR',
      ms: totalMs,
      pass: false,
      failures: [`request error: ${attempt.axErr?.code || attempt.axErr?.message}`],
      answerPreview: '',
      error: attempt.axErr?.message,
    };
  }

  if (attempt.status !== expectedStatus) {
    failures.push(`status ${attempt.status} ≠ expected ${expectedStatus}`);
  }

  if (attempt.status === 200) {
    for (const check of c.expect) {
      const err = check(attempt.data);
      if (err) failures.push(err);
    }
  }

  const preview = (attempt.data?.answer || JSON.stringify(attempt.data) || '').toString();
  return {
    name: c.name,
    category: c.category,
    status: attempt.status,
    ms: totalMs,
    pass: failures.length === 0,
    failures,
    answerPreview: preview.substring(0, 140).replace(/\n/g, ' ⏎ '),
  };
}

async function runWithConcurrency<T, R>(items: T[], n: number, worker: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    })
  );
  return results;
}

async function main() {
  console.log(`\nChat harness — ${cases.length} cases against ${BASE_URL}\n`);

  // Sanity: is the server up?
  try {
    await axios.get(`${BASE_URL}/`, { timeout: 3000, validateStatus: () => true });
  } catch {
    console.error(`✗ Could not reach ${BASE_URL}. Start the dev server first (npm run dev).`);
    process.exit(2);
  }

  const started = Date.now();
  const results = await runWithConcurrency(cases, CONCURRENCY, runCase);
  const totalMs = Date.now() - started;

  // Per-case report
  for (const r of results) {
    const badge = r.pass ? 'PASS' : 'FAIL';
    const timing = `${r.ms.toString().padStart(5, ' ')}ms`;
    const status = typeof r.status === 'number' ? r.status.toString() : r.status;
    console.log(`[${badge}] ${timing}  ${status}  ${r.category.padEnd(11, ' ')}  ${r.name}`);
    if (!r.pass) {
      for (const f of r.failures) console.log(`         ↳ ${f}`);
    }
    if (r.answerPreview) console.log(`         · ${r.answerPreview}`);
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const byCat: Record<string, { passed: number; failed: number }> = {};
  for (const r of results) {
    byCat[r.category] ??= { passed: 0, failed: 0 };
    if (r.pass) byCat[r.category].passed++;
    else byCat[r.category].failed++;
  }

  console.log('\n────────────────────────────────────────');
  console.log(`Summary: ${passed}/${results.length} passed  (${failed} failed)  in ${(totalMs / 1000).toFixed(1)}s`);
  for (const [cat, v] of Object.entries(byCat)) {
    const mark = v.failed === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${cat.padEnd(11, ' ')} ${v.passed}/${v.passed + v.failed}`);
  }
  console.log('────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
