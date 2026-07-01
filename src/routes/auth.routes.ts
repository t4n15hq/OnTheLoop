import { Router } from 'express';
import {
  AuthController,
  registerValidation,
  loginValidation,
  passwordUpdateValidation,
  profileUpdateValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
} from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  loginLimiter,
  registerLimiter,
  passwordChangeLimiter,
  passwordResetLimiter,
  telegramLinkLimiter,
} from '../middleware/rate-limit.middleware';

const router = Router();

router.post('/register', registerLimiter, registerValidation, AuthController.register);
router.post('/login', loginLimiter, loginValidation, AuthController.login);

router.post(
  '/forgot-password',
  passwordResetLimiter,
  forgotPasswordValidation,
  AuthController.forgotPassword
);
router.post(
  '/reset-password',
  passwordResetLimiter,
  resetPasswordValidation,
  AuthController.resetPassword
);

router.put(
  '/password',
  authMiddleware,
  passwordChangeLimiter,
  passwordUpdateValidation,
  AuthController.updatePassword
);

router.put(
  '/profile',
  authMiddleware,
  profileUpdateValidation,
  AuthController.updateProfile
);

router.post('/telegram/link', authMiddleware, telegramLinkLimiter, AuthController.createTelegramLink);
router.delete('/telegram/link', authMiddleware, AuthController.unlinkTelegram);

export default router;
