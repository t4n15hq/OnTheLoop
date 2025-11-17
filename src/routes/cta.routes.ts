import { Router } from 'express';
import { CTAController } from '../controllers/cta.controller';

const router = Router();

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
router.get('/location/resolve', CTAController.resolveLocation);

/**
 * GET /api/cta/bus/:routeId/stops/near-location
 * Find stops near a natural language location using Gemini
 * Query params: direction, location (natural language), radius (optional)
 */
router.get('/bus/:routeId/stops/near-location', CTAController.findStopsNearNaturalLocation);

/**
 * GET /api/cta/transit/ask
 * Get transit suggestions using natural language
 * Query params: query (e.g., "How do I get from Northwestern to downtown?")
 */
router.get('/transit/ask', CTAController.getTransitSuggestion);

export default router;
