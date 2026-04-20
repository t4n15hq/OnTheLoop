import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';
import { CacheService } from './cache.service';

/**
 * CTA Customer Alerts API. No key required for the public feed.
 * Docs: https://www.transitchicago.com/developers/alerts/
 */
const CTA_ALERTS_URL =
  process.env.CTA_ALERTS_URL || 'http://www.transitchicago.com/api/1.0/alerts.aspx';

const CACHE_KEY = 'cta:alerts:v1';
const CACHE_TTL_SECONDS = 120; // Alerts don't change often — 2 minutes is plenty.
const STALE_KEY = 'cta:alerts:stale:v1';
const STALE_TTL_SECONDS = 60 * 60; // Fall back to last-good for up to an hour.

export interface AlertService {
  /** e.g. "Red", "Blue", "Brn", "G", "Org", "P", "Pink", "Y" for trains; "157", "22" for buses. */
  id: string;
  type: 'TRAIN' | 'BUS' | 'SYSTEM';
  name?: string;
}

export interface NormalizedAlert {
  id: string;
  headline: string;
  shortDescription: string;
  severityScore: number; // higher = worse
  severityColor?: string;
  majorAlert: boolean;
  eventStart?: string;
  eventEnd?: string;
  url?: string;
  services: AlertService[];
}

interface RawAlert {
  AlertId?: string;
  Headline?: string;
  ShortDescription?: string;
  SeverityScore?: string;
  SeverityColor?: string;
  MajorAlert?: string;
  EventStart?: string;
  EventEnd?: string;
  AlertURL?: string | { '#cdata-section'?: string };
  ImpactedService?: {
    Service?: RawService | RawService[];
  };
}

interface RawService {
  ServiceType?: string;
  ServiceTypeDescription?: string;
  ServiceName?: string;
  ServiceId?: string;
}

interface RawAlertsPayload {
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

function mapServiceType(raw: string | undefined): AlertService['type'] {
  if (!raw) return 'SYSTEM';
  const t = raw.toUpperCase();
  if (t === 'R' || t === 'RAIL' || t === 'TRAIN') return 'TRAIN';
  if (t === 'B' || t === 'BUS') return 'BUS';
  return 'SYSTEM';
}

function normalize(raw: RawAlert): NormalizedAlert {
  const services = coerceArray(raw.ImpactedService?.Service).map<AlertService>((s) => ({
    id: s.ServiceId || s.ServiceName || '',
    type: mapServiceType(s.ServiceType),
    name: s.ServiceName,
  }));

  return {
    id: raw.AlertId || '',
    headline: (raw.Headline || '').trim(),
    shortDescription: (raw.ShortDescription || '').trim(),
    severityScore: parseInt(raw.SeverityScore || '0', 10) || 0,
    severityColor: raw.SeverityColor || undefined,
    majorAlert: raw.MajorAlert === '1' || raw.MajorAlert === 'true',
    eventStart: raw.EventStart,
    eventEnd: raw.EventEnd,
    url: extractUrl(raw.AlertURL),
    services,
  };
}

async function fetchFresh(): Promise<NormalizedAlert[]> {
  const { data } = await axios.get<RawAlertsPayload>(CTA_ALERTS_URL, {
    params: { outputType: 'JSON' },
    timeout: 8_000,
  });

  const payload = data?.CTAAlerts;
  if (!payload) return [];
  if (payload.ErrorCode && payload.ErrorCode !== '0') {
    throw new Error(`CTA alerts error ${payload.ErrorCode}: ${payload.ErrorMessage ?? 'unknown'}`);
  }
  return coerceArray(payload.Alert).map(normalize);
}

export class AlertsService {
  /**
   * Returns currently-active CTA alerts, cached briefly. Falls back to last-good
   * if CTA is returning errors.
   */
  static async getAllActive(): Promise<NormalizedAlert[]> {
    const cached = await CacheService.get<NormalizedAlert[]>(CACHE_KEY);
    if (cached) return cached;

    try {
      const fresh = await fetchFresh();
      await CacheService.set(CACHE_KEY, fresh, CACHE_TTL_SECONDS);
      if (fresh.length > 0) {
        await CacheService.set(STALE_KEY, fresh, STALE_TTL_SECONDS);
      }
      return fresh;
    } catch (err) {
      const ax = err as AxiosError;
      logger.warn(`CTA alerts fetch failed (${ax.code || ax.message}); trying stale`);
      const stale = await CacheService.get<NormalizedAlert[]>(STALE_KEY);
      if (stale) return stale;
      // No cache and CTA is down — return empty rather than 500.
      return [];
    }
  }

  /**
   * Filter alerts to only those impacting any of the given routes.
   * Matches case-insensitively on service IDs/names. System-wide alerts (no
   * ImpactedService) are always included so users see major disruptions.
   */
  static async getForRoutes(routes: Array<{ routeId: string; routeType: 'TRAIN' | 'BUS' }>) {
    const all = await this.getAllActive();
    if (routes.length === 0) {
      // Without saved routes, only show major system-wide alerts.
      return all.filter((a) => a.majorAlert);
    }

    const wanted = new Set(
      routes.flatMap((r) => [
        r.routeId.toLowerCase(),
        normalizeTrainRouteId(r.routeId, r.routeType),
      ]).filter(Boolean)
    );

    return all.filter((alert) => {
      // System-wide: no ImpactedService. Only include major ones by default.
      if (alert.services.length === 0) return alert.majorAlert;
      return alert.services.some((s) => {
        const sid = (s.id || '').toLowerCase();
        const sname = (s.name || '').toLowerCase();
        return wanted.has(sid) || wanted.has(sname);
      });
    });
  }
}

/**
 * CTA is inconsistent about train route IDs. Saved favorites store "Red"/"Blue"
 * but alerts sometimes report "Red Line" or the short code "Red". Normalize so
 * the filter catches both.
 */
function normalizeTrainRouteId(routeId: string, routeType: 'TRAIN' | 'BUS'): string {
  if (routeType !== 'TRAIN') return routeId.toLowerCase();
  return `${routeId} line`.toLowerCase();
}
