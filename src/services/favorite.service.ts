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
   * Return schedules whose effective fire time (target time minus leadMinutes,
   * interpreted in the configured schedule timezone) matches `now`, filtered
   * by day-of-week, and that haven't already fired inside this minute window.
   *
   * The scheduler calls this once per minute; `lastTriggeredAt` is stamped as
   * we enqueue so a re-entrant tick can't double-fire the same schedule.
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

      const minuteWindowStart = new Date(now);
      minuteWindowStart.setSeconds(0, 0);

      return schedules.filter((s) => {
        if (!s.daysOfWeek.includes(dayOfWeek)) return false;

        const mins = hhmmToMinutes(s.time);
        if (mins === null) return false;

        const effective = ((mins - (s.leadMinutes ?? 0)) % 1440 + 1440) % 1440;
        if (effective !== currentMinutes) return false;

        // Dedupe: skip if already enqueued inside this minute window.
        if (s.lastTriggeredAt && s.lastTriggeredAt >= minuteWindowStart) {
          return false;
        }

        return true;
      });
    } catch (error) {
      logger.error('Error fetching due schedules:', error);
      throw error;
    }
  }

  static async markScheduleTriggered(scheduleId: string, at: Date = new Date()) {
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { lastTriggeredAt: at },
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
