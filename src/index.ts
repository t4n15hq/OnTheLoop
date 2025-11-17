import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config';
import logger from './utils/logger';
import { startScheduler } from './services/scheduler.service';

// Import routes
import authRoutes from './routes/auth.routes';
import favoriteRoutes from './routes/favorite.routes';
import smsRoutes from './routes/sms.routes';
import ctaRoutes from './routes/cta.routes';

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', favoriteRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/cta', ctaRoutes);

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
