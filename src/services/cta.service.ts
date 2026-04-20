import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import config from '../config';
import logger from '../utils/logger';
import {
  CTATrainResponse,
  CTABusResponse,
  FormattedArrival,
} from '../types/cta.types';
import { CacheService } from './cache.service';

const CTA_TRAIN_API_BASE = 'http://lapi.transitchicago.com/api/1.0';
const CTA_BUS_API_BASE = 'http://www.ctabustracker.com/bustime/api/v2';

// Stale-while-error: keep the last good response around for up to 10 min so we
// can serve something if CTA returns a 500 or times out on the next call.
const STALE_FALLBACK_TTL_SECONDS = 600;

// ────────────────────────────────────────────────────────────────────────────
// HTTP with single retry on transient failures (timeouts + 5xx).
// ────────────────────────────────────────────────────────────────────────────
async function httpGet<T>(url: string, params: Record<string, unknown>, timeoutMs = 5_000): Promise<T> {
  const cfg: AxiosRequestConfig = { params, timeout: timeoutMs };

  try {
    const { data } = await axios.get<T>(url, cfg);
    return data;
  } catch (err) {
    const ax = err as AxiosError;
    const transient =
      ax.code === 'ECONNABORTED' ||
      ax.code === 'ECONNRESET' ||
      ax.code === 'ETIMEDOUT' ||
      (ax.response?.status !== undefined && ax.response.status >= 500);

    if (!transient) throw err;

    logger.warn(`CTA request transient failure (${ax.code || ax.response?.status}), retrying: ${url}`);
    await new Promise((r) => setTimeout(r, 400));
    const { data } = await axios.get<T>(url, cfg);
    return data;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Timestamp parsing. Both endpoints return wall-clock Chicago time with no TZ.
// TZ=America/Chicago is set in the Dockerfile and in prod. In other envs this
// still resolves to the host's local clock, which matches a Chicago developer.
// ────────────────────────────────────────────────────────────────────────────
function parseTrainTime(s: string): Date {
  // "2026-04-20T14:02:02" — ISO-ish, no TZ → parsed as local.
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(NaN) : d;
}

function parseBusTime(s: string): Date {
  // "20260420 14:11" → "2026-04-20T14:11:00"
  const m = s.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return new Date(NaN);
  const [, y, mo, d, hh, mm] = m;
  return new Date(`${y}-${mo}-${d}T${hh}:${mm}:00`);
}

function minutesFromNow(arrival: Date, now: Date = new Date()): number {
  if (isNaN(arrival.getTime())) return 0;
  const diff = Math.round((arrival.getTime() - now.getTime()) / 60_000);
  return Math.max(0, diff);
}

/**
 * Adaptive cache TTL. Short TTLs keep imminent arrivals accurate; long TTLs
 * avoid hammering CTA when there's nothing to report.
 */
function adaptiveTtl(arrivals: FormattedArrival[]): number {
  if (arrivals.length === 0) return 90;
  const soonest = arrivals[0].minutesAway;
  if (soonest <= 1) return 8;
  if (soonest <= 5) return 15;
  return 25;
}

function sortAndTrim(arrivals: FormattedArrival[], limit?: number): FormattedArrival[] {
  const sorted = [...arrivals].sort((a, b) => a.minutesAway - b.minutesAway);
  return limit ? sorted.slice(0, limit) : sorted;
}

async function readStale(cacheKey: string): Promise<FormattedArrival[] | null> {
  const stale = await CacheService.get<FormattedArrival[]>(`stale:${cacheKey}`);
  if (!stale) return null;
  // Re-compute minutesAway from the frozen arrivalTime so the numbers aren't
  // totally wrong. Flag as stale so callers can warn the user.
  const now = new Date();
  return stale.map((a) => ({
    ...a,
    arrivalTime: new Date(a.arrivalTime),
    minutesAway: minutesFromNow(new Date(a.arrivalTime), now),
    isStale: true,
  }));
}

async function writeCache(cacheKey: string, arrivals: FormattedArrival[]): Promise<void> {
  await CacheService.set(cacheKey, arrivals, adaptiveTtl(arrivals));
  if (arrivals.length > 0) {
    await CacheService.set(`stale:${cacheKey}`, arrivals, STALE_FALLBACK_TTL_SECONDS);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Train direction codes are line-specific. For routes that run north/south
// CTA uses 1=N, 5=S. For east/west lines CTA uses 1=E, 5=W. So mapping a
// user-entered "Westbound" → "5" is correct for Green/Pink, and "Northbound"
// → "1" is correct for Red/Blue/Brown/Purple/Yellow. The ambiguous case is
// Orange (loop) — there's no clean E/W/N/S for it, so we just pass through.
// ────────────────────────────────────────────────────────────────────────────
function mapDirectionToTrainCode(direction: string): '1' | '5' | null {
  const d = direction.toLowerCase();
  if (/north|east|inbound/.test(d)) return '1';
  if (/south|west|outbound/.test(d)) return '5';
  return null;
}

export class CTAService {
  /**
   * Get train arrivals for a specific station.
   */
  static async getTrainArrivals(
    stationId: string,
    routeCode?: string,
    direction?: string
  ): Promise<FormattedArrival[]> {
    const cacheKey = CacheService.generateKey(
      'train-arrivals',
      stationId,
      routeCode || 'all',
      direction || 'all'
    );

    const cached = await CacheService.get<FormattedArrival[]>(cacheKey);
    if (cached) {
      logger.debug(`Train arrivals cache hit for ${stationId}`);
      return cached.map((a) => ({ ...a, arrivalTime: new Date(a.arrivalTime) }));
    }

    const params: Record<string, unknown> = {
      key: config.cta.trainApiKey,
      mapid: stationId,
      outputType: 'JSON',
    };
    if (routeCode) params.rt = routeCode;

    let data: CTATrainResponse;
    try {
      data = await httpGet<CTATrainResponse>(
        `${CTA_TRAIN_API_BASE}/ttarrivals.aspx`,
        params
      );
    } catch (err) {
      logger.warn(`CTA train request failed for ${stationId}; trying stale cache`, err);
      const stale = await readStale(cacheKey);
      if (stale) return stale;
      throw err;
    }

    const { errCd, errNm, eta } = data.ctatt;

    // errCd '0' = OK. '100' = no arrival data (valid empty state, not an error).
    if (errCd !== '0' && errCd !== '100') {
      logger.error(`CTA Train API error (errCd=${errCd}): ${errNm}`);
      const stale = await readStale(cacheKey);
      if (stale) return stale;
      throw new Error(errNm || `CTA error ${errCd}`);
    }

    let raw = eta || [];

    if (direction) {
      const code = mapDirectionToTrainCode(direction);
      if (code) raw = raw.filter((a) => String(a.trDr) === code);
    }

    const now = new Date();
    const arrivals: FormattedArrival[] = raw.map((a) => {
      const arrivalTime = parseTrainTime(a.arrT);
      const isSch = a.isSch === '1';
      return {
        routeName: `${a.rt} Line`,
        destination: a.destNm,
        arrivalTime,
        minutesAway: minutesFromNow(arrivalTime, now),
        isApproaching: a.isApp === '1',
        isDelayed: a.isDly === '1',
        isScheduled: isSch,
        confidence: isSch ? 'scheduled' : 'live',
      };
    });

    const result = sortAndTrim(arrivals);
    await writeCache(cacheKey, result);
    return result;
  }

  /**
   * Get bus predictions for a specific stop.
   */
  static async getBusPredictions(
    stopId: string,
    routeId?: string,
    limit: number = 3,
    direction?: string
  ): Promise<FormattedArrival[]> {
    const cacheKey = CacheService.generateKey(
      'bus',
      stopId,
      routeId || 'all',
      direction || 'all',
      limit.toString()
    );

    const cached = await CacheService.get<FormattedArrival[]>(cacheKey);
    if (cached) {
      logger.debug(`Bus predictions cache hit for ${stopId}`);
      return cached.map((a) => ({ ...a, arrivalTime: new Date(a.arrivalTime) }));
    }

    const params: Record<string, unknown> = {
      key: config.cta.busApiKey,
      stpid: stopId,
      format: 'json',
    };
    if (routeId) params.rt = routeId;

    let data: CTABusResponse;
    try {
      data = await httpGet<CTABusResponse>(
        `${CTA_BUS_API_BASE}/getpredictions`,
        params
      );
    } catch (err) {
      logger.warn(`CTA bus request failed for ${stopId}; trying stale cache`, err);
      const stale = await readStale(cacheKey);
      if (stale) return stale;
      throw err;
    }

    const body = data['bustime-response'];

    // CTA returns `error[{ msg: "No arrival times" }]` in two cases:
    //   1. stop is temporarily empty (valid, should return [] not throw)
    //   2. stop/route is bad (we can't tell from the message text alone, so
    //      we treat all messages as empty results — if the stop is truly
    //      broken it'll keep returning empty, which is the right UX anyway).
    if (body.error && !body.prd) {
      const result: FormattedArrival[] = [];
      await writeCache(cacheKey, result);
      return result;
    }

    let raw = body.prd || [];

    if (direction) {
      const d = direction.toLowerCase();
      raw = raw.filter((p) => p.rtdir && p.rtdir.toLowerCase().includes(d));
    }

    const now = new Date();
    const arrivals: FormattedArrival[] = raw.map((p) => {
      const arrivalTime = parseBusTime(p.prdtm);
      const isDue = p.prdctdn.toUpperCase() === 'DUE';
      const minsFromCountdown = isDue ? 0 : parseInt(p.prdctdn, 10);
      const minutesAway = Number.isFinite(minsFromCountdown)
        ? Math.max(0, minsFromCountdown)
        : minutesFromNow(arrivalTime, now);

      return {
        routeName: `Route ${p.rt}`,
        destination: p.des,
        arrivalTime,
        minutesAway,
        isApproaching: isDue || minutesAway <= 1,
        isDelayed: p.dly === true,
        isDue,
        confidence: 'live',
      };
    });

    const result = sortAndTrim(arrivals, limit);
    await writeCache(cacheKey, result);
    return result;
  }

  /**
   * Human-readable arrival block, used by Telegram + the email fallback path.
   * Keeps plain text so Telegram doesn't need Markdown escaping.
   */
  static formatArrivalsForSMS(arrivals: FormattedArrival[], title: string): string {
    if (arrivals.length === 0) {
      return `${title}\n\nNo arrivals right now.`;
    }

    const anyStale = arrivals.some((a) => a.isStale);
    const lines: string[] = [title, ''];

    arrivals.forEach((a, i) => {
      const timeLabel = a.isDue
        ? 'DUE'
        : a.isApproaching
        ? 'arriving now'
        : a.minutesAway === 0
        ? 'arriving now'
        : a.minutesAway === 1
        ? '1 min'
        : `${a.minutesAway} min`;

      const flags: string[] = [];
      if (a.isDelayed) flags.push('delayed');
      if (a.confidence === 'scheduled') flags.push('scheduled');

      const tail = flags.length ? ` (${flags.join(', ')})` : '';
      lines.push(`${i + 1}. ${a.destination} — ${timeLabel}${tail}`);
    });

    if (anyStale) {
      lines.push('');
      lines.push('⚠ CTA API is slow — showing last-known data.');
    }

    return lines.join('\n');
  }
}
