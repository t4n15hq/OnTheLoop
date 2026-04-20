import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/users/me
 * Get current user profile (full record, not just token payload).
 */
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const user = await AuthService.getUserById(req.user!.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    res.status(200).json({ user });
  } catch (error: any) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

export default router;
