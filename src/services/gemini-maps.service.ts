import { GoogleGenAI, Tool } from '@google/genai';
import config from '../config';
import logger from '../utils/logger';

export interface LocationResult {
  name: string;
  address: string;
  coordinates: {
    lat: number;
    lon: number;
  };
  placeId?: string;
  mapsUri?: string;
}

// Maps grounding tool. Anchors model output to real Google Maps data so we
// get verified addresses/coordinates instead of hallucinations from training.
const MAPS_TOOL: Tool = { googleMaps: {} };
// Search grounding. Better for routing/trip-planning questions where the
// answer lives in web content (CTA route maps, transit suggestions) rather
// than in a single place lookup. Maps grounding alone often refuses these.
const SEARCH_TOOL: Tool = { googleSearch: {} };
// Always use the current Flash model — Google rotates this alias as new
// versions (Gemini 3, 3.1, …) become GA. Keeps us off preview-only IDs.
const MODEL = 'gemini-flash-latest';

export class GeminiMapsService {
  private static ai = new GoogleGenAI({ apiKey: config.google.geminiApiKey });

  /**
   * Resolve a natural language location query to coordinates via Gemini + Google Maps grounding.
   * Examples: "Willis Tower", "123 N Main St Chicago", "coffee shop near Northwestern".
   */
  static async resolveLocation(query: string): Promise<LocationResult | null> {
    logger.info(`Resolving location via Maps grounding: ${query}`);

    const prompt =
      `Find the single best location in the Chicago, IL area for: "${query}".\n\n` +
      `Use Google Maps to look up the place. Respond in EXACTLY this format, nothing else:\n` +
      `Name: <name>\n` +
      `Address: <full street address>\n` +
      `Latitude: <decimal latitude>\n` +
      `Longitude: <decimal longitude>`;

    try {
      const response = await this.ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { tools: [MAPS_TOOL] },
      });

      const text = response.text ?? '';
      const parsed = this.parseLocationResponse(text);
      if (!parsed) {
        logger.warn(`Failed to parse location from Gemini response: ${text.slice(0, 200)}`);
        return null;
      }

      // Pull the first Maps grounding chunk (if any) to enrich placeId/uri.
      const mapsChunk = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.find(
        (c) => c.maps
      )?.maps;

      const result: LocationResult = {
        ...parsed,
        placeId: mapsChunk?.placeId,
        mapsUri: mapsChunk?.uri,
      };

      logger.info(
        `Resolved "${query}" → ${result.name} @ (${result.coordinates.lat}, ${result.coordinates.lon})`
      );
      return result;
    } catch (err) {
      logger.error('Gemini Maps grounding failed:', err);
      throw err;
    }
  }

  private static parseLocationResponse(text: string): Omit<LocationResult, 'placeId' | 'mapsUri'> | null {
    const nameMatch = text.match(/Name:\s*(.+?)(?:\n|$)/i);
    const addressMatch = text.match(/Address:\s*(.+?)(?:\n|$)/i);
    const latMatch = text.match(/Latitude:\s*([-\d.]+)/i);
    const lonMatch = text.match(/Longitude:\s*([-\d.]+)/i);

    const lat = latMatch ? parseFloat(latMatch[1]) : NaN;
    const lon = lonMatch ? parseFloat(lonMatch[1]) : NaN;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // Chicagoland sanity-check: reject outputs far outside the metro area.
    if (lat < 41 || lat > 43 || lon < -89 || lon > -86) {
      logger.warn(`Gemini returned coords outside Chicagoland: (${lat}, ${lon})`);
      return null;
    }

    return {
      name: nameMatch ? nameMatch[1].trim() : 'Unknown Location',
      address: addressMatch ? addressMatch[1].trim() : '',
      coordinates: { lat, lon },
    };
  }

  /**
   * Find CTA stops near a natural-language location. Resolves the location via
   * Maps grounding, then hands the coords to the CTA lookup service.
   */
  static async findStopsNearLocation(
    locationQuery: string,
    routeId: string,
    direction: string,
    radiusMiles: number = 0.5
  ): Promise<{ location: LocationResult; stops: any[] } | null> {
    const location = await this.resolveLocation(locationQuery);
    if (!location) throw new Error(`Could not resolve location: ${locationQuery}`);

    const { CTALookupService } = await import('./cta-lookup.service');
    const stops = await CTALookupService.findNearbyStops(
      routeId,
      direction,
      location.coordinates.lat,
      location.coordinates.lon,
      radiusMiles
    );
    return { location, stops };
  }

  /**
   * Ask a natural-language CTA transit question, grounded in Google Maps.
   * Example: "How do I get from Northwestern to Willis Tower on the CTA?"
   */
  static async getTransitSuggestion(query: string): Promise<string> {
    logger.info(`Transit suggestion: ${query}`);

    // For trip-planning questions we resolve the endpoints (when present) to
    // real coordinates via Maps grounding, then feed those to a second call
    // that uses Search grounding for the actual routing answer. Maps-only
    // grounding tends to refuse routing questions; Search-only can hallucinate
    // street addresses. Combining them gives grounded endpoints + grounded
    // routing advice.
    const endpoints = await this.extractEndpoints(query);

    const systemGuidance =
      `You are a Chicago CTA transit assistant. A rider asked a trip-planning ` +
      `question. Answer in under 150 words with:\n` +
      `1) Walk to the nearest CTA stop/station (name it)\n` +
      `2) Which CTA bus route number(s) or train line color(s) to take, and direction\n` +
      `3) Where to transfer (if needed) and where to get off\n` +
      `4) Walk from the final stop to the destination\n` +
      `Prefer CTA over Metra/Pace unless walking distance is absurd. ` +
      `Never refuse — give your best-guess route with the given endpoints. ` +
      `Use plain text, one step per line, emoji OK.`;

    let contextBlock = '';
    if (endpoints) {
      contextBlock =
        `\n\nResolved endpoints (use these exact coordinates):\n` +
        `• Origin: ${endpoints.origin.name} — ${endpoints.origin.address} ` +
        `(${endpoints.origin.coordinates.lat}, ${endpoints.origin.coordinates.lon})\n` +
        `• Destination: ${endpoints.destination.name} — ${endpoints.destination.address} ` +
        `(${endpoints.destination.coordinates.lat}, ${endpoints.destination.coordinates.lon})`;
    }

    const prompt = `${systemGuidance}${contextBlock}\n\nRider question: "${query}"`;

    try {
      const response = await this.ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { tools: [SEARCH_TOOL] },
      });
      const text = response.text ?? '';
      if (text.trim()) return text;
      // Retry once without grounding if the grounded model refused or returned empty.
      logger.warn('Transit suggestion returned empty with Search grounding; retrying plain.');
      const retry = await this.ai.models.generateContent({
        model: MODEL,
        contents: prompt,
      });
      return retry.text ?? '';
    } catch (err) {
      logger.error('Gemini transit suggestion failed:', err);
      throw err;
    }
  }

  /**
   * Pull "from X to Y" endpoints out of a trip-planning query and resolve both
   * via Maps grounding. Returns null if the query doesn't look like a trip.
   */
  private static async extractEndpoints(
    query: string
  ): Promise<{ origin: LocationResult; destination: LocationResult } | null> {
    // Cheap regex first so we don't burn an extra Gemini call on simple questions.
    const m = query.match(/from\s+(.+?)\s+to\s+(.+?)(?:[?.!]|$)/i);
    if (!m) return null;
    const [, rawOrigin, rawDest] = m;
    try {
      const [origin, destination] = await Promise.all([
        this.resolveLocation(rawOrigin.trim()),
        this.resolveLocation(rawDest.trim()),
      ]);
      if (!origin || !destination) return null;
      return { origin, destination };
    } catch (err) {
      logger.warn('Endpoint resolution for transit suggestion failed:', err);
      return null;
    }
  }
}
