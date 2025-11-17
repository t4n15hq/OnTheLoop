import { Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthRequest } from '../middleware/auth.middleware';
import { FavoriteService } from '../services/favorite.service';
import logger from '../utils/logger';
import { RouteType } from '@prisma/client';

export class FavoriteController {
  /**
   * Create a new favorite
   */
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

  /**
   * Get all user favorites
   */
  static async getFavorites(req: AuthRequest, res: Response): Promise<void> {
    try {
      const favorites = await FavoriteService.getUserFavorites(req.user!.userId);
      res.status(200).json({ favorites });
    } catch (error: any) {
      logger.error('Get favorites error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get a single favorite
   */
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

  /**
   * Update a favorite
   */
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

  /**
   * Delete a favorite
   */
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

  /**
   * Create a schedule for a favorite
   */
  static async createSchedule(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { favoriteId, time, daysOfWeek } = req.body;

      const schedule = await FavoriteService.createSchedule({
        userId: req.user!.userId,
        favoriteId,
        time,
        daysOfWeek,
      });

      res.status(201).json({ message: 'Schedule created', schedule });
    } catch (error: any) {
      logger.error('Create schedule error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * Get all user schedules
   */
  static async getSchedules(req: AuthRequest, res: Response): Promise<void> {
    try {
      const schedules = await FavoriteService.getUserSchedules(req.user!.userId);
      res.status(200).json({ schedules });
    } catch (error: any) {
      logger.error('Get schedules error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Update a schedule
   */
  static async updateSchedule(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { id } = req.params;
      const { time, daysOfWeek, enabled } = req.body;

      const schedule = await FavoriteService.updateSchedule(
        id,
        req.user!.userId,
        { time, daysOfWeek, enabled }
      );

      res.status(200).json({ message: 'Schedule updated', schedule });
    } catch (error: any) {
      logger.error('Update schedule error:', error);
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * Delete a schedule
   */
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
    .custom((value) => {
      return value.every((day: number) => day >= 0 && day <= 6);
    })
    .withMessage('Days must be between 0 (Sunday) and 6 (Saturday)'),
];
