import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/auth.service';
import { AuthRequest } from '../middleware/auth.middleware';
import config from '../config';
import logger from '../utils/logger';

export class AuthController {
  static async register(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { email, password, name } = req.body;
      const result = await AuthService.register(email, password, name);

      res.status(201).json({
        message: 'User registered successfully',
        user: result.user,
        token: result.token,
      });
    } catch (error: any) {
      logger.error('Registration error:', error);
      res.status(400).json({ error: error.message || 'Registration failed' });
    }
  }

  static async login(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { email, password } = req.body;
      const result = await AuthService.login(email, password);

      res.status(200).json({
        message: 'Login successful',
        user: result.user,
        token: result.token,
      });
    } catch (error: any) {
      logger.error('Login error:', error);
      res.status(401).json({ error: error.message || 'Login failed' });
    }
  }

  static async updatePassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { password } = req.body;
      const userId = req.user!.userId;

      await AuthService.updatePassword(userId, password);
      res.status(200).json({ message: 'Password updated successfully' });
    } catch (error: any) {
      logger.error('Update password error:', error);
      res.status(400).json({ error: error.message || 'Failed to update password' });
    }
  }

  static async updateProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { name, email, emailNotifications } = req.body;
      const userId = req.user!.userId;

      const user = await AuthService.updateProfile(userId, { name, email, emailNotifications });
      res.status(200).json({ message: 'Profile updated successfully', user });
    } catch (error: any) {
      logger.error('Update profile error:', error);
      res.status(400).json({ error: error.message || 'Failed to update profile' });
    }
  }

  /**
   * Issue a one-time token that the user pastes to the Telegram bot
   * via `t.me/<bot>?start=<token>` to link their account.
   */
  static async createTelegramLink(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const token = await AuthService.createTelegramLinkToken(userId);

      const botUsername = config.telegram.botUsername;
      const deepLink = botUsername
        ? `https://t.me/${botUsername}?start=${token}`
        : null;

      res.status(200).json({ token, deepLink, botUsername: botUsername || null });
    } catch (error: any) {
      logger.error('Create telegram link error:', error);
      res.status(500).json({ error: error.message || 'Failed to create link' });
    }
  }

  static async unlinkTelegram(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      await AuthService.unlinkTelegram(userId);
      res.status(200).json({ message: 'Telegram unlinked' });
    } catch (error: any) {
      logger.error('Unlink telegram error:', error);
      res.status(500).json({ error: error.message || 'Failed to unlink' });
    }
  }
}

export const registerValidation = [
  body('email')
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email')
    .normalizeEmail(),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
  body('name').optional().trim().isLength({ min: 1 }),
];

export const loginValidation = [
  body('email')
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email')
    .normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

export const passwordUpdateValidation = [
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
];

export const profileUpdateValidation = [
  body('name').optional({ nullable: true }).trim(),
  body('email').optional().trim().isEmail().withMessage('Invalid email address'),
  body('emailNotifications').optional().isBoolean(),
];
