import { describe, it, expect } from 'vitest';
import { parseFastPath } from './fast-path';

describe('parseFastPath — bus routes', () => {
  it('parses a bare route number', () => {
    expect(parseFastPath('22')).toEqual({ kind: 'bus', routeNumber: '22' });
    expect(parseFastPath('157')).toEqual({ kind: 'bus', routeNumber: '157' });
  });

  it('parses common "next" / "when" phrasings', () => {
    expect(parseFastPath('next 22')).toEqual({ kind: 'bus', routeNumber: '22' });
    expect(parseFastPath("when's the next 22 bus")).toEqual({ kind: 'bus', routeNumber: '22' });
    expect(parseFastPath('next 60 bus')).toEqual({ kind: 'bus', routeNumber: '60' });
    expect(parseFastPath('when is the 8')).toEqual({ kind: 'bus', routeNumber: '8' });
  });

  it('strips a leading slash command', () => {
    expect(parseFastPath('/next 22')).toEqual({ kind: 'bus', routeNumber: '22' });
    expect(parseFastPath('/bus 66')).toEqual({ kind: 'bus', routeNumber: '66' });
  });

  it('defers (null) on ambiguity: multiple numbers, directions, extra words', () => {
    expect(parseFastPath('22 and 60')).toBeNull();
    expect(parseFastPath('next 22 to downtown')).toBeNull();
    expect(parseFastPath('is the 8 running late today')).toBeNull();
    expect(parseFastPath('how do I get to 22nd street')).toBeNull();
  });
});

describe('parseFastPath — train lines', () => {
  it('parses a line + station', () => {
    expect(parseFastPath("when's the blue line at Belmont")).toEqual({
      kind: 'train',
      line: 'Blue',
      code: 'Blue',
      station: 'belmont',
      direction: undefined,
    });
    expect(parseFastPath('brown at Belmont')).toEqual({
      kind: 'train',
      line: 'Brown',
      code: 'Brn',
      station: 'belmont',
      direction: undefined,
    });
  });

  it('captures a direction', () => {
    expect(parseFastPath('next red line northbound at 95th')).toEqual({
      kind: 'train',
      line: 'Red',
      code: 'Red',
      station: '95th',
      direction: 'northbound',
    });
  });

  it('parses a bare line (no station)', () => {
    expect(parseFastPath('next Red')).toEqual({
      kind: 'train',
      line: 'Red',
      code: 'Red',
      station: undefined,
      direction: undefined,
    });
    expect(parseFastPath('/next Red')).toMatchObject({ kind: 'train', code: 'Red' });
  });

  it('defers (null) when there is extra unrecognized text before the station', () => {
    expect(parseFastPath('cheapest red line trip')).toBeNull();
    expect(parseFastPath('red line from Belmont to Loop')).toBeNull();
  });
});

describe('parseFastPath — hard defers', () => {
  it('defers on directions / addresses / open-ended NL', () => {
    expect(parseFastPath('how do I get downtown')).toBeNull();
    expect(parseFastPath('1029 S Lytle to 820 S Wolcott')).toBeNull();
    expect(parseFastPath('find stops near me')).toBeNull();
    expect(parseFastPath('show my favorites')).toBeNull();
    expect(parseFastPath('')).toBeNull();
  });
});
