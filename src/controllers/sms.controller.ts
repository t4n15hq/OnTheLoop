import { Request, Response } from 'express';
import { SMSService } from '../services/sms.service';
import { AuthService } from '../services/auth.service';
import { FavoriteService } from '../services/favorite.service';
import { CTAService } from '../services/cta.service';
import logger from '../utils/logger';

export class SMSController {
  /**
   * Handle incoming SMS webhook from Twilio
   */
  static async handleIncomingSMS(req: Request, res: Response): Promise<void> {
    try {
      const { From: from, Body: body } = req.body;

      logger.info(`Received SMS from ${from}: ${body}`);

      // Get user by phone number
      const user = await AuthService.getUserByPhone(from);

      if (!user) {
        // User not registered
        await SMSService.sendSMS(
          from,
          'Welcome! Please register at our app to use this service.'
        );
        res.status(200).send('<Response></Response>');
        return;
      }

      // Parse the message
      const message = body.trim();

      // Check if it's a route query (e.g., "157" for bus route)
      if (/^\d+$/.test(message)) {
        await this.handleRouteQuery(from, message, user.id);
      } else if (message.toLowerCase() === 'favorites' || message.toLowerCase() === 'fav') {
        // Send all favorites
        await this.handleFavoritesQuery(from, user.id);
      } else {
        // Unknown command
        await SMSService.sendSMS(
          from,
          'Commands:\n- Send a route number (e.g., "157") for next arrivals\n- Send "favorites" to see your saved routes'
        );
      }

      // Respond to Twilio
      res.status(200).send('<Response></Response>');
    } catch (error) {
      logger.error('Error handling incoming SMS:', error);
      res.status(500).send('<Response></Response>');
    }
  }

  /**
   * Handle route query (e.g., "157")
   */
  private static async handleRouteQuery(
    phoneNumber: string,
    routeNumber: string,
    userId: string
  ): Promise<void> {
    try {
      // Check if user has this route saved as a favorite
      const favorites = await FavoriteService.getUserFavorites(userId);
      const matchingFavorite = favorites.find(
        (fav) => fav.routeId === routeNumber
      );

      if (!matchingFavorite) {
        await SMSService.sendSMS(
          phoneNumber,
          `Route ${routeNumber} not found in your favorites. Please add it via the app first.`
        );
        return;
      }

      // Fetch arrivals
      let arrivals;
      let title;

      if (matchingFavorite.routeType === 'TRAIN') {
        if (!matchingFavorite.stationId) {
          await SMSService.sendSMS(
            phoneNumber,
            'Error: Station ID not configured for this favorite.'
          );
          return;
        }

        arrivals = await CTAService.getTrainArrivals(
          matchingFavorite.stationId,
          matchingFavorite.routeId
        );
        title = `${matchingFavorite.name}`;
      } else {
        // BUS
        if (!matchingFavorite.stopId) {
          await SMSService.sendSMS(
            phoneNumber,
            'Error: Stop ID not configured for this favorite.'
          );
          return;
        }

        arrivals = await CTAService.getBusPredictions(
          matchingFavorite.stopId,
          matchingFavorite.routeId,
          3
        );
        title = `${matchingFavorite.name}`;
      }

      // Format and send
      const message = CTAService.formatArrivalsForSMS(arrivals, title);
      await SMSService.sendSMS(phoneNumber, message);
    } catch (error) {
      logger.error('Error handling route query:', error);
      await SMSService.sendSMS(
        phoneNumber,
        'Sorry, there was an error fetching arrival times. Please try again later.'
      );
    }
  }

  /**
   * Handle favorites query
   */
  private static async handleFavoritesQuery(
    phoneNumber: string,
    userId: string
  ): Promise<void> {
    try {
      const favorites = await FavoriteService.getUserFavorites(userId);

      if (favorites.length === 0) {
        await SMSService.sendSMS(
          phoneNumber,
          'You have no favorites saved. Add some via the app!'
        );
        return;
      }

      let message = 'Your Favorites:\n\n';

      for (const favorite of favorites) {
        // Fetch current arrivals
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

        message += `${favorite.name}\n`;

        if (arrivals && arrivals.length > 0) {
          arrivals.slice(0, 2).forEach((arrival) => {
            message += `  → ${arrival.destination}: ${arrival.minutesAway} min\n`;
          });
        } else {
          message += '  → No arrivals\n';
        }

        message += '\n';
      }

      await SMSService.sendSMS(phoneNumber, message);
    } catch (error) {
      logger.error('Error handling favorites query:', error);
      await SMSService.sendSMS(
        phoneNumber,
        'Sorry, there was an error fetching your favorites. Please try again later.'
      );
    }
  }
}
