import prisma from '../utils/db';
import logger from '../utils/logger';
import { Channel, RouteType } from '@prisma/client';
import config from '../config';

interface CreateFavoriteData {
  userId: string;
  routeType: RouteType;
  routeId: string;
  stationId?: string;
  direction?: string;
  stopId?: string;
  boardingStopId?: string;
  boardingStopName?: string;
  alightingStopId?: string;
  alightingStopName?: string;
  name: string;
}

interface CreateScheduleData {
  userId: string;
  favoriteId: string;
  time: string;
  daysOfWeek: number[];
  enabled?: boolean;
  leadMinutes?: number;
  channel?: Channel;
}

interface UpdateScheduleData {
  time?: string;
  daysOfWeek?: number[];
  enabled?: boolean;
  leadMinutes?: number;
  channel?: Channel;
}

export class FavoriteService {
  static async createFavorite(data: CreateFavoriteData) {
    try {
      const favorite = await prisma.favorite.create({ data });
      logger.info(`Favorite created for user ${data.userId}: ${data.name}`);
      return favorite;
    } catch (error) {
      logger.error('Error creating favorite:', error);
      throw error;
    }
  }

  static async getUserFavorites(userId: string) {
    try {
      return await prisma.favorite.findMany({
        where: { userId },
        include: { schedules: true },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      logger.error('Error fetching favorites:', error);
      throw error;
    }
  }

  static async getFavoriteById(favoriteId: string, userId: string) {
    try {
      return await prisma.favorite.findFirst({
        where: { id: favoriteId, userId },
        include: { schedules: true },
      });
    } catch (error) {
      logger.error('Error fetching favorite:', error);
      throw error;
    }
  }

  static async updateFavorite(
    favoriteId: string,
    userId: string,
    data: Partial<CreateFavoriteData>
  ) {
    try {
      const favorite = await this.getFavoriteById(favoriteId, userId);
      if (!favorite) throw new Error('Favorite not found');

      const updated = await prisma.favorite.update({
        where: { id: favoriteId },
        data,
      });
      logger.info(`Favorite updated: ${favoriteId}`);
      return updated;
    } catch (error) {
      logger.error('Error updating favorite:', error);
      throw error;
    }
  }

  static async deleteFavorite(favoriteId: string, userId: string) {
    try {
      const favorite = await this.getFavoriteById(favoriteId, userId);
      if (!favorite) throw new Error('Favorite not found');

      await prisma.favorite.delete({ where: { id: favoriteId } });
      logger.info(`Favorite deleted: ${favoriteId}`);
    } catch (error) {
      logger.error('Error deleting favorite:', error);
      throw error;
    }
  }

  static async createSchedule(data: CreateScheduleData) {
    try {
      const favorite = await this.getFavoriteById(data.favoriteId, data.userId);
      if (!favorite) throw new Error('Favorite not found');

      const schedule = await prisma.schedule.create({ data });
      logger.info(`Schedule created for favorite ${data.favoriteId}`);
      return schedule;
    } catch (error) {
      logger.error('Error creating schedule:', error);
      throw error;
    }
  }

  static async getUserSchedules(userId: string) {
    try {
      return await prisma.schedule.findMany({
        where: { userId },
        include: { favorite: true },
        orderBy: { time: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching schedules:', error);
      throw error;
    }
  }

  static async getScheduleById(scheduleId: string, userId: string) {
    try {
      return await prisma.schedule.findFirst({
        where: { id: scheduleId, userId },
        include: { favorite: true },
      });
    } catch (error) {
      logger.error('Error fetching schedule:', error);
      throw error;
    }
  }

  static async updateSchedule(
    scheduleId: string,
    userId: string,
    data: UpdateScheduleData
  ) {
    try {
      const schedule = await prisma.schedule.findFirst({
        where: { id: scheduleId, userId },
      });
      if (!schedule) throw new Error('Schedule not found');

      const updated = await prisma.schedule.update({
        where: { id: scheduleId },
        data,
      });
      logger.info(`Schedule updated: ${scheduleId}`);
      return updated;
    } catch (error) {
      logger.error('Error updating schedule:', error);
      throw error;
    }
  }

  static async deleteSchedule(scheduleId: string, userId: string) {
    try {
      const schedule = await prisma.schedule.findFirst({
        where: { id: scheduleId, userId },
      });
      if (!schedule) throw new Error('Schedule not found');

      await prisma.schedule.delete({ where: { id: scheduleId } });
      logger.info(`Schedule deleted: ${scheduleId}`);
    } catch (error) {
      logger.error('Error deleting schedule:', error);
      throw error;
    }
  }

  /**
   * Return the schedules whose effective fire time (target time minus
   * leadMinutes, interpreted in the configured schedule timezone) matches
   * `now`, filtered by day-of-week.
   *
   * These are *candidates*: dedupe is NOT done here. The caller must atomically
   * claim each one via {@link claimSchedule} before enqueuing, so concurrent
   * ticks / multiple replicas can't double-fire. Each returned row still
   * carries `lastTriggeredAt` so the caller can roll a claim back on failure.
   */
  static async getDueSchedules(now: Date = new Date()) {
    try {
      const { hour, minute, dayOfWeek } = partsInZone(now, config.scheduleTimezone);
      const currentMinutes = hour * 60 + minute;

      // Fetch only schedules plausibly due. Effective fire minute ==
      // (HHmmToMinutes(time) - leadMinutes + 1440) % 1440 === currentMinutes.
      // SQL can't easily express that, so we filter in JS — N is small.
      const schedules = await prisma.schedule.findMany({
        where: { enabled: true },
        include: { favorite: true, user: true },
      });

      return schedules.filter((s) => {
        if (!s.daysOfWeek.includes(dayOfWeek)) return false;

        const mins = hhmmToMinutes(s.time);
        if (mins === null) return false;

        const effective = ((mins - (s.leadMinutes ?? 0)) % 1440 + 1440) % 1440;
        return effective === currentMinutes;
      });
    } catch (error) {
      logger.error('Error fetching due schedules:', error);
      throw error;
    }
  }

  /**
   * Atomically claim a schedule for the given minute window using a
   * compare-and-swap on `lastTriggeredAt`. Returns `true` iff THIS caller won
   * the race (exactly one row updated). Concurrent replicas / re-entrant ticks
   * that lose the race get `false` and must not enqueue.
   *
   * The `updateMany` predicate is the CAS: it only flips `lastTriggeredAt` when
   * the schedule has never fired (`null`) or last fired before this window
   * (`< windowStart`), so at most one caller per window can succeed.
   */
  static async claimSchedule(
    scheduleId: string,
    windowStart: Date,
    now: Date = new Date()
  ): Promise<boolean> {
    const claimed = await prisma.schedule.updateMany({
      where: {
        id: scheduleId,
        OR: [{ lastTriggeredAt: null }, { lastTriggeredAt: { lt: windowStart } }],
      },
      data: { lastTriggeredAt: now },
    });
    return claimed.count === 1;
  }

  /**
   * Undo a claim after the enqueue that should have followed it failed,
   * restoring the previous `lastTriggeredAt` so the next tick re-claims and the
   * notification is not silently dropped (see #12). Best-effort: even if this
   * throws, the short claim window means the schedule fires again next tick.
   */
  static async releaseSchedule(scheduleId: string, previous: Date | null) {
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { lastTriggeredAt: previous },
    });
  }
}

function hhmmToMinutes(time: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Extract hour/minute/dayOfWeek for a date, as observed in the given IANA zone.
 * Uses Intl.DateTimeFormat (built into Node) so it doesn't depend on the host TZ.
 */
function partsInZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const hour = parseInt(get('hour'), 10) % 24; // "24" → 0 on some locales
  const minute = parseInt(get('minute'), 10);
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));

  return { hour, minute, dayOfWeek };
}
