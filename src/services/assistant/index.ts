/**
 * Transit assistant: testable modules extracted from the old
 * `CTAController.getTransitSuggestion`.
 *
 *   intent   -> deterministic heuristics (address detection, route extraction)
 *   match    -> pure favorite matching
 *   enrich   -> live-arrivals fan-out (injectable providers)
 *   format   -> pure answer/DTO builders
 *   deps     -> injectable dependency surface
 *   assistant.service -> `answer()` orchestrator + `defaultDeps`
 */
export * from './types';
export * from './deps';
export * from './intent';
export * from './match';
export * from './format';
export * from './enrich';
export { answer, defaultDeps } from './assistant.service';
