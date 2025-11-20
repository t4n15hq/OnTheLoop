import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory, SchemaType } from '@google/generative-ai';
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
   * Parse natural language route configuration for "Magic Fill"
   */
  static async parseRouteConfig(query: string): Promise<any> {
    try {
      logger.info(`Parsing route config: ${query}`);

      // 1. Ask Gemini to extract intent and addresses with detailed instructions
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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

      const result = await model.generateContent(prompt);
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
        logger.info(`Resolving addresses: ${analysis.originAddress} -> ${analysis.destinationAddress}`);

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

              const match = validDirs.find(d => d.toLowerCase().startsWith(searchDir.toLowerCase().substring(0, 4)));
              if (match) searchDir = match;
              else if (validDirs.length > 0) searchDir = validDirs[0];

              config.direction = searchDir;

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
        logger.info(`Calling fallback AI. Current config before fallback: ${JSON.stringify(config)}`);
        const prompt2 = `Extract CTA route configuration from: "${query}"
         Respond ONLY with JSON:
         {
           "routeType": "BUS" or "TRAIN",
           "routeId": "Route number or color",
           "direction": "Northbound", "Southbound", "Eastbound", or "Westbound",
           "stopName": "Name of the boarding stop/station",
           "alightingName": "Name of the destination stop/station"
         }`;
        const result2 = await model.generateContent(prompt2);
        const text2 = result2.response.text();
        const jsonMatch2 = text2.match(/\{[\s\S]*\}/);
        if (jsonMatch2) {
          const fallbackConfig = JSON.parse(jsonMatch2[0]);
          logger.info(`Fallback AI returned: ${JSON.stringify(fallbackConfig)}`);

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

          logger.info(`After merge. Final config: ${JSON.stringify(config)}`);
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
      logger.info(`Parsing SMS query: ${query}`);

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
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
   * This is a placeholder for a real Google Search execution.
   * In a real application, you would integrate with a Google Search API
   * and return structured results. For now, it returns a mock string.
   */
  private static async executeGoogleSearch(query: string): Promise<string> {
    logger.info(`Executing mock Google Search for query: "${query}"`);
    // In a real application, you'd call a service like:
    // const searchResults = await GoogleSearchAPI.search(query);
    // return JSON.stringify(searchResults); // Return relevant information

    // For demonstration, let's just return a placeholder.
    // The model might not give good directions without real search results.
    return `[Mock Search Result for "${query}": A detailed search for CTA directions from ${query} would normally be performed here. Please provide real search results from an external API if you want the model to generate accurate directions.]`;
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
      const chat = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
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
      }).startChat({
        tools: [
          {
            functionDeclarations: [
              {
                name: "googleSearch",
                description: "A tool to perform Google searches to find transit information, points of interest, or resolve locations.",
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: {
                    query: {
                      type: SchemaType.STRING,
                      description: "The search query to be executed.",
                    },
                  },
                  required: ["query"],
                },
              },
            ],
          },
        ],
      });


      const prompt = `How do I get from ${origin} to ${destination} using CTA? Provide a brief, step-by-step answer suitable for SMS (under 300 characters). Include specific route numbers and estimated time if possible.`;

      let result = await chat.sendMessage(prompt);
      let response = result.response;

      // Check if the model wants to call a tool
      const functionCall = response.functionCall();
      if (functionCall) {
        const { name, args } = functionCall;
        logger.info(`Model requested tool call: ${name} with args: ${JSON.stringify(args)}`);

        if (name === "googleSearch") {
          const toolResult = await AISMSService.executeGoogleSearch((args as any).query);

          // Send the tool result back to the model
          result = await chat.sendMessage([
            {
              text: prompt, // Re-send the original prompt for context
            },
            {
              functionCall: { name, args },
            },
            {
              functionResponse: {
                name,
                response: {
                  content: toolResult, // Use 'content' for string results or other appropriate key
                },
              },
            },
          ]);
          response = result.response; // Get the new response after tool execution
        } else {
          // Handle unknown tool
          logger.warn(`Unknown tool called: ${name}`);
          return 'Sorry, an unknown tool was requested, and I cannot fulfill this request.';
        }
      }

      let directions = response.text();

      // Truncate if too long for SMS
      if (directions.length > 300) {
        directions = directions.substring(0, 297) + '...';
      } else if (directions.trim().length === 0) {
        // Fallback if model still didn't generate text after tool call (or if no tool call was made but no text was generated)
        return `Sorry, I couldn't find transit directions from ${origin} to ${destination}. Please try rephrasing or check a map.`;
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