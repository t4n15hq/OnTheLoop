/**
 * Assistant load-protection proof (issue #58).
 *
 * Fires a burst of concurrent queries through the real `assistant.answer`
 * pipeline with Gemini + CTA mocked, then reports how many Gemini calls actually
 * happened vs. the naive "one (or two) per request" baseline. The dramatic drop
 * is the acceptance proof for the fast-path + coalescing + cache work.
 *
 * Usage:
 *   npx tsx scripts/loadtest-assistant.ts
 *
 * Optional env:
 *   LOADTEST_QUERIES         total queries to fire (default 500)
 *   GEMINI_MOCK_LATENCY_MS   simulated Gemini latency; keeps the coalescing
 *                            window open under the synchronous burst (default 25)
 *   GEMINI_MAX_CONCURRENCY   process-wide Gemini cap (default 15)
 *
 * Redis is optional: if it's up, the query cache cuts calls further; if not,
 * fast-path + in-flight coalescing still do the heavy lifting.
 */

// Mocks must be set before importing the app modules (CTA_MOCK is read at load).
process.env.GEMINI_MOCK = '1';
process.env.CTA_MOCK = '1';
process.env.GEMINI_MOCK_LATENCY_MS = process.env.GEMINI_MOCK_LATENCY_MS || '25';

const TOTAL = parseInt(process.env.LOADTEST_QUERIES || '500', 10);

// ── Query mix ────────────────────────────────────────────────────────────────
// Deterministic patterns that MUST take the rule-based fast-path (0 Gemini).
const FAST_PATH_QUERIES = [
  'next 22',
  'next 60 bus',
  'next 8',
  '/next 20',
  'when is the 6',
  'blue line at Belmont',
  'red line at 95th',
  'brown at Belmont',
  'next Red at Fullerton',
];

// Open-ended NL that must go to Gemini. A handful of "hot" duplicates that will
// coalesce, plus a stream of novel queries that each cost a real call.
const HOT_DUPLICATE_QUERIES = [
  'from Northwestern to Willis Tower',
  'from Wrigley Field to the Art Institute',
  'from O\'Hare to downtown',
];

function novelQuery(i: number): string {
  return `from origin point ${i} to destination place ${i}`;
}

interface Plan {
  query: string;
  category: 'fast-path' | 'duplicate' | 'novel';
}

function buildPlan(total: number): Plan[] {
  const plan: Plan[] = [];
  // 60% fast-path, 25% hot duplicates, 15% novel.
  const nFast = Math.round(total * 0.6);
  const nDup = Math.round(total * 0.25);
  const nNovel = total - nFast - nDup;

  for (let i = 0; i < nFast; i++) {
    plan.push({ query: FAST_PATH_QUERIES[i % FAST_PATH_QUERIES.length], category: 'fast-path' });
  }
  for (let i = 0; i < nDup; i++) {
    plan.push({ query: HOT_DUPLICATE_QUERIES[i % HOT_DUPLICATE_QUERIES.length], category: 'duplicate' });
  }
  for (let i = 0; i < nNovel; i++) {
    plan.push({ query: novelQuery(i), category: 'novel' });
  }
  return plan;
}

async function main(): Promise<void> {
  const assistant = await import('../src/services/assistant');
  const { getGeminiInvocationCount, resetGeminiInvocationCount, GEMINI_MAX_CONCURRENCY } =
    await import('../src/services/gemini-guard');

  const plan = buildPlan(TOTAL);
  const fastCount = plan.filter((p) => p.category === 'fast-path').length;
  const dupCount = plan.filter((p) => p.category === 'duplicate').length;
  const novelCount = plan.filter((p) => p.category === 'novel').length;

  const geminiEligible = dupCount + novelCount;
  const uniqueEligible = new Set(
    plan.filter((p) => p.category !== 'fast-path').map((p) => p.query)
  ).size;

  resetGeminiInvocationCount();

  const startedAt = Date.now();
  const results = await Promise.allSettled(
    plan.map((p) => assistant.answer({ query: p.query }))
  );
  const elapsedMs = Date.now() - startedAt;

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  const actual = getGeminiInvocationCount();

  // Naive baseline: with no protection every Gemini-eligible query would fire an
  // intent parse AND a directions call (≈2 per request); fast-path queries would
  // still burn an intent parse each.
  const naive = geminiEligible * 2 + fastCount;

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Assistant load-protection results (GEMINI_MOCK=1, CTA_MOCK=1)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(` Total queries fired ............ ${TOTAL}`);
  console.log(`   • fast-path (0 Gemini) ....... ${fastCount}`);
  console.log(`   • hot duplicates ............. ${dupCount}`);
  console.log(`   • novel NL ................... ${novelCount}`);
  console.log(` Concurrency cap ................ ${GEMINI_MAX_CONCURRENCY}`);
  console.log(` Completed / failed ............. ${ok} / ${failed}`);
  console.log(` Wall time ...................... ${elapsedMs}ms`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` Gemini-eligible queries ........ ${geminiEligible}`);
  console.log(`   • unique among them .......... ${uniqueEligible}`);
  console.log(` Naive baseline (no protection) . ~${naive} Gemini calls`);
  console.log(` ACTUAL Gemini invocations ...... ${actual}`);
  const pct = naive > 0 ? Math.round((1 - actual / naive) * 100) : 0;
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` >>> ${TOTAL} queries → ${actual} Gemini calls  (${pct}% fewer than naive)`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  // Exit promptly — open Redis sockets would otherwise keep the process alive.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
