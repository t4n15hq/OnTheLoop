import prisma from '../utils/db';
import redis from '../utils/redis';
import logger from '../utils/logger';
import { AccessibilityService, ElevatorOutage } from '../services/accessibility.service';
import { TelegramService, escapeHtml } from '../services/telegram.service';
import { isQuietNow } from '../utils/quiet-hours';
import { reportError } from '../utils/sentry';

// One push per (user, outage). Outages routinely last hours/days; a 12h window
// suppresses repeat pings for the same ongoing outage without silencing a genuine
// new one. Mirrors the "dedupe per (user, event)" treatment on the disruption path.
const DEDUP_TTL_SECONDS = 60 * 60 * 12;

function dedupKey(userId: string, outageId: string): string {
  return `accessibility:sent:${userId}:${outageId}`;
}

/**
 * Every id we treat as "this user's station": the train boarding station plus
 * the trip endpoints. CTA elevator outages are keyed by station id, so this set
 * is exactly what we test outages against.
 */
function stationIdsForUser(
  favorites: Array<{ stationId: string | null; boardingStopId: string | null; alightingStopId: string | null }>
): Set<string> {
  const ids = new Set<string>();
  for (const f of favorites) {
    for (const v of [f.stationId, f.boardingStopId, f.alightingStopId]) {
      if (v) ids.add(String(v).trim());
    }
  }
  return ids;
}

function formatOutage(outage: ElevatorOutage): string {
  const equip = outage.equipment === 'ESCALATOR' ? 'Escalator' : 'Elevator';
  const station = escapeHtml(outage.stationName || 'your saved station');
  const detail = escapeHtml(
    outage.shortDescription || outage.headline || `${equip} out of service`
  );
  const lines = [`🛗 <b>${equip} outage at ${station}</b>`, detail];
  if (outage.url) lines.push(outage.url);
  return lines.join('\n');
}

/** SET NX — true iff this is the first time we've seen (user, outage). */
async function claimPush(userId: string, outageId: string): Promise<boolean> {
  const res = await redis.set(dedupKey(userId, outageId), '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  return res === 'OK';
}

/** Release a claim so a failed delivery is retried on a later tick. */
async function releasePush(userId: string, outageId: string): Promise<void> {
  await redis.del(dedupKey(userId, outageId));
}

/**
 * Match active CTA elevator/escalator outages to opted-in users' saved stations
 * and push one Telegram alert per (user, outage). Opt-in only, quiet-hours aware,
 * deduped. Best-effort: swallows its own errors so a bad tick can't kill the
 * scheduler loop.
 */
export async function scanAccessibilityAlerts(now: Date = new Date()): Promise<void> {
  try {
    const outages = await AccessibilityService.getActiveOutages();
    if (outages.length === 0) return;

    if (!TelegramService.isConfigured()) {
      logger.debug('Accessibility scan: Telegram not configured; skipping');
      return;
    }

    // Opt-IN gate lives in the query: only users who enabled the toggle AND have
    // a linked Telegram chat are ever considered.
    const users = await prisma.user.findMany({
      where: { accessibilityAlerts: true, telegramChatId: { not: null } },
      include: { favorites: true },
    });

    for (const user of users) {
      if (!user.telegramChatId) continue;

      if (isQuietNow(user, now)) {
        logger.debug(`Accessibility scan: quiet hours for user ${user.id}; skipping`);
        continue;
      }

      const stationIds = stationIdsForUser(user.favorites);
      if (stationIds.size === 0) continue;

      const matched = outages.filter((o) => stationIds.has(o.stationId));
      for (const outage of matched) {
        const firstTime = await claimPush(user.id, outage.id);
        if (!firstTime) continue; // already alerted this user about this outage

        try {
          await TelegramService.sendMessage(user.telegramChatId, formatOutage(outage), {
            parseMode: 'HTML',
          });
          logger.info(`Accessibility alert sent to user ${user.id} for outage ${outage.id}`);
        } catch (err) {
          // Delivery failed — drop the claim so the next tick retries instead of
          // permanently swallowing the alert.
          await releasePush(user.id, outage.id).catch(() => {});
          logger.warn(`Accessibility alert delivery failed for user ${user.id}:`, err);
        }
      }
    }
  } catch (error) {
    reportError(error, { job: 'scan-accessibility-alerts' });
  }
}
