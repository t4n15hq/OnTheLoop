import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config';
import logger from '../utils/logger';

export interface LocationResult {
  place_id?: string;
  name: string;
  address: string;
  coordinates: {
    lat: number;
    lon: number;
  };
}

/**
 * Service for using Google Gemini with Maps grounding to resolve locations
 */
export class GeminiMapsService {
  private static genAI = new GoogleGenerativeAI(config.google.geminiApiKey);

  /**
   * Resolve a natural language location query to coordinates
   * Examples:
   * - "coffee shop near Northwestern University"
   * - "123 Main St, Chicago"
   * - "Willis Tower"
   * - "my office at Google Chicago"
   */
  static async resolveLocation(query: string): Promise<LocationResult | null> {
    try {
      logger.info(`Resolving location: ${query}`);

      // Use Gemini Flash with Google Search grounding
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
      });

      // Create a prompt that asks for location information
      const prompt = `Find the location for: "${query}".

Please provide the exact address and coordinates (latitude and longitude) for this location in Chicago, IL area.
Format your response as:
Name: [location name]
Address: [full address]
Latitude: [latitude]
Longitude: [longitude]`;

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [
          {
            googleSearch: {},
          },
        ],
      });

      const response = result.response;
      const text = response.text();

      logger.debug(`Gemini response: ${text}`);

      // Parse the response to extract coordinates
      const location = this.parseLocationResponse(text);

      if (!location) {
        logger.warn(`Failed to parse location from: ${text}`);
        return null;
      }

      logger.info(
        `Resolved "${query}" to: ${location.name} (${location.coordinates.lat}, ${location.coordinates.lon})`
      );

      return location;
    } catch (error) {
      logger.error('Error resolving location with Gemini:', error);
      throw error;
    }
  }

  /**
   * Parse Gemini's response to extract location information
   */
  private static parseLocationResponse(text: string): LocationResult | null {
    try {
      // Extract name
      const nameMatch = text.match(/Name:\s*(.+?)(?:\n|$)/i);
      const name = nameMatch ? nameMatch[1].trim() : 'Unknown Location';

      // Extract address
      const addressMatch = text.match(/Address:\s*(.+?)(?:\n|$)/i);
      const address = addressMatch ? addressMatch[1].trim() : '';

      // Extract latitude
      const latMatch = text.match(/Latitude:\s*([-\d.]+)/i);
      const lat = latMatch ? parseFloat(latMatch[1]) : null;

      // Extract longitude
      const lonMatch = text.match(/Longitude:\s*([-\d.]+)/i);
      const lon = lonMatch ? parseFloat(lonMatch[1]) : null;

      if (!lat || !lon) {
        return null;
      }

      return {
        name,
        address,
        coordinates: {
          lat,
          lon,
        },
      };
    } catch (error) {
      logger.error('Error parsing Gemini response:', error);
      return null;
    }
  }

  /**
   * Find CTA stops near a natural language location
   * Combines Gemini location resolution with CTA stop lookup
   */
  static async findStopsNearLocation(
    locationQuery: string,
    routeId: string,
    direction: string,
    radiusMiles: number = 0.5
  ): Promise<{
    location: LocationResult;
    stops: any[];
  } | null> {
    try {
      // First, resolve the location using Gemini
      const location = await this.resolveLocation(locationQuery);

      if (!location) {
        throw new Error(`Could not resolve location: ${locationQuery}`);
      }

      // Import CTALookupService here to avoid circular dependency
      const { CTALookupService } = await import('./cta-lookup.service');

      // Find nearby stops
      const stops = await CTALookupService.findNearbyStops(
        routeId,
        direction,
        location.coordinates.lat,
        location.coordinates.lon,
        radiusMiles
      );

      return {
        location,
        stops,
      };
    } catch (error) {
      logger.error('Error finding stops near location:', error);
      throw error;
    }
  }

  /**
   * Get transit directions suggestion using natural language
   * Example: "How do I get from Northwestern to Willis Tower using the bus?"
   */
  static async getTransitSuggestion(query: string): Promise<string> {
    try {
      logger.info(`Getting transit suggestion for: ${query}`);

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
      });

      const prompt = `You are a Chicago CTA transit assistant. Answer this question: "${query}"

Focus on CTA trains and buses. Be concise and specific about route numbers and directions.
If the question involves specific locations, include those locations in your response.`;

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [
          {
            googleSearch: {},
          },
        ],
      });

      const response = result.response;
      return response.text();
    } catch (error) {
      logger.error('Error getting transit suggestion:', error);
      throw error;
    }
  }
}
