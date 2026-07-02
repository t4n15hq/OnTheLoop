import { describe, it, expect } from 'vitest';
import { looksLikeAddress, extractRoutesFromDirections } from './intent';

describe('looksLikeAddress', () => {
  it('detects a street number + directional', () => {
    expect(looksLikeAddress('1029 S Lytle to 820 S Wolcott')).toBe(true);
    expect(looksLikeAddress('820 S Wolcott')).toBe(true);
  });

  it('detects a street-type word', () => {
    expect(looksLikeAddress('123 Main Street')).toBe(true);
    expect(looksLikeAddress('meet me on Lake Ave')).toBe(true);
  });

  it('does not flag landmarks or line names', () => {
    expect(looksLikeAddress('Willis Tower')).toBe(false);
    expect(looksLikeAddress('Red Line from Howard to Loop')).toBe(false);
    expect(looksLikeAddress('when is my Home bus')).toBe(false);
  });
});

describe('extractRoutesFromDirections', () => {
  it('extracts bus routes and train lines from directions text', () => {
    const { busRoutes, trainLines } = extractRoutesFromDirections(
      'Take **Route 22** north, then transfer to the Red Line.',
      'how do I get downtown'
    );
    expect(busRoutes).toContain('22');
    expect(trainLines).toEqual(['Red']);
  });

  it('handles "bus" and "#" prefixes and de-duplicates', () => {
    const { busRoutes } = extractRoutesFromDirections(
      'Board bus 157, ride Route 157, then transfer to #66.',
      'x'
    );
    expect(busRoutes).toEqual(['157', '66']);
  });

  it('falls back to a bare route number in the query when text has none', () => {
    const { busRoutes, trainLines } = extractRoutesFromDirections('', '60');
    expect(busRoutes).toEqual(['60']);
    expect(trainLines).toEqual([]);
  });

  it('returns empty arrays for malformed / route-free input (no throw)', () => {
    const { busRoutes, trainLines } = extractRoutesFromDirections(
      '{ this is not json and mentions no routes }',
      'downtown please'
    );
    expect(busRoutes).toEqual([]);
    expect(trainLines).toEqual([]);
  });
});
