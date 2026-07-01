import { NextFunction, Request, Response, Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { CTAController } from '../controllers/cta.controller';
import { optionalAuthMiddleware } from '../middleware/auth.middleware';
import { aiLimiter } from '../middleware/rate-limit.middleware';
import config from '../config';

const router = Router();

function requireAiEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!config.features.ai) {
    res.status(503).json({ error: 'AI features are temporarily disabled' });
    return;
  }
  next();
}

function rejectValidationErrors(req: Request, res: Response, next: NextFunction): void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
}

export const queryTextValidation = [
  query('query').trim().notEmpty().withMessage('Query is required').isLength({ max: 300 }).withMessage('Query is too long'),
  rejectValidationErrors,
];

export const locationTextValidation = [
  query('location').trim().notEmpty().withMessage('Location is required').isLength({ max: 300 }).withMessage('Location is too long'),
  rejectValidationErrors,
];

export const parseRouteValidation = [
  body('query').trim().notEmpty().withMessage('Query is required').isLength({ max: 300 }).withMessage('Query is too long'),
  rejectValidationErrors,
];

/**
 * GET /api/cta/bus/routes
 * Get all available bus routes
 */
router.get('/bus/routes', CTAController.getBusRoutes);

/**
 * GET /api/cta/bus/:routeId/directions
 * Get directions for a specific bus route
 */
router.get('/bus/:routeId/directions', CTAController.getBusDirections);

/**
 * GET /api/cta/bus/:routeId/stops
 * Get stops for a specific bus route and direction
 * Query params: direction (required), search (optional)
 */
router.get('/bus/:routeId/stops', CTAController.getBusStops);

/**
 * GET /api/cta/bus/:routeId/stops/nearby
 * Find stops near a location
 * Query params: direction, lat, lon, radius (optional, default 0.5 miles)
 */
router.get('/bus/:routeId/stops/nearby', CTAController.findNearbyStops);

/**
 * GET /api/cta/train/lines
 * Get all train lines
 */
router.get('/train/lines', CTAController.getTrainLines);

/**
 * GET /api/cta/train/:line/stations
 * Get stations for a specific train line
 */
router.get('/train/:line/stations', CTAController.getTrainStations);

/**
 * GET /api/cta/location/resolve
 * Resolve a natural language location to coordinates using Gemini
 * Query params: query (e.g., "Willis Tower" or "coffee shop near Northwestern")
 */
router.get('/location/resolve', requireAiEnabled, aiLimiter, queryTextValidation, CTAController.resolveLocation);

/**
 * GET /api/cta/bus/:routeId/stops/near-location
 * Find stops near a natural language location using Gemini
 * Query params: direction, location (natural language), radius (optional)
 */
router.get('/bus/:routeId/stops/near-location', requireAiEnabled, aiLimiter, locationTextValidation, CTAController.findStopsNearNaturalLocation);

/**
 * GET /api/cta/transit/ask
 * Get transit suggestions using natural language
 * Query params: query (e.g., "How do I get from Northwestern to downtown?")
 */
router.get('/transit/ask', requireAiEnabled, aiLimiter, queryTextValidation, optionalAuthMiddleware, CTAController.getTransitSuggestion);
/**
 * GET /api/cta/arrivals
 * Get live arrivals for a specific route and stop
 * Query params: type (BUS/TRAIN), routeId, stopId
 */
router.get('/arrivals', CTAController.getArrivals);
/**
 * POST /api/cta/parse-route
 * Parse natural language route configuration
 * Body: { query: string }
 */
router.post('/parse-route', requireAiEnabled, aiLimiter, parseRouteValidation, CTAController.parseRouteConfig);

/**
 * GET /api/cta/alerts
 * Current CTA service alerts. Authenticated callers get alerts filtered to
 * their saved routes; anonymous callers see all major system-wide alerts.
 */
router.get('/alerts', optionalAuthMiddleware, CTAController.getAlerts);

export default router;
