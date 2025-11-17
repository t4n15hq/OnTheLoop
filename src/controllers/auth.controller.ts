import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/auth.service';
import { SMSService } from '../services/sms.service';
import logger from '../utils/logger';

export class AuthController {
  /**
   * Register a new user (phone-only authentication)
   */
  static async register(req: Request, res: Response): Promise<void> {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { phoneNumber } = req.body;

      // Format phone number
      const formattedPhone = SMSService.formatPhoneNumber(phoneNumber);

      // Register user (phone-only, no password)
      const result = await AuthService.registerPhoneOnly(formattedPhone);

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
   * Login user (phone-only authentication)
   */
  static async login(req: Request, res: Response): Promise<void> {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { phoneNumber } = req.body;

      // Format phone number
      const formattedPhone = SMSService.formatPhoneNumber(phoneNumber);

      // Login user (phone-only, no password)
      const result = await AuthService.loginPhoneOnly(formattedPhone);

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
}

// Validation middleware (phone-only)
export const registerValidation = [
  body('phoneNumber')
    .notEmpty()
    .withMessage('Phone number is required')
    .isMobilePhone('any')
    .withMessage('Invalid phone number'),
];

export const loginValidation = [
  body('phoneNumber')
    .notEmpty()
    .withMessage('Phone number is required')
    .isMobilePhone('any')
    .withMessage('Invalid phone number'),
];
