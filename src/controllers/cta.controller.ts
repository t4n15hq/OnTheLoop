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
   * Get train stations for a specific line
   */
  static async getTrainStations(req: Request, res: Response): Promise<void> {
    try {
      const { line } = req.params;
      const stations = await CTALookupService.getTrainStations(line);
      res.status(200).json({ line, stations });
    } catch (error: any) {
      logger.error('Get train stations error:', error);
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

      // Parse query to detect intent
      const parsed = await AISMSService.parseQuery(query);

      let realTimeArrivals = null;
      let conversationalResponse = null;

      // Handle transit directions query
      if (parsed.intent === 'transit_directions' && parsed.origin && parsed.destination) {
        try {
          // Get AI-powered directions
          const directions = await GeminiMapsService.getTransitSuggestion(query);

          // Extract ALL route numbers and train lines from the directions
          // Look for bus routes with various patterns
          const busPattern = /(?:route|bus|#|Route)\s*(\d+)/gi;
          const busMatches = [...directions.matchAll(busPattern)];
          let busRoutes = busMatches.map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i);

          // Also look for numbered patterns in markdown like "**157**" or "157 Streeterville"
          const markdownPattern = /\*\*(?:Route\s*)?(\d+)/gi;
          const markdownMatches = [...directions.matchAll(markdownPattern)];
          busRoutes = [...new Set([...busRoutes, ...markdownMatches.map(m => m[1])])];

          // Look for train lines: "Red Line", "Blue Line", "Pink Line", etc.
          const trainPattern = /(Red|Blue|Brown|Green|Orange|Pink|Purple|Yellow)\s+Line/gi;
          const trainMatches = [...directions.matchAll(trainPattern)];
          const trainLines = trainMatches.map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i);

          logger.info(`Extracted routes - Buses: ${busRoutes.join(', ')}, Trains: ${trainLines.join(', ')}`);

          // If no routes found, try to extract from query itself
          if (busRoutes.length === 0 && trainLines.length === 0) {
            const queryRouteMatch = query.match(/\b(\d{1,3})\b/);
            if (queryRouteMatch) {
              busRoutes.push(queryRouteMatch[1]);
            }
          }

          // Fetch real-time arrivals for all mentioned routes (buses and trains)
          const routeArrivals = [];

          // Get bus arrivals
          for (const routeNum of busRoutes.slice(0, 3)) {
            try {
              logger.info(`Fetching arrivals for bus route ${routeNum}`);
              const routes = await CTALookupService.getBusRoutes();
              const route = routes.find(r => r.rt === routeNum);

              if (!route) {
                logger.warn(`Bus route ${routeNum} not found in CTA routes`);
                continue;
              }

              if (route) {
                const directions = await CTALookupService.getBusDirections(routeNum);
                for (const direction of directions) {
                  const stops = await CTALookupService.getBusStops(routeNum, direction);

                  // Check first few stops for arrivals
                  for (const stop of stops.slice(0, 5)) {
                    try {
                      const arrivals = await CTAService.getBusPredictions(stop.stpid, routeNum, 2);
                      const validArrivals = arrivals.filter(a => a.minutesAway !== null || a.isApproaching);

                      if (validArrivals.length > 0) {
                        logger.info(`Found ${validArrivals.length} arrivals for route ${routeNum} at ${stop.stpnm}`);
                        routeArrivals.push({
                          type: 'bus',
                          route: routeNum,
                          routeName: route.rtnm,
                          stopName: stop.stpnm,
                          direction,
                          nextArrival: validArrivals[0].minutesAway || 0,
                          arrivals: validArrivals.slice(0, 2).map(a => ({
                            destination: a.destination,
                            minutesAway: a.minutesAway,
                            isApproaching: a.isApproaching
                          }))
                        });
                        break; // Found arrivals for this route, move to next
                      }
                    } catch (err) {
                      logger.error(`Error fetching arrivals for stop ${stop.stpid}:`, err);
                      continue;
                    }
                  }
                  if (routeArrivals.some(r => r.route === routeNum)) break;
                }
              }
            } catch (err) {
              logger.error(`Error processing bus route ${routeNum}:`, err);
              continue;
            }
          }

          logger.info(`Total route arrivals found: ${routeArrivals.length}`);

          // Sort routes by quickest arrival time (ascending)
          routeArrivals.sort((a, b) => a.nextArrival - b.nextArrival);

          // Build short, scannable response with options ranked by speed
          conversationalResponse = '';

          // Show real-time arrivals if available, sorted by fastest first
          if (routeArrivals.length > 0) {
            conversationalResponse += '⚡ Fastest Option:\n';
            const fastest = routeArrivals[0];
            const nextBus = fastest.arrivals[0];
            const timeText = nextBus.isApproaching ? 'NOW' : `${nextBus.minutesAway} min`;
            const icon = fastest.type === 'train' ? '🚊' : '🚌';
            conversationalResponse += `${icon} ${fastest.type === 'train' ? fastest.route + ' Line' : 'Route ' + fastest.route} → ${timeText}\n`;
            conversationalResponse += `📍 ${fastest.stopName}\n`;

            // Show alternative options
            if (routeArrivals.length > 1) {
              conversationalResponse += '\n📋 Alternatives:\n';
              for (let i = 1; i < Math.min(3, routeArrivals.length); i++) {
                const alt = routeArrivals[i];
                const altNext = alt.arrivals[0];
                const altTime = altNext.isApproaching ? 'NOW' : `${altNext.minutesAway} min`;
                const altIcon = alt.type === 'train' ? '🚊' : '🚌';
                conversationalResponse += `${altIcon} ${alt.type === 'train' ? alt.route + ' Line' : 'Route ' + alt.route} → ${altTime}\n`;
              }
            }
          } else {
            // No real-time data, show condensed AI directions
            conversationalResponse += '📍 Directions:\n';
            const sentences = directions.split(/[.!]\s+/).filter(s => s.length > 20);
            conversationalResponse += sentences.slice(0, 2).join('. ').substring(0, 200) + '...';
          }

          realTimeArrivals = routeArrivals.length > 0 ? { routes: routeArrivals } : null;

        } catch (err) {
          logger.error('Error handling transit directions:', err);
          conversationalResponse = await GeminiMapsService.getTransitSuggestion(query);
        }
      }
      // Handle route arrivals query
      else if (parsed.intent === 'route_arrivals' && parsed.routeNumber) {
        try {
          const routeNumber = parsed.routeNumber;

          // Try to get all bus stops for this route to show arrivals
          const routes = await CTALookupService.getBusRoutes();
          const route = routes.find(r => r.rt === routeNumber);

          if (route) {
            // Get stops from all directions to maximize chances of finding active buses
            const directions = await CTALookupService.getBusDirections(routeNumber);
            const allStopsWithArrivals: any[] = [];

            // Try each direction until we find 3 stops with arrivals
            for (const direction of directions) {
              if (allStopsWithArrivals.length >= 3) break;

              try {
                const stops = await CTALookupService.getBusStops(routeNumber, direction);

                // Check stops in this direction
                for (const stop of stops) {
                  if (allStopsWithArrivals.length >= 3) break;

                  try {
                    const arrivals = await CTAService.getBusPredictions(stop.stpid, routeNumber, 3);

                    // Only include stops with actual arrivals that have valid times
                    const validArrivals = arrivals.filter(a => a.minutesAway !== null || a.isApproaching);

                    if (validArrivals.length > 0) {
                      allStopsWithArrivals.push({
                        stopName: stop.stpnm,
                        stopId: stop.stpid,
                        direction: direction,
                        arrivals: validArrivals.map(a => ({
                          destination: a.destination,
                          minutesAway: a.minutesAway,
                          isApproaching: a.isApproaching,
                          isDelayed: a.isDelayed
                        }))
                      });
                    }
                  } catch (err) {
                    // Skip stops with errors
                    continue;
                  }
                }
              } catch (err) {
                continue;
              }
            }

            if (allStopsWithArrivals.length > 0) {
              realTimeArrivals = {
                route: routeNumber,
                routeName: route.rtnm,
                stops: allStopsWithArrivals
              };

              // Create short, scannable response
              const closestStop = allStopsWithArrivals[0];
              const nextBus = closestStop.arrivals[0];

              const timeText = nextBus.isApproaching ? 'NOW' : `${nextBus.minutesAway} min`;

              conversationalResponse = `🚌 Route ${routeNumber} ${closestStop.direction}\n`;
              conversationalResponse += `📍 ${closestStop.stopName}\n`;
              conversationalResponse += `⏱️  Next: ${timeText} → ${nextBus.destination}`;

              if (nextBus.isDelayed) {
                conversationalResponse += ' ⚠️ DELAYED';
              }

              // Add following buses
              if (closestStop.arrivals.length > 1) {
                const following = closestStop.arrivals.slice(1, 3).map((a: any) =>
                  a.isApproaching ? 'NOW' : `${a.minutesAway} min`
                );
                conversationalResponse += `\n    Then: ${following.join(', ')}`;
              }
            } else {
              // No arrivals found - likely no service at this time
              conversationalResponse = `🚌 Route ${routeNumber} - ${route.rtnm}\n\n`;
              conversationalResponse += `No buses are currently running on this route.\n\n`;
              conversationalResponse += `This could be because:\n`;
              conversationalResponse += `• It's outside service hours (buses typically run 5 AM - 1 AM)\n`;
              conversationalResponse += `• The route doesn't operate on this day\n`;
              conversationalResponse += `• There's a service disruption\n\n`;
              conversationalResponse += `Try again during service hours or check transitchicago.com for the route schedule.`;
            }
          }
        } catch (err) {
          logger.warn('Could not fetch real-time arrivals:', err);
        }
      }

      res.status(200).json({
        query,
        answer: conversationalResponse || await GeminiMapsService.getTransitSuggestion(query),
        realTimeArrivals
      });
    } catch (error: any) {
      logger.error('Get transit suggestion error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
