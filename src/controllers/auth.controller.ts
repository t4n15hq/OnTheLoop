import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/auth.service';
import { SMSService } from '../services/sms.service';
import logger from '../utils/logger';

export class AuthController {
  /**
   * Register a new user
   */
  static async register(req: Request, res: Response): Promise<void> {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { phoneNumber, password } = req.body;

      // Format phone number
      const formattedPhone = SMSService.formatPhoneNumber(phoneNumber);

      // Register user
      const result = await AuthService.register(formattedPhone, password);

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

  /**
   * Login user
   */
  static async login(req: Request, res: Response): Promise<void> {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { phoneNumber, password } = req.body;

      // Format phone number
      const formattedPhone = SMSService.formatPhoneNumber(phoneNumber);

      // Login user
      const result = await AuthService.login(formattedPhone, password);

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
  /**
   * Update password
   */
  static async updatePassword(req: Request, res: Response): Promise<void> {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { password } = req.body;
      // @ts-ignore - User is attached by auth middleware
      const userId = req.user.userId;

      await AuthService.updatePassword(userId, password);

      res.status(200).json({ message: 'Password updated successfully' });
    } catch (error: any) {
      logger.error('Update password error:', error);
      res.status(400).json({ error: error.message || 'Failed to update password' });
    }
  }
  /**
   * Update profile
   */
  static async updateProfile(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { name, email } = req.body;
      // @ts-ignore
      const userId = req.user.userId;

      const user = await AuthService.updateProfile(userId, { name, email });

      res.status(200).json({ message: 'Profile updated successfully', user });
    } catch (error: any) {
      logger.error('Update profile error:', error);
      res.status(400).json({ error: error.message || 'Failed to update profile' });
    }
  }
}

// Validation middleware
export const registerValidation = [
  body('phoneNumber')
    .notEmpty()
    .withMessage('Phone number is required')
    .isMobilePhone('any')
    .withMessage('Invalid phone number'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
];

export const loginValidation = [
  body('phoneNumber')
    .notEmpty()
    .withMessage('Phone number is required')
    .isMobilePhone('any')
    .withMessage('Invalid phone number'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

export const passwordUpdateValidation = [
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
];

export const profileUpdateValidation = [
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').optional().trim().isEmail().withMessage('Invalid email address'),
];
