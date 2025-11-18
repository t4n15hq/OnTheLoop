import { Router, Request, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/users/me
 * Get current user profile
 */
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    // The user is already attached to the request by authMiddleware
    const user = req.user;

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    // Return user data from the decoded token
    res.status(200).json({
      user: {
        id: user.userId,
        phoneNumber: user.phoneNumber,
      }
    });
  } catch (error: any) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

export default router;
