import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config';
import prisma from '../utils/db';
import logger from '../utils/logger';

interface TokenPayload {
  userId: string;
  phoneNumber: string;
}

export class AuthService {
  /**
   * Hash a password
   */
  static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  /**
   * Compare password with hash
   */
  static async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate JWT token
   */
  static generateToken(payload: TokenPayload): string {
    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    } as jwt.SignOptions);
  }

  /**
   * Verify JWT token
   */
  static verifyToken(token: string): TokenPayload {
    return jwt.verify(token, config.jwt.secret) as TokenPayload;
  }

  /**
   * Register a new user
   */
  static async register(phoneNumber: string, password: string) {
    try {
      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { phoneNumber },
      });

      if (existingUser) {
        throw new Error('User with this phone number already exists');
      }

      // Hash password
      const hashedPassword = await this.hashPassword(password);

      // Create user
      const user = await prisma.user.create({
        data: {
          phoneNumber,
          password: hashedPassword,
        },
        select: {
          id: true,
          phoneNumber: true,
          createdAt: true,
        },
      });

      // Generate token
      const token = this.generateToken({
        userId: user.id,
        phoneNumber: user.phoneNumber,
      });

      logger.info(`User registered: ${phoneNumber}`);

      return { user, token };
    } catch (error) {
      logger.error('Registration error:', error);
      throw error;
    }
  }

  /**
   * Login user
   */
  static async login(phoneNumber: string, password: string) {
    try {
      // Find user
      const user = await prisma.user.findUnique({
        where: { phoneNumber },
      });

      if (!user) {
        throw new Error('Invalid credentials');
      }

      // Verify password
      const isValidPassword = await this.comparePassword(password, user.password);

      if (!isValidPassword) {
        throw new Error('Invalid credentials');
      }

      // Generate token
      const token = this.generateToken({
        userId: user.id,
        phoneNumber: user.phoneNumber,
      });

      logger.info(`User logged in: ${phoneNumber}`);

      return {
        user: {
          id: user.id,
          phoneNumber: user.phoneNumber,
          createdAt: user.createdAt,
        },
        token,
      };
    } catch (error) {
      logger.error('Login error:', error);
      throw error;
    }
  }

  /**
   * Get user by phone number (for SMS authentication)
   */
  static async getUserByPhone(phoneNumber: string) {
    try {
      const user = await prisma.user.findUnique({
        where: { phoneNumber },
        select: {
          id: true,
          phoneNumber: true,
          createdAt: true,
        },
      });

      return user;
    } catch (error) {
      logger.error('Get user error:', error);
      throw error;
    }
  }
}
