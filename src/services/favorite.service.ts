import prisma from '../utils/db';
import logger from '../utils/logger';
import { RouteType } from '@prisma/client';

interface CreateFavoriteData {
  userId: string;
  routeType: RouteType;
  routeId: string;
  stationId?: string;
  direction?: string;
  stopId?: string;
  name: string;
}

interface CreateScheduleData {
  userId: string;
  favoriteId: string;
  time: string;
  daysOfWeek: number[];
  enabled?: boolean;
}

export class FavoriteService {
  /**
   * Create a new favorite route
   */
  static async createFavorite(data: CreateFavoriteData) {
    try {
      const favorite = await prisma.favorite.create({
        data,
      });

      logger.info(`Favorite created for user ${data.userId}: ${data.name}`);
      return favorite;
    } catch (error) {
      logger.error('Error creating favorite:', error);
      throw error;
    }
  }

  /**
   * Get all favorites for a user
   */
  static async getUserFavorites(userId: string) {
    try {
      const favorites = await prisma.favorite.findMany({
        where: { userId },
        include: {
          schedules: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return favorites;
    } catch (error) {
      logger.error('Error fetching favorites:', error);
      throw error;
    }
  }

  /**
   * Get a single favorite by ID
   */
  static async getFavoriteById(favoriteId: string, userId: string) {
    try {
      const favorite = await prisma.favorite.findFirst({
        where: {
          id: favoriteId,
          userId,
        },
        include: {
          schedules: true,
        },
      });

      return favorite;
    } catch (error) {
      logger.error('Error fetching favorite:', error);
      throw error;
    }
  }

  /**
   * Update a favorite
   */
  static async updateFavorite(
    favoriteId: string,
    userId: string,
    data: Partial<CreateFavoriteData>
  ) {
    try {
      // Verify ownership
      const favorite = await this.getFavoriteById(favoriteId, userId);
      if (!favorite) {
        throw new Error('Favorite not found');
      }

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

  /**
   * Delete a favorite
   */
  static async deleteFavorite(favoriteId: string, userId: string) {
    try {
      // Verify ownership
      const favorite = await this.getFavoriteById(favoriteId, userId);
      if (!favorite) {
        throw new Error('Favorite not found');
      }

      await prisma.favorite.delete({
        where: { id: favoriteId },
      });

      logger.info(`Favorite deleted: ${favoriteId}`);
    } catch (error) {
      logger.error('Error deleting favorite:', error);
      throw error;
    }
  }

  /**
   * Create a schedule for a favorite
   */
  static async createSchedule(data: CreateScheduleData) {
    try {
      // Verify favorite belongs to user
      const favorite = await this.getFavoriteById(data.favoriteId, data.userId);
      if (!favorite) {
        throw new Error('Favorite not found');
      }

      const schedule = await prisma.schedule.create({
        data,
      });

      logger.info(`Schedule created for favorite ${data.favoriteId}`);
      return schedule;
    } catch (error) {
      logger.error('Error creating schedule:', error);
      throw error;
    }
  }

  /**
   * Get all schedules for a user
   */
  static async getUserSchedules(userId: string) {
    try {
      const schedules = await prisma.schedule.findMany({
        where: { userId },
        include: {
          favorite: true,
        },
        orderBy: {
          time: 'asc',
        },
      });

      return schedules;
    } catch (error) {
      logger.error('Error fetching schedules:', error);
      throw error;
    }
  }

  /**
   * Update a schedule
   */
  static async updateSchedule(
    scheduleId: string,
    userId: string,
    data: Partial<CreateScheduleData>
  ) {
    try {
      // Verify ownership
      const schedule = await prisma.schedule.findFirst({
        where: {
          id: scheduleId,
          userId,
        },
      });

      if (!schedule) {
        throw new Error('Schedule not found');
      }

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

  /**
   * Delete a schedule
   */
  static async deleteSchedule(scheduleId: string, userId: string) {
    try {
      // Verify ownership
      const schedule = await prisma.schedule.findFirst({
        where: {
          id: scheduleId,
          userId,
        },
      });

      if (!schedule) {
        throw new Error('Schedule not found');
      }

      await prisma.schedule.delete({
        where: { id: scheduleId },
      });

      logger.info(`Schedule deleted: ${scheduleId}`);
    } catch (error) {
      logger.error('Error deleting schedule:', error);
      throw error;
    }
  }

  /**
   * Get all active schedules that should run at a specific time
   */
  static async getSchedulesByTime(time: string, dayOfWeek: number) {
    try {
      const schedules = await prisma.schedule.findMany({
        where: {
          time,
          enabled: true,
        },
        include: {
          favorite: true,
          user: true,
        },
      });

      // Filter by day of week
      return schedules.filter((schedule) =>
        schedule.daysOfWeek.includes(dayOfWeek)
      );
    } catch (error) {
      logger.error('Error fetching schedules by time:', error);
      throw error;
    }
  }
}
