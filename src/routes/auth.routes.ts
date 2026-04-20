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

router.post('/register', registerValidation, AuthController.register);
router.post('/login', loginValidation, AuthController.login);

router.put(
  '/password',
  authMiddleware,
  passwordUpdateValidation,
  AuthController.updatePassword
);

router.put(
  '/profile',
  authMiddleware,
  profileUpdateValidation,
  AuthController.updateProfile
);

router.post('/telegram/link', authMiddleware, AuthController.createTelegramLink);
router.delete('/telegram/link', authMiddleware, AuthController.unlinkTelegram);

export default router;
