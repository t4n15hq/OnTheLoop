import { Router } from 'express';
import {
  AuthController,
  registerValidation,
  loginValidation,
} from '../controllers/auth.controller';

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

export default router;
