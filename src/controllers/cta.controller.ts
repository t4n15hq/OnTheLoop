import { Request, Response } from 'express';
import { CTALookupService } from '../services/cta-lookup.service';
import { GeminiMapsService } from '../services/gemini-maps.service';
import { CTAService } from '../services/cta.service';
import { AISMSService } from '../services/ai-sms.service';
import { AlertsService } from '../services/alerts.service';
import * as assistant from '../services/assistant';
import { AuthRequest } from '../middleware/auth.middleware';
import logger from '../utils/logger';
import prisma from '../utils/db';
import { reportError } from '../utils/sentry';

export class CTAController {
  /**
   * Get all available bus routes
   */
  static async getBusRoutes(req: Request, res: Response): Promise<void> {
    try {
      const routes = await CTALookupService.getBusRoutes();
      res.status(200).json({ routes });
    } catch (error: any) {
      reportError(error, { route: 'cta/bus-routes' });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get directions for a specific bus route
   */
  static async getBusDirections(req: Request, res: Response): Promise<void> {
    try {
      const { routeId } = req.params;

      if (!routeId) {
        res.status(400).json({ error: 'Route ID is required' });
        return;
      }

      const directions = await CTALookupService.getBusDirections(routeId);
      res.status(200).json({ route: routeId, directions });
    } catch (error: any) {
      reportError(error, { route: 'cta/bus-directions', routeId: req.params.routeId });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get stops for a specific bus route and direction
   */
  static async getBusStops(req: Request, res: Response): Promise<void> {
    try {
      const { routeId } = req.params;
      const { direction, search } = req.query;

      if (!routeId || !direction) {
        res.status(400).json({ error: 'Route ID and direction are required' });
        return;
      }

      let stops;

      // If search term provided, filter stops
      if (search && typeof search === 'string') {
        stops = await CTALookupService.searchStopsByName(
          routeId,
          direction as string,
          search
        );
      } else {
        stops = await CTALookupService.getBusStops(routeId, direction as string);
      }

      res.status(200).json({
        route: routeId,
        direction,
        stops,
      });
    } catch (error: any) {
      reportError(error, { route: 'cta/bus-stops', routeId: req.params.routeId });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Find nearby stops based on user location
   */
  static async findNearbyStops(req: Request, res: Response): Promise<void> {
    try {
      const { routeId } = req.params;
      const { direction, lat, lon, radius } = req.query;

      if (!routeId || !direction || !lat || !lon) {
        res.status(400).json({
          error: 'Route ID, direction, latitude, and longitude are required',
        });
        return;
      }

      const userLat = parseFloat(lat as string);
      const userLon = parseFloat(lon as string);
      const radiusMiles = radius ? parseFloat(radius as string) : 0.5;

      if (isNaN(userLat) || isNaN(userLon)) {
        res.status(400).json({ error: 'Invalid latitude or longitude' });
        return;
      }

      const stops = await CTALookupService.findNearbyStops(
        routeId,
        direction as string,
        userLat,
        userLon,
        radiusMiles
      );

      res.status(200).json({
        route: routeId,
        direction,
        location: { lat: userLat, lon: userLon },
        radius: radiusMiles,
        stops,
      });
    } catch (error: any) {
      reportError(error, { route: 'cta/nearby-stops', routeId: req.params.routeId });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all train lines
   */
  static async getTrainLines(req: Request, res: Response): Promise<void> {
    try {
      const lines = CTALookupService.getTrainLines();
      res.status(200).json({ lines });
    } catch (error: any) {
      reportError(error, { route: 'cta/train-lines' });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get train stations for a specific line
   */
  static async getTrainStations(req: Request, res: Response): Promise<void> {
    try {
      const { line } = req.params;
      const stations = await CTALookupService.getTrainStations(line);
      res.status(200).json({ line, stations });
    } catch (error: any) {
      reportError(error, { route: 'cta/train-stations', line: req.params.line });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Resolve a natural language location query to coordinates
   * Example: "coffee shop near Northwestern University"
   */
  static async resolveLocation(req: Request, res: Response): Promise<void> {
    try {
      const { query } = req.query;

      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Location query is required' });
        return;
      }

      const startedAt = Date.now();
      const location = await GeminiMapsService.resolveLocation(query);
      logger.info(`Gemini location resolve completed in ${Date.now() - startedAt}ms`);

      if (!location) {
        res.status(404).json({ error: 'Could not resolve location' });
        return;
      }

      res.status(200).json({ location });
    } catch (error: any) {
      reportError(error, { route: 'cta/resolve-location', queryLength: String(req.query.query || '').length });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Find stops near a natural language location
   * Example: Find Route 60 stops near "Willis Tower"
   */
  static async findStopsNearNaturalLocation(req: Request, res: Response): Promise<void> {
    try {
      const { routeId } = req.params;
      const { direction, location, radius } = req.query;

      if (!routeId || !direction || !location) {
        res.status(400).json({
          error: 'Route ID, direction, and location query are required',
        });
        return;
      }

      const radiusMiles = radius ? parseFloat(radius as string) : 0.5;

      const startedAt = Date.now();
      const result = await GeminiMapsService.findStopsNearLocation(
        location as string,
        routeId,
        direction as string,
        radiusMiles
      );
      logger.info(`Gemini near-location lookup completed in ${Date.now() - startedAt}ms`);

      if (!result) {
        res.status(404).json({ error: 'Could not find stops near location' });
        return;
      }

      res.status(200).json({
        route: routeId,
        direction,
        location: result.location,
        radius: radiusMiles,
        stops: result.stops,
      });
    } catch (error: any) {
      reportError(error, { route: 'cta/stops-near-location', routeId: req.params.routeId });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get transit suggestions using natural language with real-time arrivals.
   * Thin wrapper: intent parse, favorite match, the bounded live-arrivals
   * fan-out (#14), Sentry reporting (#13), and answer formatting now live in the
   * testable `services/assistant` modules. Runtime behavior is unchanged.
   * Example: "How do I get from Northwestern to downtown?"
   * Example: "When is the next 157 bus?"
   */
  static async getTransitSuggestion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { query } = req.query;
      const userId = req.user?.userId;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        res.status(400).json({ error: 'Transit query is required' });
        return;
      }

      const startedAt = Date.now();

      // All of the logic (intent parse, favorite match, bounded live-arrivals
      // fan-out, and answer formatting) lives in the assistant modules now.
      const result = await assistant.answer({ query, userId });

      res.status(200).json({
        query: result.query,
        answer: result.answer,
        realTimeArrivals: result.realTimeArrivals,
      });
      logger.info(`Gemini transit suggestion completed in ${Date.now() - startedAt}ms`);
    } catch (error: any) {
      reportError(error, {
        route: 'cta/transit-suggestion',
        userId: req.user?.userId,
        queryLength: typeof req.query.query === 'string' ? req.query.query.length : 0,
      });
      res.status(500).json({ error: error.message });
    }
  }
  /**
   * Get live arrivals for a specific route and stop (Bus or Train)
   * Query params: type (bus/train), routeId, stopId
   */
  static async getArrivals(req: Request, res: Response): Promise<void> {
    try {
      const { type, routeId, stopId, direction } = req.query;

      if (!type || !stopId) {
        res.status(400).json({ error: 'Type (bus/train) and stopId are required' });
        return;
      }

      let arrivals = [];

      if (type === 'TRAIN') {
        // For trains, stopId is the map_id (station ID)
        // routeId is optional but helps filter (e.g. "Red", "Blue")
        // direction is optional but filters by direction (e.g. "Northbound")
        arrivals = await CTAService.getTrainArrivals(
          stopId as string,
          routeId as string | undefined,
          direction as string | undefined
        );
      } else if (type === 'BUS') {
        // For buses, stopId is the stpid
        // routeId is required for buses in our lookup but optional for the API, 
        // but we should pass it if we have it.
        arrivals = await CTAService.getBusPredictions(stopId as string, routeId as string);
      } else {
        res.status(400).json({ error: 'Invalid type. Must be BUS or TRAIN' });
        return;
      }

      res.status(200).json({ arrivals });
    } catch (error: any) {
      reportError(error, { route: 'cta/arrivals', type: req.query.type, routeId: req.query.routeId });
      res.status(500).json({ error: error.message });
    }
  }
  /**
   * Parse natural language route configuration
   */
  static async parseRouteConfig(req: Request, res: Response): Promise<void> {
    try {
      const { query } = req.body;
      if (!query) {
        res.status(400).json({ error: 'Query is required' });
        return;
      }
      const startedAt = Date.now();
      const config = await AISMSService.parseRouteConfig(query);
      logger.info(`Gemini route config parse completed in ${Date.now() - startedAt}ms`);
      res.status(200).json({ config });
    } catch (error: any) {
      reportError(error, { route: 'cta/parse-route-config', queryLength: String(req.body?.query || '').length });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Current CTA service alerts. If the caller is authenticated, filter to
   * alerts impacting their saved routes (plus system-wide major alerts);
   * otherwise return all major system-wide alerts.
   */
  static async getAlerts(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (req.user) {
        const favorites = await prisma.favorite.findMany({
          where: { userId: req.user.userId },
          select: { routeId: true, routeType: true },
        });
        const alerts = await AlertsService.getForRoutes(favorites);
        res.status(200).json({ alerts });
        return;
      }

      const all = await AlertsService.getAllActive();
      res.status(200).json({ alerts: all.filter((a) => a.majorAlert) });
    } catch (error: any) {
      reportError(error, { route: 'cta/alerts', userId: req.user?.userId });
      res.status(500).json({ error: error.message });
    }
  }
}
