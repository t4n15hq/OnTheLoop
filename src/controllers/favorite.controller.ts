import { Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthRequest } from '../middleware/auth.middleware';
import { FavoriteService } from '../services/favorite.service';
import logger from '../utils/logger';
import prisma from '../utils/db';
import { Channel, RouteType } from '@prisma/client';
import { enqueueTestNotification } from '../jobs/notification.job';

export class FavoriteController {
  static async createFavorite(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const {
        routeType,
        routeId,
        stationId,
        direction,
        stopId,
        boardingStopId,
        boardingStopName,
        alightingStopId,
        alightingStopName,
        name
      } = req.body;

      const favorite = await FavoriteService.createFavorite({
        userId: req.user!.userId,
        routeType,
        routeId,
        stationId,
        direction,
        stopId,
        boardingStopId,
        boardingStopName,
        alightingStopId,
        alightingStopName,
        name,
      });

      res.status(201).json({ message: 'Favorite created', favorite });
    } catch (error: any) {
      logger.error('Create favorite error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  static async getFavorites(req: AuthRequest, res: Response): Promise<void> {
    try {
      const favorites = await FavoriteService.getUserFavorites(req.user!.userId);
      res.status(200).json({ favorites });
    } catch (error: any) {
      logger.error('Get favorites error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  static async getFavorite(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const favorite = await FavoriteService.getFavoriteById(id, req.user!.userId);

      if (!favorite) {
        res.status(404).json({ error: 'Favorite not found' });
        return;
      }

      res.status(200).json({ favorite });
    } catch (error: any) {
      logger.error('Get favorite error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  static async updateFavorite(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { id } = req.params;
      const {
        routeType,
        routeId,
        stationId,
        direction,
        stopId,
        boardingStopId,
        boardingStopName,
        alightingStopId,
        alightingStopName,
        name
      } = req.body;

      const favorite = await FavoriteService.updateFavorite(
        id,
        req.user!.userId,
        {
          routeType,
          routeId,
          stationId,
          direction,
          stopId,
          boardingStopId,
          boardingStopName,
          alightingStopId,
          alightingStopName,
          name
        }
      );

      res.status(200).json({ message: 'Favorite updated', favorite });
    } catch (error: any) {
      logger.error('Update favorite error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  static async deleteFavorite(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      await FavoriteService.deleteFavorite(id, req.user!.userId);
      res.status(200).json({ message: 'Favorite deleted' });
    } catch (error: any) {
      logger.error('Delete favorite error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  static async createSchedule(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { favoriteId, time, daysOfWeek, leadMinutes, channel } = req.body;
      const userId = req.user!.userId;

      const schedule = await FavoriteService.createSchedule({
        userId,
        favoriteId,
        time,
        daysOfWeek,
        leadMinutes: typeof leadMinutes === 'number' ? leadMinutes : 0,
        channel: channel as Channel | undefined,
      });

      // If the user has no Telegram link, auto-enable email so this schedule
      // actually has a delivery channel. We only flip it ON (never off), and
      // we only do it when the user didn't pick an explicit channel themselves.
      let emailAutoEnabled = false;
      if (!channel || channel === Channel.AUTO) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user && !user.telegramChatId && !user.emailNotifications) {
          await prisma.user.update({
            where: { id: userId },
            data: { emailNotifications: true },
          });
          emailAutoEnabled = true;
          logger.info(`Auto-enabled email notifications for user ${userId} on first schedule`);
        }
      }

      res.status(201).json({ message: 'Schedule created', schedule, emailAutoEnabled });
    } catch (error: any) {
      logger.error('Create schedule error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  static async getSchedules(req: AuthRequest, res: Response): Promise<void> {
    try {
      const schedules = await FavoriteService.getUserSchedules(req.user!.userId);
      res.status(200).json({ schedules });
    } catch (error: any) {
      logger.error('Get schedules error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  static async updateSchedule(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { id } = req.params;
      const { time, daysOfWeek, enabled, leadMinutes, channel } = req.body;

      const schedule = await FavoriteService.updateSchedule(id, req.user!.userId, {
        time,
        daysOfWeek,
        enabled,
        leadMinutes,
        channel: channel as Channel | undefined,
      });

      res.status(200).json({ message: 'Schedule updated', schedule });
    } catch (error: any) {
      logger.error('Update schedule error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  static async deleteSchedule(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      await FavoriteService.deleteSchedule(id, req.user!.userId);
      res.status(200).json({ message: 'Schedule deleted' });
    } catch (error: any) {
      logger.error('Delete schedule error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  /** Fire a one-off delivery for this schedule right now, for testing. */
  static async testSchedule(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user!.userId;

      const schedule = await FavoriteService.getScheduleById(id, userId);
      if (!schedule) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }

      await enqueueTestNotification({
        id: schedule.id,
        userId: schedule.userId,
        favoriteId: schedule.favoriteId,
      });

      res.status(202).json({
        message: 'Test notification queued — check your inbox / Telegram in a few seconds.',
      });
    } catch (error: any) {
      logger.error('Test schedule error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /** Return recent delivery attempts for this user. */
  static async getNotificationLog(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const take = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);

      const logs = await prisma.notificationLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          schedule: {
            include: { favorite: true },
          },
        },
      });

      res.status(200).json({ logs });
    } catch (error: any) {
      logger.error('Get notification log error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

// Validation middleware
export const createFavoriteValidation = [
  body('routeType').isIn(['TRAIN', 'BUS']).withMessage('Invalid route type'),
  body('routeId').notEmpty().withMessage('Route ID is required'),
  body('name').notEmpty().withMessage('Name is required'),
];

export const createScheduleValidation = [
  body('favoriteId').notEmpty().withMessage('Favorite ID is required'),
  body('time')
    .matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .withMessage('Invalid time format (use HH:mm)'),
  body('daysOfWeek')
    .isArray()
    .withMessage('Days of week must be an array')
    .custom((value) => value.every((day: number) => day >= 0 && day <= 6))
    .withMessage('Days must be between 0 (Sunday) and 6 (Saturday)'),
  body('leadMinutes')
    .optional()
    .isInt({ min: 0, max: 180 })
    .withMessage('leadMinutes must be between 0 and 180'),
  body('channel')
    .optional()
    .isIn(['AUTO', 'EMAIL', 'TELEGRAM', 'BOTH'])
    .withMessage('Invalid channel'),
];

// Separate validator for PATCH/PUT so partial updates (e.g. toggling `enabled`)
// don't require the full schedule body. This was the original toggle bug.
export const updateScheduleValidation = [
  body('time')
    .optional()
    .matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .withMessage('Invalid time format (use HH:mm)'),
  body('daysOfWeek')
    .optional()
    .isArray()
    .withMessage('Days of week must be an array')
    .custom((value) => value.every((day: number) => day >= 0 && day <= 6))
    .withMessage('Days must be between 0 (Sunday) and 6 (Saturday)'),
  body('enabled').optional().isBoolean().withMessage('enabled must be boolean'),
  body('leadMinutes')
    .optional()
    .isInt({ min: 0, max: 180 })
    .withMessage('leadMinutes must be between 0 and 180'),
  body('channel')
    .optional()
    .isIn(['AUTO', 'EMAIL', 'TELEGRAM', 'BOTH'])
    .withMessage('Invalid channel'),
];
