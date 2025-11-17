import { Request, Response } from 'express';
import { CTALookupService } from '../services/cta-lookup.service';
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
}
