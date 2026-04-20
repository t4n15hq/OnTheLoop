import { Router } from 'express';
import {
  FavoriteController,
  createFavoriteValidation,
  createScheduleValidation,
  updateScheduleValidation,
} from '../controllers/favorite.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Favorites
router.post('/favorites', createFavoriteValidation, FavoriteController.createFavorite);
router.get('/favorites', FavoriteController.getFavorites);
router.get('/favorites/:id', FavoriteController.getFavorite);
router.put('/favorites/:id', createFavoriteValidation, FavoriteController.updateFavorite);
router.delete('/favorites/:id', FavoriteController.deleteFavorite);

// Schedules
router.post('/schedules', createScheduleValidation, FavoriteController.createSchedule);
router.get('/schedules', FavoriteController.getSchedules);
router.put('/schedules/:id', updateScheduleValidation, FavoriteController.updateSchedule);
router.delete('/schedules/:id', FavoriteController.deleteSchedule);
router.post('/schedules/:id/test', FavoriteController.testSchedule);

// Delivery history
router.get('/notifications/log', FavoriteController.getNotificationLog);

export default router;
