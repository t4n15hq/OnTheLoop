import { Router } from 'express';
import {
  AuthController,
  registerValidation,
  loginValidation,
  passwordUpdateValidation,
  profileUpdateValidation,
} from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', registerValidation, AuthController.register);

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', loginValidation, AuthController.login);

/**
 * PUT /api/auth/password
 * Update password
 */
router.put(
  '/password',
  authMiddleware,
  passwordUpdateValidation,
  AuthController.updatePassword
);

/**
 * PUT /api/auth/profile
 * Update profile details
 */
router.put(
  '/profile',
  authMiddleware,
  profileUpdateValidation,
  AuthController.updateProfile
);

export default router;
