import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config';
import logger from '../utils/logger';
import { CTAService } from './cta.service';
import { CTALookupService } from './cta-lookup.service';
import { GeminiMapsService } from './gemini-maps.service';
import { FavoriteService } from './favorite.service';

interface ParsedSMSQuery {
  intent: 'route_arrivals' | 'find_stops' | 'transit_directions' | 'favorites' | 'unknown';
  routeNumber?: string;
  location?: string;
  stopId?: string;
  origin?: string;
  destination?: string;
}

/**
 * AI-powered SMS query handler using Gemini
 */
export class AISMSService {
  private static genAI = new GoogleGenerativeAI(config.google.geminiApiKey);

  /**
   * Parse natural language SMS query to determine intent and extract parameters
   */
  static async parseQuery(query: string): Promise<ParsedSMSQuery> {
    try {
      logger.info(`Parsing SMS query: ${query}`);

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
      });

      const prompt = `You are a CTA transit SMS bot. Parse this user message and extract the intent and parameters.

User message: "${query}"

Respond ONLY with JSON in this exact format:
{
  "intent": "route_arrivals" | "find_stops" | "transit_directions" | "favorites",
  "routeNumber": "route number if mentioned (e.g., 60, 157, Blue, Red)",
  "location": "location description if mentioned",
  "origin": "starting location for directions",
  "destination": "destination for directions"
}

Intent definitions:
- route_arrivals: User wants to know when the next bus/train arrives on a specific route
- find_stops: User wants to find stops near a location
- transit_directions: User wants directions from A to B
- favorites: User wants to see their saved favorites

Examples:
"157" -> {"intent": "route_arrivals", "routeNumber": "157"}
"When is the next 60 bus?" -> {"intent": "route_arrivals", "routeNumber": "60"}
"Find Route 60 stops near Lytle Street" -> {"intent": "find_stops", "routeNumber": "60", "location": "Lytle Street"}
"How do I get to Willis Tower from Northwestern?" -> {"intent": "transit_directions", "origin": "Northwestern", "destination": "Willis Tower"}
"Show me my favorites" -> {"intent": "favorites"}`;

      const result = await model.generateContent(prompt);
      const response = result.response.text();

      logger.debug(`Gemini parse response: ${response}`);

      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { intent: 'unknown' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        intent: parsed.intent || 'unknown',
        routeNumber: parsed.routeNumber,
        location: parsed.location,
        origin: parsed.origin,
        destination: parsed.destination,
      };
    } catch (error) {
      logger.error('Error parsing SMS query:', error);
      return { intent: 'unknown' };
    }
  }

  /**
   * Handle route arrivals query
   * Example: "157" or "When is the next Blue Line train?"
   */
  static async handleRouteArrivals(
    userId: string,
    routeNumber: string
  ): Promise<string> {
    try {
      // Find matching favorite
      const favorites = await FavoriteService.getUserFavorites(userId);
      const matchingFavorite = favorites.find(
        (fav) => fav.routeId.toLowerCase() === routeNumber.toLowerCase()
      );

      if (!matchingFavorite) {
        return `Route ${routeNumber} not found in your favorites. Add it via the app first, or text "help" for assistance.`;
      }

      // Fetch arrivals
      let arrivals;
      if (matchingFavorite.routeType === 'TRAIN') {
        if (!matchingFavorite.stationId) {
          return 'Station not configured for this favorite.';
        }
        arrivals = await CTAService.getTrainArrivals(
          matchingFavorite.stationId,
          matchingFavorite.routeId
        );
      } else {
        if (!matchingFavorite.stopId) {
          return 'Stop not configured for this favorite.';
        }
        arrivals = await CTAService.getBusPredictions(
          matchingFavorite.stopId,
          matchingFavorite.routeId,
          3
        );
      }

      return this.formatArrivalsForSMS(arrivals, matchingFavorite.name);
    } catch (error) {
      logger.error('Error handling route arrivals:', error);
      return 'Sorry, could not fetch arrival times. Please try again.';
    }
  }

  /**
   * Handle find stops query
   * Example: "Find Route 60 stops near Lytle Street"
   */
  static async handleFindStops(
    routeNumber: string,
    location: string
  ): Promise<string> {
    try {
      // Get directions for the route
      const directions = await CTALookupService.getBusDirections(routeNumber);
      if (directions.length === 0) {
        return `Route ${routeNumber} not found.`;
      }

      // For simplicity, use the first direction
      const direction = directions[0];

      // Resolve location and find nearby stops
      const result = await GeminiMapsService.findStopsNearLocation(
        location,
        routeNumber,
        direction,
        0.5
      );

      if (!result || result.stops.length === 0) {
        return `No Route ${routeNumber} stops found near "${location}".`;
      }

      // Format response
      let message = `Route ${routeNumber} ${direction}\n`;
      message += `Near: ${result.location.name}\n\n`;

      const topStops = result.stops.slice(0, 3);
      topStops.forEach((stop, index) => {
        message += `${index + 1}. ${stop.stpnm}\n`;
        message += `   ${stop.distance.toFixed(2)} mi away\n`;
      });

      message += `\nText route number for arrivals or reply SAVE to add favorite.`;

      return message;
    } catch (error) {
      logger.error('Error handling find stops:', error);
      return 'Sorry, could not find stops. Please try again.';
    }
  }

  /**
   * Handle transit directions query
   * Example: "How do I get to Willis Tower from Northwestern?"
   */
  static async handleTransitDirections(
    origin: string,
    destination: string
  ): Promise<string> {
    try {
      const query = `How do I get from ${origin} to ${destination} using CTA? Provide a brief, step-by-step answer suitable for SMS (under 300 characters). Include specific route numbers and estimated time if possible.`;

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
      });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [
          {
            googleSearch: {},
          },
        ],
      });

      let directions = result.response.text();

      // Truncate if too long for SMS
      if (directions.length > 300) {
        directions = directions.substring(0, 297) + '...';
      }

      return directions;
    } catch (error) {
      logger.error('Error handling transit directions:', error);
      return 'Sorry, could not get directions. Please try again.';
    }
  }

  /**
   * Handle favorites query
   */
  static async handleFavorites(userId: string): Promise<string> {
    try {
      const favorites = await FavoriteService.getUserFavorites(userId);

      if (favorites.length === 0) {
        return 'You have no favorites saved. Add some via the app!';
      }

      let message = 'Your Favorites:\n\n';

      for (const favorite of favorites.slice(0, 3)) {
        let arrivals;

        if (favorite.routeType === 'TRAIN' && favorite.stationId) {
          arrivals = await CTAService.getTrainArrivals(
            favorite.stationId,
            favorite.routeId
          );
        } else if (favorite.routeType === 'BUS' && favorite.stopId) {
          arrivals = await CTAService.getBusPredictions(
            favorite.stopId,
            favorite.routeId,
            2
          );
        }

        message += `${favorite.routeId}: `;

        if (arrivals && arrivals.length > 0) {
          const times = arrivals
            .slice(0, 2)
            .map((a) => `${a.minutesAway}min`)
            .join(', ');
          message += times;
        } else {
          message += 'No arrivals';
        }

        message += '\n';
      }

      message += '\nText route number for details.';

      return message;
    } catch (error) {
      logger.error('Error handling favorites:', error);
      return 'Sorry, could not fetch favorites. Please try again.';
    }
  }

  /**
   * Process natural language SMS query
   */
  static async processQuery(userId: string, query: string): Promise<string> {
    try {
      // Parse the query
      const parsed = await this.parseQuery(query);

      logger.info(`Parsed intent: ${parsed.intent}`, parsed);

      // Handle based on intent
      switch (parsed.intent) {
        case 'route_arrivals':
          if (!parsed.routeNumber) {
            return 'Please specify a route number (e.g., "157" or "Blue Line").';
          }
          return await this.handleRouteArrivals(userId, parsed.routeNumber);

        case 'find_stops':
          if (!parsed.routeNumber || !parsed.location) {
            return 'Please specify both a route number and location.';
          }
          return await this.handleFindStops(parsed.routeNumber, parsed.location);

        case 'transit_directions':
          if (!parsed.origin || !parsed.destination) {
            return 'Please specify both origin and destination.';
          }
          return await this.handleTransitDirections(parsed.origin, parsed.destination);

        case 'favorites':
          return await this.handleFavorites(userId);

        default:
          return 'I didn\'t understand that. Try:\n- Route number (e.g., "157")\n- "Find stops near [location]"\n- "How do I get to [place]?"\n- "favorites"';
      }
    } catch (error) {
      logger.error('Error processing SMS query:', error);
      return 'Sorry, something went wrong. Please try again.';
    }
  }

  /**
   * Format arrivals for SMS (compact format)
   */
  private static formatArrivalsForSMS(arrivals: any[], title: string): string {
    if (arrivals.length === 0) {
      return `${title}\n\nNo arrivals found.`;
    }

    let message = `${title}\n\n`;

    arrivals.slice(0, 3).forEach((arrival, index) => {
      const flags = [];
      if (arrival.isApproaching) flags.push('⚡');
      if (arrival.isDelayed) flags.push('⏱️');

      const status = flags.length > 0 ? ` ${flags.join('')}` : '';
      message += `${index + 1}. ${arrival.destination}\n`;
      message += `   ${arrival.minutesAway} min${status}\n`;
    });

    return message.trim();
  }
}
