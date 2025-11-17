# SMS Opt-In Policy - CTA Track

## How Users Opt-In

Users of CTA Track explicitly opt-in to receive SMS notifications through the following process:

1. **Registration**: Users register their phone number via the API endpoint `/api/auth/register`
2. **Explicit Consent**: By registering, users acknowledge they will receive SMS notifications for CTA transit arrivals
3. **User Control**: Users can save favorite routes and set up notification schedules via the API
4. **Transactional Messages**: All SMS messages are transactional notifications requested by the user for their saved routes

## Types of Messages Sent

- Real-time CTA bus and train arrival times
- Scheduled notifications for saved favorite routes
- Transit directions and stop information (when requested)

## Sample Messages

```
157 Streeterville/Taylor
1. Downtown: 3 min
2. Downtown: 12 min
3. Downtown: 24 min
```

```
Your Favorites:

157: 3min, 12min
Blue: 5min, 15min

Text route number for details.
```

## Opt-Out

Users can opt-out at any time by:
- Replying STOP to any message
- Deleting their account via the API

## Contact

For questions or support: t4nishq@gmail.com

---

*Last Updated: November 2025*
