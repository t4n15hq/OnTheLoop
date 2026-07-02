import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';
import { CacheService } from './cache.service';
import { createCoalescer } from '../utils/coalesce';

/**
 * CTA elevator/escalator outage feed. This is part of the same public Customer
 * Alerts API family as {@link ./alerts.service} — accessibility outages are
 * published as alerts tagged with an elevator/escalator Impact. No key required.
 * Docs: https://www.transitchicago.com/developers/alerts/
 *
 * We give it the SAME treatment as the alerts feed: a short cache, in-flight
 * coalescing, and a longer last-good fallback, so a fleet of scheduler ticks
 * never hammers the upstream.
 */
const CTA_ELEVATOR_URL =
  process.env.CTA_ELEVATOR_URL || 'https://www.transitchicago.com/api/1.0/alerts.aspx';

const CACHE_KEY = 'cta:accessibility:v1';
const CACHE_TTL_SECONDS = 120; // Status doesn't change often — 2 minutes is plenty.
const STALE_KEY = 'cta:accessibility:stale:v1';
const STALE_TTL_SECONDS = 60 * 60; // Fall back to last-good for up to an hour.

export type EquipmentType = 'ELEVATOR' | 'ESCALATOR';

export interface ElevatorOutage {
  /** Stable per (outage, station) id — the unit we dedupe pushes on. */
  id: string;
  /** Underlying CTA AlertId for the outage. */
  alertId: string;
  /** CTA station/stop id — matches Favorite.stationId / boarding/alighting ids. */
  stationId: string;
  stationName: string;
  equipment: EquipmentType;
  headline: string;
  shortDescription: string;
  url?: string;
}

interface RawService {
  ServiceType?: string;
  ServiceName?: string;
  ServiceId?: string;
}

interface RawAlert {
  AlertId?: string;
  Headline?: string;
  ShortDescription?: string;
  Impact?: string;
  AlertURL?: string | { '#cdata-section'?: string };
  ImpactedService?: {
    Service?: RawService | RawService[];
  };
}

interface RawAccessibilityPayload {
  CTAAlerts?: {
    ErrorCode?: string;
    ErrorMessage?: string | null;
    Alert?: RawAlert | RawAlert[];
  };
}

function coerceArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function extractUrl(raw: RawAlert['AlertURL']): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw || undefined;
  if (typeof raw === 'object' && raw['#cdata-section']) return raw['#cdata-section'] || undefined;
  return undefined;
}

/** True when an alert is about an elevator/escalator (vs. a generic delay). */
function isAccessibilityAlert(raw: RawAlert): boolean {
  const hay = `${raw.Impact ?? ''} ${raw.Headline ?? ''} ${raw.ShortDescription ?? ''}`.toLowerCase();
  return hay.includes('elevator') || hay.includes('escalator');
}

function equipmentOf(raw: RawAlert): EquipmentType {
  const hay = `${raw.Impact ?? ''} ${raw.Headline ?? ''} ${raw.ShortDescription ?? ''}`.toLowerCase();
  return hay.includes('escalator') ? 'ESCALATOR' : 'ELEVATOR';
}

/**
 * One raw alert may impact several stations; we emit one ElevatorOutage per
 * impacted station so matching against a user's saved stations is a plain
 * set-membership test. Non-accessibility alerts and station-less alerts drop out.
 */
function toOutages(raw: RawAlert): ElevatorOutage[] {
  if (!isAccessibilityAlert(raw)) return [];

  const alertId = (raw.AlertId || '').trim();
  const equipment = equipmentOf(raw);
  const headline = (raw.Headline || '').trim();
  const shortDescription = (raw.ShortDescription || '').trim();
  const url = extractUrl(raw.AlertURL);

  return coerceArray(raw.ImpactedService?.Service)
    .map((s) => (s.ServiceId || '').trim())
    .filter(Boolean)
    .map((stationId) => {
      const service = coerceArray(raw.ImpactedService?.Service).find(
        (s) => (s.ServiceId || '').trim() === stationId
      );
      return {
        id: `${alertId}:${stationId}`,
        alertId,
        stationId,
        stationName: (service?.ServiceName || '').trim(),
        equipment,
        headline,
        shortDescription,
        url,
      } satisfies ElevatorOutage;
    });
}

const { withCoalescing } = createCoalescer<ElevatorOutage[]>();

async function fetchFresh(): Promise<ElevatorOutage[]> {
  const { data } = await axios.get<RawAccessibilityPayload>(CTA_ELEVATOR_URL, {
    params: { outputType: 'JSON', accessibility: 'true' },
    timeout: 8_000,
  });

  const payload = data?.CTAAlerts;
  if (!payload) return [];
  if (payload.ErrorCode && payload.ErrorCode !== '0') {
    throw new Error(
      `CTA accessibility error ${payload.ErrorCode}: ${payload.ErrorMessage ?? 'unknown'}`
    );
  }
  return coerceArray(payload.Alert).flatMap(toOutages);
}

export class AccessibilityService {
  /**
   * All currently-active elevator/escalator outages, cached briefly and
   * coalesced so concurrent callers share one upstream fetch. Falls back to
   * last-good if CTA is erroring; never throws to callers.
   */
  static async getActiveOutages(): Promise<ElevatorOutage[]> {
    const cached = await CacheService.get<ElevatorOutage[]>(CACHE_KEY);
    if (cached) return cached;

    return withCoalescing(CACHE_KEY, async () => {
      // Re-check the cache inside the coalescer — an earlier caller in this same
      // tick may have already populated it.
      const again = await CacheService.get<ElevatorOutage[]>(CACHE_KEY);
      if (again) return again;

      try {
        const fresh = await fetchFresh();
        await CacheService.set(CACHE_KEY, fresh, CACHE_TTL_SECONDS);
        if (fresh.length > 0) {
          await CacheService.set(STALE_KEY, fresh, STALE_TTL_SECONDS);
        }
        return fresh;
      } catch (err) {
        const ax = err as AxiosError;
        logger.warn(`CTA accessibility fetch failed (${ax.code || ax.message}); trying stale`);
        const stale = await CacheService.get<ElevatorOutage[]>(STALE_KEY);
        return stale ?? [];
      }
    });
  }

  /** Filter active outages down to those affecting any of the given station ids. */
  static async getForStations(stationIds: Iterable<string>): Promise<ElevatorOutage[]> {
    const wanted = new Set(
      Array.from(stationIds, (s) => (s || '').trim()).filter(Boolean)
    );
    if (wanted.size === 0) return [];
    const all = await this.getActiveOutages();
    return all.filter((o) => wanted.has(o.stationId));
  }
}
