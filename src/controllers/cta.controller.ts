import { Request, Response } from 'express';
import { CTALookupService } from '../services/cta-lookup.service';
import { GeminiMapsService } from '../services/gemini-maps.service';
import { CTAService } from '../services/cta.service';
import { AISMSService } from '../services/ai-sms.service';
import logger from '../utils/logger';

export class CTAController {
  /**
   * Get all available bus routes
   */
  static async getBusRoutes(req: Request, res: Response): Promise<void> {
    try {
      const routes = await CTALookupService.getBusRoutes();
      res.status(200).json({ routes });
    } catch (error: any) {
      logger.error('Get bus routes error:', error);
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
      logger.error('Get bus directions error:', error);
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
      logger.error('Get bus stops error:', error);
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
      logger.error('Find nearby stops error:', error);
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
      logger.error('Get train lines error:', error);
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

      const location = await GeminiMapsService.resolveLocation(query);

      if (!location) {
        res.status(404).json({ error: 'Could not resolve location' });
        return;
      }

      res.status(200).json({ location });
    } catch (error: any) {
      logger.error('Resolve location error:', error);
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

      const result = await GeminiMapsService.findStopsNearLocation(
        location as string,
        routeId,
        direction as string,
        radiusMiles
      );

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
      logger.error('Find stops near natural location error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get transit suggestions using natural language with real-time arrivals
   * Example: "How do I get from Northwestern to downtown?"
   * Example: "When is the next 157 bus?"
   */
  static async getTransitSuggestion(req: Request, res: Response): Promise<void> {
    try {
      const { query } = req.query;

      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Transit query is required' });
        return;
      }

      // Get AI suggestion
      const suggestion = await GeminiMapsService.getTransitSuggestion(query);

      // Parse query to detect if asking about specific route arrivals
      const parsed = await AISMSService.parseQuery(query);

      let realTimeArrivals = null;

      // If query is about route arrivals, fetch real-time data
      if (parsed.intent === 'route_arrivals' && parsed.routeNumber) {
        try {
          const routeNumber = parsed.routeNumber;

          // Try to get all bus stops for this route to show arrivals
          const routes = await CTALookupService.getBusRoutes();
          const route = routes.find(r => r.rt === routeNumber);

          if (route) {
            // Get first few stops to show sample arrivals
            const directions = await CTALookupService.getBusDirections(routeNumber);
            if (directions.length > 0) {
              const stops = await CTALookupService.getBusStops(routeNumber, directions[0]);

              // Get arrivals for first 3 stops
              const arrivalPromises = stops.slice(0, 3).map(async (stop) => {
                try {
                  const arrivals = await CTAService.getBusPredictions(stop.stpid, routeNumber, 3);
                  return {
                    stopName: stop.stpnm,
                    stopId: stop.stpid,
                    arrivals: arrivals.map(a => ({
                      destination: a.destination,
                      minutesAway: a.minutesAway,
                      isApproaching: a.isApproaching,
                      isDelayed: a.isDelayed
                    }))
                  };
                } catch (err) {
                  return null;
                }
              });

              const arrivalResults = await Promise.all(arrivalPromises);
              realTimeArrivals = {
                route: routeNumber,
                routeName: route.rtnm,
                direction: directions[0],
                stops: arrivalResults.filter(a => a !== null && a.arrivals.length > 0)
              };
            }
          }
        } catch (err) {
          logger.warn('Could not fetch real-time arrivals:', err);
        }
      }

      res.status(200).json({
        query,
        suggestion,
        realTimeArrivals
      });
    } catch (error: any) {
      logger.error('Get transit suggestion error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
