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
  map_id: string;
  station_name: string;
  directions: string[]; // e.g., ["1", "5"] for Southbound/Northbound
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
   * Get all train stations for a specific line
   * Data sourced from CTA station list with mapid values
   */
  static async getTrainStations(line?: string): Promise<TrainStation[]> {
    const cacheKey = line ? `train-stations-${line}` : 'train-stations-all';
    const cached = await CacheService.get<TrainStation[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // CTA Train Station Data with mapid values
    const stationData: Record<string, TrainStation[]> = {
      Red: [
        { map_id: '40900', station_name: 'Howard', directions: ['1', '5'] },
        { map_id: '41190', station_name: 'Jarvis', directions: ['1', '5'] },
        { map_id: '40100', station_name: 'Morse', directions: ['1', '5'] },
        { map_id: '41300', station_name: 'Loyola', directions: ['1', '5'] },
        { map_id: '40760', station_name: 'Granville', directions: ['1', '5'] },
        { map_id: '40880', station_name: 'Thorndale', directions: ['1', '5'] },
        { map_id: '41380', station_name: 'Bryn Mawr', directions: ['1', '5'] },
        { map_id: '40340', station_name: 'Berwyn', directions: ['1', '5'] },
        { map_id: '41200', station_name: 'Argyle', directions: ['1', '5'] },
        { map_id: '40770', station_name: 'Lawrence', directions: ['1', '5'] },
        { map_id: '40540', station_name: 'Wilson', directions: ['1', '5'] },
        { map_id: '41490', station_name: 'Sheridan', directions: ['1', '5'] },
        { map_id: '40080', station_name: 'Addison', directions: ['1', '5'] },
        { map_id: '41420', station_name: 'Belmont', directions: ['1', '5'] },
        { map_id: '40650', station_name: 'Fullerton', directions: ['1', '5'] },
        { map_id: '41220', station_name: 'North/Clybourn', directions: ['1', '5'] },
        { map_id: '40800', station_name: 'Clark/Division', directions: ['1', '5'] },
        { map_id: '40330', station_name: 'Chicago', directions: ['1', '5'] },
        { map_id: '41450', station_name: 'Grand', directions: ['1', '5'] },
        { map_id: '40490', station_name: 'Lake', directions: ['1', '5'] },
        { map_id: '40380', station_name: 'Monroe', directions: ['1', '5'] },
        { map_id: '40730', station_name: 'Jackson', directions: ['1', '5'] },
        { map_id: '40560', station_name: 'Harrison', directions: ['1', '5'] },
        { map_id: '41490', station_name: 'Roosevelt', directions: ['1', '5'] },
        { map_id: '40190', station_name: 'Cermak-Chinatown', directions: ['1', '5'] },
        { map_id: '40710', station_name: 'Sox-35th', directions: ['1', '5'] },
        { map_id: '41230', station_name: '47th', directions: ['1', '5'] },
        { map_id: '40990', station_name: 'Garfield', directions: ['1', '5'] },
        { map_id: '41170', station_name: '63rd', directions: ['1', '5'] },
        { map_id: '40910', station_name: '69th', directions: ['1', '5'] },
        { map_id: '40990', station_name: '79th', directions: ['1', '5'] },
        { map_id: '40240', station_name: '87th', directions: ['1', '5'] },
        { map_id: '41430', station_name: '95th/Dan Ryan', directions: ['1', '5'] },
      ],
      Blue: [
        { map_id: '40890', station_name: "O'Hare", directions: ['1', '5'] },
        { map_id: '40820', station_name: 'Rosemont', directions: ['1', '5'] },
        { map_id: '40230', station_name: 'Cumberland', directions: ['1', '5'] },
        { map_id: '40750', station_name: 'Harlem', directions: ['1', '5'] },
        { map_id: '40590', station_name: 'Jefferson Park', directions: ['1', '5'] },
        { map_id: '41280', station_name: 'Montrose', directions: ['1', '5'] },
        { map_id: '40550', station_name: 'Irving Park', directions: ['1', '5'] },
        { map_id: '40060', station_name: 'Addison', directions: ['1', '5'] },
        { map_id: '40670', station_name: 'Belmont', directions: ['1', '5'] },
        { map_id: '40790', station_name: 'Logan Square', directions: ['1', '5'] },
        { map_id: '40980', station_name: 'California', directions: ['1', '5'] },
        { map_id: '40470', station_name: 'Western', directions: ['1', '5'] },
        { map_id: '40090', station_name: 'Damen', directions: ['1', '5'] },
        { map_id: '40570', station_name: 'Division', directions: ['1', '5'] },
        { map_id: '40320', station_name: 'Chicago', directions: ['1', '5'] },
        { map_id: '41410', station_name: 'Grand', directions: ['1', '5'] },
        { map_id: '40390', station_name: 'Clark/Lake', directions: ['1', '5'] },
        { map_id: '40370', station_name: 'Washington', directions: ['1', '5'] },
        { map_id: '40790', station_name: 'Monroe', directions: ['1', '5'] },
        { map_id: '40070', station_name: 'Jackson', directions: ['1', '5'] },
        { map_id: '40430', station_name: 'LaSalle', directions: ['1', '5'] },
        { map_id: '40350', station_name: 'Clinton', directions: ['1', '5'] },
        { map_id: '40460', station_name: 'UIC-Halsted', directions: ['1', '5'] },
        { map_id: '40160', station_name: 'Racine', directions: ['1', '5'] },
        { map_id: '40850', station_name: 'Illinois Medical District', directions: ['1', '5'] },
        { map_id: '40920', station_name: 'Western', directions: ['1', '5'] },
        { map_id: '40480', station_name: 'Kedzie-Homan', directions: ['1', '5'] },
        { map_id: '40250', station_name: 'Pulaski', directions: ['1', '5'] },
        { map_id: '40920', station_name: 'Cicero', directions: ['1', '5'] },
        { map_id: '40970', station_name: 'Austin', directions: ['1', '5'] },
        { map_id: '40010', station_name: 'Oak Park', directions: ['1', '5'] },
        { map_id: '40180', station_name: 'Harlem', directions: ['1', '5'] },
        { map_id: '40980', station_name: 'Forest Park', directions: ['1', '5'] },
      ],
      Brown: [
        { map_id: '41290', station_name: 'Kimball', directions: ['1', '5'] },
        { map_id: '41180', station_name: 'Kedzie', directions: ['1', '5'] },
        { map_id: '40870', station_name: 'Francisco', directions: ['1', '5'] },
        { map_id: '41510', station_name: 'Rockwell', directions: ['1', '5'] },
        { map_id: '41500', station_name: 'Western', directions: ['1', '5'] },
        { map_id: '41460', station_name: 'Damen', directions: ['1', '5'] },
        { map_id: '41440', station_name: 'Montrose', directions: ['1', '5'] },
        { map_id: '40090', station_name: 'Irving Park', directions: ['1', '5'] },
        { map_id: '41500', station_name: 'Addison', directions: ['1', '5'] },
        { map_id: '40530', station_name: 'Paulina', directions: ['1', '5'] },
        { map_id: '41000', station_name: 'Southport', directions: ['1', '5'] },
        { map_id: '40660', station_name: 'Belmont', directions: ['1', '5'] },
        { map_id: '40800', station_name: 'Wellington', directions: ['1', '5'] },
        { map_id: '40570', station_name: 'Diversey', directions: ['1', '5'] },
        { map_id: '41320', station_name: 'Fullerton', directions: ['1', '5'] },
        { map_id: '40530', station_name: 'Armitage', directions: ['1', '5'] },
        { map_id: '41500', station_name: 'Sedgwick', directions: ['1', '5'] },
        { map_id: '40800', station_name: 'Chicago', directions: ['1', '5'] },
        { map_id: '40730', station_name: 'Merchandise Mart', directions: ['1', '5'] },
        { map_id: '40380', station_name: 'Washington/Wells', directions: ['1', '5'] },
        { map_id: '40160', station_name: 'Quincy', directions: ['1', '5'] },
        { map_id: '40730', station_name: 'LaSalle/Van Buren', directions: ['1', '5'] },
        { map_id: '40680', station_name: 'Harold Washington Library', directions: ['1', '5'] },
        { map_id: '40370', station_name: 'Adams/Wabash', directions: ['1', '5'] },
        { map_id: '40260', station_name: 'Library', directions: ['1', '5'] },
      ],
      Green: [
        { map_id: '40020', station_name: 'Harlem/Lake', directions: ['1', '5'] },
        { map_id: '41510', station_name: 'Oak Park', directions: ['1', '5'] },
        { map_id: '41160', station_name: 'Ridgeland', directions: ['1', '5'] },
        { map_id: '40610', station_name: 'Austin', directions: ['1', '5'] },
        { map_id: '41510', station_name: 'Central', directions: ['1', '5'] },
        { map_id: '40280', station_name: 'Laramie', directions: ['1', '5'] },
        { map_id: '40700', station_name: 'Cicero', directions: ['1', '5'] },
        { map_id: '40020', station_name: 'Pulaski', directions: ['1', '5'] },
        { map_id: '40300', station_name: 'Conservatory', directions: ['1', '5'] },
        { map_id: '41670', station_name: 'Kedzie', directions: ['1', '5'] },
        { map_id: '41019', station_name: 'California', directions: ['1', '5'] },
        { map_id: '40170', station_name: 'Ashland', directions: ['1', '5'] },
        { map_id: '41510', station_name: 'Morgan', directions: ['1', '5'] },
        { map_id: '40390', station_name: 'Clinton', directions: ['1', '5'] },
        { map_id: '40700', station_name: 'Clark/Lake', directions: ['1', '5'] },
        { map_id: '40260', station_name: 'State/Lake', directions: ['1', '5'] },
        { map_id: '40680', station_name: 'Washington/Wabash', directions: ['1', '5'] },
        { map_id: '40020', station_name: 'Adams/Wabash', directions: ['1', '5'] },
        { map_id: '40670', station_name: 'Roosevelt', directions: ['1', '5'] },
        { map_id: '41270', station_name: 'Cermak-McCormick Place', directions: ['1', '5'] },
        { map_id: '41080', station_name: '35th-Bronzeville-IIT', directions: ['1', '5'] },
        { map_id: '40130', station_name: 'Indiana', directions: ['1', '5'] },
        { map_id: '41260', station_name: '43rd', directions: ['1', '5'] },
        { map_id: '41510', station_name: '47th', directions: ['1', '5'] },
        { map_id: '41140', station_name: '51st', directions: ['1', '5'] },
        { map_id: '40130', station_name: 'Garfield', directions: ['1', '5'] },
        { map_id: '41510', station_name: 'King Drive', directions: ['1', '5'] },
        { map_id: '40510', station_name: 'Cottage Grove', directions: ['1', '5'] },
        { map_id: '40720', station_name: 'Halsted', directions: ['1', '5'] },
        { map_id: '40510', station_name: 'Ashland/63rd', directions: ['1', '5'] },
      ],
      Orange: [
        { map_id: '40930', station_name: 'Midway', directions: ['1', '5'] },
        { map_id: '40960', station_name: 'Pulaski', directions: ['1', '5'] },
        { map_id: '41150', station_name: 'Kedzie', directions: ['1', '5'] },
        { map_id: '40310', station_name: 'Western', directions: ['1', '5'] },
        { map_id: '41060', station_name: '35th/Archer', directions: ['1', '5'] },
        { map_id: '40160', station_name: 'Ashland', directions: ['1', '5'] },
        { map_id: '40930', station_name: 'Halsted', directions: ['1', '5'] },
        { map_id: '40670', station_name: 'Roosevelt', directions: ['1', '5'] },
        { map_id: '40850', station_name: 'Harold Washington Library', directions: ['1', '5'] },
        { map_id: '40120', station_name: 'LaSalle/Van Buren', directions: ['1', '5'] },
        { map_id: '40680', station_name: 'Quincy', directions: ['1', '5'] },
        { map_id: '40730', station_name: 'Washington/Wells', directions: ['1', '5'] },
        { map_id: '40260', station_name: 'Clark/Lake', directions: ['1', '5'] },
        { map_id: '40680', station_name: 'State/Lake', directions: ['1', '5'] },
        { map_id: '40730', station_name: 'Randolph/Wabash', directions: ['1', '5'] },
        { map_id: '40680', station_name: 'Madison/Wabash', directions: ['1', '5'] },
        { map_id: '40020', station_name: 'Adams/Wabash', directions: ['1', '5'] },
      ],
      Pink: [
        { map_id: '40580', station_name: '54th/Cermak', directions: ['1', '5'] },
        { map_id: '40420', station_name: 'Cicero', directions: ['1', '5'] },
        { map_id: '40600', station_name: 'Kostner', directions: ['1', '5'] },
        { map_id: '40130', station_name: 'Pulaski', directions: ['1', '5'] },
        { map_id: '40030', station_name: 'Central Park', directions: ['1', '5'] },
        { map_id: '40170', station_name: 'Kedzie', directions: ['1', '5'] },
        { map_id: '40440', station_name: 'California', directions: ['1', '5'] },
        { map_id: '40210', station_name: 'Western', directions: ['1', '5'] },
        { map_id: '40830', station_name: 'Damen', directions: ['1', '5'] },
        { map_id: '40170', station_name: '18th', directions: ['1', '5'] },
        { map_id: '40410', station_name: 'Polk', directions: ['1', '5'] },
        { map_id: '40170', station_name: 'Ashland', directions: ['1', '5'] },
        { map_id: '40510', station_name: 'Morgan', directions: ['1', '5'] },
        { map_id: '40390', station_name: 'Clinton', directions: ['1', '5'] },
        { map_id: '40680', station_name: 'Clark/Lake', directions: ['1', '5'] },
        { map_id: '40260', station_name: 'State/Lake', directions: ['1', '5'] },
        { map_id: '40680', station_name: 'Washington/Wabash', directions: ['1', '5'] },
        { map_id: '40020', station_name: 'Adams/Wabash', directions: ['1', '5'] },
        { map_id: '40850', station_name: 'Harold Washington Library', directions: ['1', '5'] },
        { map_id: '40120', station_name: 'LaSalle/Van Buren', directions: ['1', '5'] },
      ],
      Purple: [
        { map_id: '40400', station_name: 'Linden', directions: ['1', '5'] },
        { map_id: '41320', station_name: 'Central', directions: ['1', '5'] },
        { map_id: '40520', station_name: 'Noyes', directions: ['1', '5'] },
        { map_id: '40050', station_name: 'Foster', directions: ['1', '5'] },
        { map_id: '41250', station_name: 'Davis', directions: ['1', '5'] },
        { map_id: '40690', station_name: 'Dempster', directions: ['1', '5'] },
        { map_id: '40270', station_name: 'Main', directions: ['1', '5'] },
        { map_id: '40400', station_name: 'South Boulevard', directions: ['1', '5'] },
        { map_id: '40900', station_name: 'Howard', directions: ['1', '5'] },
      ],
      Yellow: [
        { map_id: '40140', station_name: 'Dempster-Skokie', directions: ['1', '5'] },
        { map_id: '40900', station_name: 'Oakton-Skokie', directions: ['1', '5'] },
      ],
    };

    const stations = line ? stationData[line] || [] : Object.values(stationData).flat();

    // Cache for 24 hours (stations don't change often)
    await CacheService.set(cacheKey, stations, 86400);

    return stations;
  }
}
