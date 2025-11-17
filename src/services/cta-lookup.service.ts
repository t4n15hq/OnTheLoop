import axios from 'axios';
import config from '../config';
import logger from '../utils/logger';
import { CacheService } from './cache.service';

const CTA_TRAIN_API_BASE = 'http://lapi.transitchicago.com/api/1.0';
const CTA_BUS_API_BASE = 'http://www.ctabustracker.com/bustime/api/v2';

interface BusRoute {
  rt: string;
  rtnm: string;
  rtclr: string;
}

interface BusStop {
  stpid: string;
  stpnm: string;
  lat: number;
  lon: number;
}

interface BusDirection {
  dir: string;
}

interface TrainStation {
  station_id: string;
  station_name: string;
}

/**
 * Service for looking up CTA routes, stops, and stations
 */
export class CTALookupService {
  /**
   * Get all available bus routes
   */
  static async getBusRoutes(): Promise<BusRoute[]> {
    try {
      const cacheKey = 'bus-routes-all';
      const cached = await CacheService.get<BusRoute[]>(cacheKey);
      if (cached) {
        logger.debug('Bus routes cache hit');
        return cached;
      }

      const response = await axios.get(`${CTA_BUS_API_BASE}/getroutes`, {
        params: {
          key: config.cta.busApiKey,
          format: 'json',
        },
      });

      const routes = response.data['bustime-response']?.routes || [];

      // Cache for 24 hours (routes don't change often)
      await CacheService.set(cacheKey, routes, 86400);

      return routes;
    } catch (error) {
      logger.error('Error fetching bus routes:', error);
      throw error;
    }
  }

  /**
   * Get directions for a specific bus route
   */
  static async getBusDirections(routeId: string): Promise<string[]> {
    try {
      const cacheKey = CacheService.generateKey('bus-directions', routeId);
      const cached = await CacheService.get<string[]>(cacheKey);
      if (cached) {
        return cached;
      }

      const response = await axios.get(`${CTA_BUS_API_BASE}/getdirections`, {
        params: {
          key: config.cta.busApiKey,
          rt: routeId,
          format: 'json',
        },
      });

      const directions = response.data['bustime-response']?.directions || [];
      const dirList = directions.map((d: BusDirection) => d.dir);

      // Cache for 24 hours
      await CacheService.set(cacheKey, dirList, 86400);

      return dirList;
    } catch (error) {
      logger.error(`Error fetching directions for route ${routeId}:`, error);
      throw error;
    }
  }

  /**
   * Get all stops for a specific bus route and direction
   */
  static async getBusStops(routeId: string, direction: string): Promise<BusStop[]> {
    try {
      const cacheKey = CacheService.generateKey('bus-stops', routeId, direction);
      const cached = await CacheService.get<BusStop[]>(cacheKey);
      if (cached) {
        return cached;
      }

      const response = await axios.get(`${CTA_BUS_API_BASE}/getstops`, {
        params: {
          key: config.cta.busApiKey,
          rt: routeId,
          dir: direction,
          format: 'json',
        },
      });

      const stops = response.data['bustime-response']?.stops || [];

      // Cache for 24 hours
      await CacheService.set(cacheKey, stops, 86400);

      return stops;
    } catch (error) {
      logger.error(`Error fetching stops for route ${routeId}:`, error);
      throw error;
    }
  }

  /**
   * Search for stops near a location (by coordinates)
   * This is useful for "find stops near me" functionality
   */
  static async findNearbyStops(
    routeId: string,
    direction: string,
    userLat: number,
    userLon: number,
    radiusMiles: number = 0.5
  ): Promise<Array<BusStop & { distance: number }>> {
    try {
      const stops = await this.getBusStops(routeId, direction);

      // Calculate distance using Haversine formula
      const stopsWithDistance = stops.map((stop) => {
        const distance = this.calculateDistance(
          userLat,
          userLon,
          stop.lat,
          stop.lon
        );

        return {
          ...stop,
          distance,
        };
      });

      // Filter by radius and sort by distance
      return stopsWithDistance
        .filter((stop) => stop.distance <= radiusMiles)
        .sort((a, b) => a.distance - b.distance);
    } catch (error) {
      logger.error('Error finding nearby stops:', error);
      throw error;
    }
  }

  /**
   * Calculate distance between two coordinates in miles
   * Using Haversine formula
   */
  private static calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 3959; // Earth's radius in miles
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private static toRad(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }

  /**
   * Search stops by name (fuzzy search)
   */
  static async searchStopsByName(
    routeId: string,
    direction: string,
    searchTerm: string
  ): Promise<BusStop[]> {
    try {
      const stops = await this.getBusStops(routeId, direction);
      const searchLower = searchTerm.toLowerCase();

      return stops.filter((stop) =>
        stop.stpnm.toLowerCase().includes(searchLower)
      );
    } catch (error) {
      logger.error('Error searching stops:', error);
      throw error;
    }
  }

  /**
   * Get all train lines (static data)
   */
  static getTrainLines() {
    return [
      { route: 'Red', name: 'Red Line', color: '#c60c30' },
      { route: 'Blue', name: 'Blue Line', color: '#00a1de' },
      { route: 'Brn', name: 'Brown Line', color: '#62361b' },
      { route: 'G', name: 'Green Line', color: '#009b3a' },
      { route: 'Org', name: 'Orange Line', color: '#f9461c' },
      { route: 'P', name: 'Purple Line', color: '#522398' },
      { route: 'Pink', name: 'Pink Line', color: '#e27ea6' },
      { route: 'Y', name: 'Yellow Line', color: '#f9e300' },
    ];
  }

  /**
   * Get all train stations (you would typically load this from CTA's station list)
   * This is a helper method - in production you'd want to fetch this from CTA or maintain a database
   */
  static async getTrainStations(line?: string): Promise<TrainStation[]> {
    // This is a simplified version. In production, you'd want to:
    // 1. Maintain a database of all stations
    // 2. Or fetch from CTA's station list API/file
    // 3. Include coordinates for location-based search

    const cacheKey = line ? `train-stations-${line}` : 'train-stations-all';
    const cached = await CacheService.get<TrainStation[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // For now, return a message that this needs to be implemented
    logger.warn('Train stations lookup not yet implemented - returning empty array');
    return [];
  }
}
