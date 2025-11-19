import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import config from './config';
import logger from './utils/logger';
import { startScheduler } from './services/scheduler.service';

// Import routes
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import favoriteRoutes from './routes/favorite.routes';
import smsRoutes from './routes/sms.routes';
import ctaRoutes from './routes/cta.routes';

const app = express();

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"], // Allow images from external sources just in case
        connectSrc: ["'self'", "https://lapi.transitchicago.com", "http://lapi.transitchicago.com", "http://www.ctabustracker.com"], // Allow connections to CTA APIs if frontend calls them directly (though it shouldn't)
      },
    },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes - Order matters! More specific routes must come before catch-all routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);  // User profile routes (requires auth)
app.use('/api/sms', smsRoutes);   // SMS webhook (no auth required)
app.use('/api/cta', ctaRoutes);
app.use('/api', favoriteRoutes);  // Catch-all for /api/* (requires auth)

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = config.port;

app.listen(PORT, () => {
  logger.info(`CTA Track API server started on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);

  // Start the notification scheduler
  startScheduler();
  logger.info('Notification scheduler started');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

export default app;
