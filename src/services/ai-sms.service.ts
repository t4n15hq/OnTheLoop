import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import config from '../config';
import logger from '../utils/logger';
import { CTALookupService } from './cta-lookup.service';
import { GeminiMapsService } from './gemini-maps.service';

interface ParsedSMSQuery {
  intent: 'route_arrivals' | 'find_stops' | 'transit_directions' | 'favorites' | 'unknown';
  routeNumber?: string;
  location?: string;
  stopId?: string;
  origin?: string;
  destination?: string;
}

// Per-Gemini-call timeouts. Prevents any single slow upstream from hanging
// the chat endpoint indefinitely. Budgets picked so total request time
// stays under ~35s on the slowest path.
const PARSE_QUERY_TIMEOUT_MS = 6_000;
const PARSE_CONFIG_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Gemini-backed AI parse layer for transit queries.
 *
 * The natural-language orchestration (intent → match → enrich → format) now
 * lives in the shared `services/assistant` pipeline (#49). This class is the
 * reduced parse shim that pipeline — and the web "Magic Fill" endpoint — call
 * into: `parseQuery` classifies intent + slots for the assistant, and
 * `parseRouteConfig` resolves a full route config for the web app.
 */
export class AISMSService {
  private static genAI = new GoogleGenerativeAI(config.google.geminiApiKey);

  /**
   * Parse natural language route configuration for "Magic Fill"
   */
  static async parseRouteConfig(query: string): Promise<any> {
    try {
      logger.info(`Parsing route config (queryLength=${query.length})`);

      // 1. Ask Gemini to extract intent and addresses with detailed instructions
      const model = this.genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
      const prompt = `You are a Chicago CTA transit expert. Analyze this query: "${query}"

Your task is to determine if this is:
A) An address-to-address trip (e.g., "1029 S Lytle to 820 S Wolcott")
B) A station/stop name trip (e.g., "Red Line from Howard to Loop")
C) A mixed query (e.g., "157 from Taylor & Racine")

IMPORTANT DISTINCTIONS:
- ADDRESSES have street numbers (e.g., "1029 S Lytle", "820 S Wolcott")
- STATION/STOP NAMES are landmarks or intersections WITHOUT numbers (e.g., "Howard", "Loop", "Taylor & Racine")

CTA SYSTEM KNOWLEDGE:
- TRAINS: Red, Blue, Brown, Green, Orange, Pink, Purple, Yellow (always capitalize)
- BUSES: Route numbers only (e.g., "157", "60", "147")
- Directions: Northbound, Southbound, Eastbound, Westbound (use full words)
- Common stations: Howard, 95th, O'Hare, Forest Park, Loop, Midway, etc.

CRITICAL: For routeHint, return ONLY the color name or number:
- CORRECT: "Blue", "Red", "157"
- WRONG: "Blue Line", "Red Line", "Bus 157"

COMMON ROUTE ORIENTATIONS (Use these to infer direction if ambiguous):
- Route 157 (Streeterville/Taylor): Runs Eastbound/Westbound (NOT North/South)
- Route 60 (Blue Island/26th): Runs Northbound/Southbound (mostly)
- Red Line: Northbound/Southbound
- Blue Line: Northbound (to O'Hare), Southbound (to Forest Park) - even though it runs diagonal

EXAMPLES:
1. "Red Line from Howard to Loop"
   → isAddressToAddress: false, routeHint: "Red", originAddress: null, destinationAddress: null

2. "1029 S Lytle to 820 S Wolcott"
   → isAddressToAddress: true, routeHint: null (you'll infer the route), originAddress: "1029 S Lytle, Chicago, IL", destinationAddress: "820 S Wolcott, Chicago, IL"

3. "157 bus from Taylor & Racine to Polk & Wolcott"
   → isAddressToAddress: false, routeHint: "157", directionHint: "Westbound", originAddress: null, destinationAddress: null
   (Since 157 is East/West and Taylor/Racine -> Polk/Wolcott is Westward)

4. "Blue Line to O'Hare from downtown"
   → isAddressToAddress: false, routeHint: "Blue", directionHint: "Northbound", originAddress: null, destinationAddress: null

Respond ONLY with JSON:
{
  "isAddressToAddress": boolean,
  "originAddress": "full address with city/state if detected, or null",
  "destinationAddress": "full address with city/state if detected, or null", 
  "routeHint": "route number or train color, or null if not mentioned",
  "directionHint": "Northbound/Southbound/Eastbound/Westbound or null"
}

BE CONSERVATIVE: If you're unsure whether something is an address, assume it's a station/stop name.`;

      const result = await withTimeout(
        model.generateContent(prompt),
        PARSE_CONFIG_TIMEOUT_MS,
        'parseRouteConfig(primary)'
      );
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (!jsonMatch) return null;
      const analysis = JSON.parse(jsonMatch[0]);

      // Default config structure
      let config = {
        routeType: 'BUS', // Default
        routeId: analysis.routeHint || '',
        direction: analysis.directionHint || '',
        stopName: '',
        alightingName: ''
      };

      // Detect if this is a train route based on routeId
      if (config.routeId) {
        const isTrain = ['Red', 'Blue', 'Brown', 'Green', 'Orange', 'Pink', 'Purple', 'Yellow'].includes(config.routeId);
        if (isTrain) {
          config.routeType = 'TRAIN';
          logger.info(`Detected TRAIN route from routeId: ${config.routeId}`);
        }
      }

      // 2. If it's address-to-address, use real Geocoding + Stop Lookup
      if (analysis.isAddressToAddress && analysis.originAddress) {
        logger.info('Resolving address-to-address route config');

        // Resolve Origin
        const originLoc = await GeminiMapsService.resolveLocation(analysis.originAddress);
        if (originLoc) {
          // Resolve Destination (needed for direction inference)
          let destLoc = null;
          if (analysis.destinationAddress) {
            destLoc = await GeminiMapsService.resolveLocation(analysis.destinationAddress);
            if (destLoc) {
              config.alightingName = destLoc.address;
            }
          }

          // Infer Direction geometrically if we have both points
          if (!config.direction && destLoc) {
            const dLat = destLoc.coordinates.lat - originLoc.coordinates.lat;
            const dLon = destLoc.coordinates.lon - originLoc.coordinates.lon;

            if (Math.abs(dLat) > Math.abs(dLon)) {
              // Moving primarily North/South
              config.direction = dLat > 0 ? 'Northbound' : 'Southbound';
            } else {
              // Moving primarily East/West
              config.direction = dLon > 0 ? 'Eastbound' : 'Westbound';
            }
            logger.info(`Inferred direction: ${config.direction}`);
          }

          // If we have a route hint, look for stops on that route
          if (config.routeId) {
            // Import here to avoid circular dep issues if any
            const { CTALookupService } = await import('./cta-lookup.service');

            const isTrain = ['Red', 'Blue', 'Brown', 'Green', 'Orange', 'Pink', 'Purple', 'Yellow'].includes(config.routeId);
            config.routeType = isTrain ? 'TRAIN' : 'BUS';

            if (!isTrain) {
              // 1. Validate and snap to official CTA direction
              const validDirs = await CTALookupService.getBusDirections(config.routeId);
              let searchDir = config.direction || 'Eastbound';

              // Check if our inferred direction is actually valid for this route
              const match = validDirs.find(d => d.toLowerCase().startsWith(searchDir.toLowerCase().substring(0, 4)));

              if (match) {
                searchDir = match;
              } else {
                // Our inferred direction (e.g. North) isn't valid for this route (e.g. runs East/West)
                // Let's try to map it using the secondary vector component
                logger.info(`Inferred direction ${searchDir} not valid for route ${config.routeId} (Valid: ${validDirs.join(', ')}). Re-evaluating...`);

                if (destLoc) { // We need destLoc to re-calc
                  const dLat = destLoc.coordinates.lat - originLoc.coordinates.lat;
                  const dLon = destLoc.coordinates.lon - originLoc.coordinates.lon;

                  const hasEastWest = validDirs.some(d => d.includes('East') || d.includes('West'));
                  const hasNorthSouth = validDirs.some(d => d.includes('North') || d.includes('South'));

                  if (hasEastWest && !hasNorthSouth) {
                    // Route is strictly East/West, map to that
                    searchDir = dLon > 0 ? 'Eastbound' : 'Westbound';
                  } else if (hasNorthSouth && !hasEastWest) {
                    // Route is strictly North/South, map to that
                    searchDir = dLat > 0 ? 'Northbound' : 'Southbound';
                  } else if (validDirs.length > 0) {
                    // Fallback to first valid direction
                    searchDir = validDirs[0];
                  }

                  // Snap to exact string
                  const newMatch = validDirs.find(d => d.toLowerCase().startsWith(searchDir.toLowerCase().substring(0, 4)));
                  if (newMatch) searchDir = newMatch;
                }
              }

              config.direction = searchDir;
              logger.info(`Final resolved direction: ${config.direction}`);

              // 2. Find boarding stop - trust pure distance calculation
              const stops = await CTALookupService.findNearbyStops(
                config.routeId,
                searchDir,
                originLoc.coordinates.lat,
                originLoc.coordinates.lon,
                0.5 // Search within 0.5 miles
              );

              if (stops && stops.length > 0) {
                // Simply pick the closest stop - stops are already sorted by distance
                config.stopName = stops[0].stpnm;
                logger.info(`Selected boarding stop: ${config.stopName} (${stops[0].distance.toFixed(3)}mi away)`);

                // Log top 3 for debugging
                if (stops.length > 1) {
                  const alternatives = stops.slice(1, 3).map(s => `${s.stpnm} (${s.distance.toFixed(3)}mi)`).join(', ');
                  logger.info(`Other nearby stops: ${alternatives}`);
                }
              }

              // 3. Find alighting stop (destination)
              if (destLoc) {
                const destStops = await CTALookupService.findNearbyStops(
                  config.routeId,
                  searchDir,
                  destLoc.coordinates.lat,
                  destLoc.coordinates.lon,
                  0.5
                );

                if (destStops && destStops.length > 0) {
                  config.alightingName = destStops[0].stpnm;
                  logger.info(`Selected alighting stop: ${config.alightingName} (${destStops[0].distance.toFixed(3)}mi away)`);
                }
              }
            }
          }
        }
      } else {
        // 3. For station/stop name queries, infer direction FIRST before fallback
        if (analysis.routeHint && !analysis.directionHint) {
          const isTrain = ['Red', 'Blue', 'Brown', 'Green', 'Orange', 'Pink', 'Purple', 'Yellow'].includes(analysis.routeHint);
          if (isTrain) {
            const queryLower = query.toLowerCase();

            // Blue Line specific: O'Hare is "Northbound", Forest Park is "Southbound" in the dropdown
            if (analysis.routeHint === 'Blue') {
              if (queryLower.includes('to ohare') || queryLower.includes("to o'hare") || queryLower.includes('ohare')) {
                config.direction = 'Northbound'; // O'Hare direction
                logger.info(`Inferred Northbound direction for Blue Line to O'Hare`);
              } else if (queryLower.includes('to forest park') || queryLower.includes('forest park')) {
                config.direction = 'Southbound'; // Forest Park direction
                logger.info(`Inferred Southbound direction for Blue Line to Forest Park`);
              }
            } else {
              // Generic inference for other lines
              if (queryLower.includes('to 95th') || queryLower.includes('95th') || queryLower.includes('ninety')) {
                config.direction = 'Southbound';
                logger.info(`Inferred Southbound direction from 95th destination`);
              } else if (queryLower.includes('to howard') || queryLower.includes('howard')) {
                config.direction = 'Northbound';
                logger.info(`Inferred Northbound direction from Howard destination`);
              } else if (queryLower.includes('loop') || queryLower.includes('downtown')) {
                logger.info(`Loop/Downtown detected - direction ambiguous`);
              }
            }
          }
        }

        // Update the config with the inferred direction
        if (config.direction && !analysis.directionHint) {
          analysis.directionHint = config.direction;
        }
      }

      // 4. Fallback: If no stop name was found, ask Gemini for the standard JSON
      if (!config.stopName) {
        logger.info('Calling fallback AI for route config');
        const prompt2 = `Extract CTA route configuration from: "${query}"
         Respond ONLY with JSON:
         {
           "routeType": "BUS" or "TRAIN",
           "routeId": "Route number or color",
           "direction": "Northbound", "Southbound", "Eastbound", or "Westbound",
           "stopName": "Name of the boarding stop/station",
           "alightingName": "Name of the destination stop/station"
         }`;
        const result2 = await withTimeout(
          model.generateContent(prompt2),
          PARSE_CONFIG_TIMEOUT_MS,
          'parseRouteConfig(fallback)'
        );
        const text2 = result2.response.text();
        const jsonMatch2 = text2.match(/\{[\s\S]*\}/);
        if (jsonMatch2) {
          const fallbackConfig = JSON.parse(jsonMatch2[0]);
          logger.info('Fallback AI returned route config');

          // Save the inferred direction before merge - THIS IS SACRED
          const inferredDirection = config.direction;

          // Merge: Keep existing values, only fill in what's missing
          config = {
            routeType: config.routeType || fallbackConfig.routeType,
            routeId: config.routeId || fallbackConfig.routeId,
            direction: inferredDirection || fallbackConfig.direction, // ALWAYS prefer inferred
            stopName: fallbackConfig.stopName || config.stopName,
            alightingName: config.alightingName || fallbackConfig.alightingName
          };

          // Double-check: If we had an inferred direction, force it
          if (inferredDirection) {
            config.direction = inferredDirection;
            logger.info(`Forced inferred direction: ${inferredDirection} (fallback tried to use: ${fallbackConfig.direction})`);
          }

          logger.info(
            `After merge. Final config routeType=${config.routeType} routeId=${config.routeId} direction=${config.direction} hasStop=${Boolean(config.stopName)} hasAlighting=${Boolean(config.alightingName)}`
          );
        }
      }

      return config;
    } catch (error) {
      logger.error('Error parsing route config:', error);
      return null;
    }
  }

  /**
   * Parse natural language SMS query to determine intent and extract parameters
   */
  static async parseQuery(query: string): Promise<ParsedSMSQuery> {
    try {
      logger.info(`Parsing SMS query (queryLength=${query.length})`);

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-flash-latest',
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
        ],
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

      const result = await withTimeout(
        model.generateContent(prompt),
        PARSE_QUERY_TIMEOUT_MS,
        'parseQuery'
      );
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
      // Timeouts return unknown intent so the controller can fall through to
      // the ungrounded suggestion path instead of hanging.
      logger.warn(`parseQuery failed: ${(error as Error).message}`);
      return { intent: 'unknown' };
    }
  }
}
