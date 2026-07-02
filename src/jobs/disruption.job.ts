import prisma from '../utils/db';
import logger from '../utils/logger';
import { AlertsService, NormalizedAlert } from '../services/alerts.service';
import { TelegramService, escapeHtml } from '../services/telegram.service';
import { currentLocalHHmm, isInQuietWindow } from '../utils/quiet-hours';
import { reportError } from '../utils/sentry';

type RouteType = 'TRAIN' | 'BUS';

/**
 * Phase 1 of issue #40: proactively push CTA disruptions on routes a user has
 * SAVED. We already detect alerts in {@link AlertsService}; this diffs them
 * against each user's favorites and pushes the material ones via Telegram, once
 * per (user, alert). The reroute suggestion (Phase 2) is intentionally out of
 * scope here.
 */

// Only push alerts that actually change someone's trip. CTA marks the worst
// ones as `majorAlert`; for the rest we keyword-match the headline/description
// so elevator-outage / minor-notice chatter doesn't spam saved-route users.
const MATERIAL_ALERT =
  /(delay|reroute|re-route|rerout|suspend|suspension|disrupt|not running|no service|shuttle|standby)/i;

export function isMaterialAlert(alert: NormalizedAlert): boolean {
  if (!alert.id) return false;
  if (alert.majorAlert) return true;
  return MATERIAL_ALERT.test(alert.headline) || MATERIAL_ALERT.test(alert.shortDescription);
}

function formatAlertMessage(alert: NormalizedAlert): string {
  const lines = [`🚨 <b>${escapeHtml(alert.headline || 'Service disruption')}</b>`];
  if (alert.shortDescription) lines.push(escapeHtml(alert.shortDescription));
  if (alert.url) lines.push(alert.url);
  return lines.join('\n');
}

/** Collapse a user's favorites into the distinct (routeId, routeType) pairs. */
function distinctRoutes(
  favorites: Array<{ routeId: string; routeType: RouteType }>
): Array<{ routeId: string; routeType: RouteType }> {
  const seen = new Set<string>();
  const out: Array<{ routeId: string; routeType: RouteType }> = [];
  for (const f of favorites) {
    const key = `${f.routeType}:${f.routeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ routeId: f.routeId, routeType: f.routeType });
  }
  return out;
}

/**
 * Diff current CTA alerts against every eligible user's saved routes and push
 * new material disruptions via Telegram. Safe to call repeatedly (e.g. every
 * few scheduler ticks): the `SentAlert` ledger dedupes so a given alert fires
 * at most once per user. Respects quiet hours and the per-user toggle, and only
 * considers SAVED routes.
 */
export async function pushDisruptionAlerts(now: Date = new Date()): Promise<void> {
  try {
    if (!TelegramService.isConfigured()) {
      logger.debug('Telegram not configured; skipping disruption push');
      return;
    }

    // The toggle (`disruptionAlerts: true`) and "saved routes only" rule are
    // enforced here in the query: users who opted out, aren't linked to
    // Telegram, or have no favorites never enter the loop.
    const users = await prisma.user.findMany({
      where: {
        disruptionAlerts: true,
        telegramChatId: { not: null },
        favorites: { some: {} },
      },
      include: { favorites: true },
    });

    if (users.length === 0) {
      logger.debug('No users eligible for disruption push');
      return;
    }

    const nowHHmm = currentLocalHHmm(now);

    for (const user of users) {
      try {
        // Quiet hours: same window semantics as scheduled pings.
        if (
          user.quietHoursStart &&
          user.quietHoursEnd &&
          isInQuietWindow(nowHHmm, user.quietHoursStart, user.quietHoursEnd)
        ) {
          logger.debug(`Disruption push suppressed (quiet hours) for user ${user.id}`);
          continue;
        }

        const routes = distinctRoutes(user.favorites);
        if (routes.length === 0) continue;

        const alerts = await AlertsService.getForRoutes(routes);
        const material = alerts.filter(isMaterialAlert);
        if (material.length === 0) continue;

        // Which of these have we already pushed to this user?
        const keys = material.map((a) => a.id);
        const already = await prisma.sentAlert.findMany({
          where: { userId: user.id, alertKey: { in: keys } },
          select: { alertKey: true },
        });
        const alreadySent = new Set(already.map((r) => r.alertKey));

        for (const alert of material) {
          if (alreadySent.has(alert.id)) continue;
          try {
            await TelegramService.sendMessage(
              user.telegramChatId!,
              formatAlertMessage(alert),
              { parseMode: 'HTML' }
            );
            // Record only after a successful send so a delivery failure retries
            // next tick instead of being silently marked as sent.
            await prisma.sentAlert.create({
              data: { userId: user.id, alertKey: alert.id },
            });
            logger.info(`Disruption alert ${alert.id} pushed to user ${user.id}`);
          } catch (err: unknown) {
            // Unique-constraint violation = another writer already recorded this
            // (user, alert); treat as already sent and move on.
            if ((err as { code?: string })?.code === 'P2002') continue;
            logger.warn(
              `Disruption push failed for user ${user.id}, alert ${alert.id}:`,
              err
            );
          }
        }
      } catch (err) {
        // One user's failure must not abort the sweep for everyone else.
        logger.error(`Disruption push failed for user ${user.id}:`, err);
      }
    }
  } catch (error) {
    reportError(error, { job: 'push-disruption-alerts' });
  }
}
