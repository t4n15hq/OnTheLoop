import axios from 'axios';
import config from '../config';
import logger from '../utils/logger';
import {
  CTATrainResponse,
  CTABusResponse,
  FormattedArrival,
} from '../types/cta.types';
import { CacheService } from './cache.service';

const CTA_TRAIN_API_BASE = 'http://lapi.transitchicago.com/api/1.0';
const CTA_BUS_API_BASE = 'http://www.ctabustracker.com/bustime/api/v2';

export class CTAService {
  /**
   * Get train arrivals for a specific station
   * @param stationId - CTA station ID (e.g., "40380" for Jackson Blue Line)
   * @param routeCode - Optional route filter (e.g., "Blue", "Red")
   */
  static async getTrainArrivals(
    stationId: string,
    routeCode?: string
  ): Promise<FormattedArrival[]> {
    try {
      // Generate cache key
      const cacheKey = CacheService.generateKey(
        'train',
        stationId,
        routeCode || 'all'
      );

      // Check cache first
      const cached = await CacheService.get<FormattedArrival[]>(cacheKey);
      if (cached) {
        logger.debug(`Train arrivals cache hit for ${stationId}`);
        return cached;
      }

      const params: any = {
        key: config.cta.trainApiKey,
        mapid: stationId,
        outputType: 'JSON',
      };

      if (routeCode) {
        params.rt = routeCode;
      }

      const response = await axios.get<CTATrainResponse>(
        `${CTA_TRAIN_API_BASE}/ttarrivals.aspx`,
        { params }
      );

      if (response.data.ctatt.errCd !== '0') {
        logger.error(`CTA Train API error: ${response.data.ctatt.errNm}`);
        throw new Error(response.data.ctatt.errNm);
      }

      const arrivals = response.data.ctatt.eta || [];

      const formattedArrivals = arrivals.map((arrival) => {
        const arrivalTime = new Date(arrival.arrT);
        const now = new Date();
        const minutesAway = Math.floor(
          (arrivalTime.getTime() - now.getTime()) / 60000
        );

        return {
          routeName: `${arrival.rt} Line`,
          destination: arrival.destNm,
          arrivalTime,
          minutesAway,
          isApproaching: arrival.isApp === '1',
          isDelayed: arrival.isDly === '1',
        };
      });

      // Cache the results
      await CacheService.set(cacheKey, formattedArrivals);

      return formattedArrivals;
    } catch (error) {
      logger.error('Error fetching train arrivals:', error);
      throw error;
    }
  }

  /**
   * Get bus predictions for a specific stop
   * @param stopId - CTA bus stop ID
   * @param routeId - Optional route filter (e.g., "157")
   * @param limit - Maximum number of predictions to return
   */
  static async getBusPredictions(
    stopId: string,
    routeId?: string,
    limit: number = 3
  ): Promise<FormattedArrival[]> {
    try {
      // Generate cache key
      const cacheKey = CacheService.generateKey(
        'bus',
        stopId,
        routeId || 'all',
        limit.toString()
      );

      // Check cache first
      const cached = await CacheService.get<FormattedArrival[]>(cacheKey);
      if (cached) {
        logger.debug(`Bus predictions cache hit for ${stopId}`);
        return cached;
      }

      const params: any = {
        key: config.cta.busApiKey,
        stpid: stopId,
        format: 'json',
      };

      if (routeId) {
        params.rt = routeId;
      }

      const response = await axios.get<CTABusResponse>(
        `${CTA_BUS_API_BASE}/getpredictions`,
        { params }
      );

      const busResponse = response.data['bustime-response'];

      if (busResponse.error) {
        const errorMsg = busResponse.error[0]?.msg || 'Unknown error';
        logger.error(`CTA Bus API error: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const predictions = busResponse.prd || [];

      const formattedPredictions = predictions.slice(0, limit).map((prediction) => {
        const arrivalTime = new Date(prediction.prdtm);
        const minutesAway = parseInt(prediction.prdctdn, 10);

        return {
          routeName: `Route ${prediction.rt}`,
          destination: prediction.des,
          arrivalTime,
          minutesAway,
          isApproaching: minutesAway <= 1,
          isDelayed: prediction.dly,
        };
      });

      // Cache the results
      await CacheService.set(cacheKey, formattedPredictions);

      return formattedPredictions;
    } catch (error) {
      logger.error('Error fetching bus predictions:', error);
      throw error;
    }
  }

  /**
   * Format arrivals into a readable text message
   */
  static formatArrivalsForSMS(arrivals: FormattedArrival[], title: string): string {
    if (arrivals.length === 0) {
      return `${title}\n\nNo arrivals found at this time.`;
    }

    let message = `${title}\n\n`;

    arrivals.forEach((arrival, index) => {
      const statusFlags = [];
      if (arrival.isApproaching) statusFlags.push('⚡');
      if (arrival.isDelayed) statusFlags.push('⏱️');

      const status = statusFlags.length > 0 ? ` ${statusFlags.join(' ')}` : '';

      message += `${index + 1}. ${arrival.destination}\n`;
      message += `   ${arrival.minutesAway} min${status}\n`;

      if (index < arrivals.length - 1) {
        message += '\n';
      }
    });

    return message;
  }
}
