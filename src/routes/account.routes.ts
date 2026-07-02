import { Router } from 'express';
import { AuthController, deleteAccountValidation } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { accountDeleteLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

/**
 * DELETE /api/account
 * Self-service account deletion. Requires a valid session and re-entry of the
 * current password. Schema cascades remove favorites, schedules and logs.
 */
router.delete(
  '/',
  authMiddleware,
  accountDeleteLimiter,
  deleteAccountValidation,
  AuthController.deleteAccount
);

export default router;
