import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import logger from '../utils/logger';

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
  };
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = AuthService.verifyToken(token);

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
    };

    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Populates req.user if a valid bearer token is present, but never rejects the
// request. Used by endpoints that benefit from user context (favorites lookup)
// but should still work for anonymous callers.
export const optionalAuthMiddleware = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
  try {
    const decoded = AuthService.verifyToken(authHeader.substring(7));
    req.user = { userId: decoded.userId, email: decoded.email };
  } catch {
    // Ignore — treat as anonymous.
  }
  next();
};
