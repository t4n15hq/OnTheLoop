import { Router } from 'express';
import {
  FavoriteController,
  createFavoriteValidation,
  createScheduleValidation,
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
router.put('/schedules/:id', createScheduleValidation, FavoriteController.updateSchedule);
router.delete('/schedules/:id', FavoriteController.deleteSchedule);

export default router;
