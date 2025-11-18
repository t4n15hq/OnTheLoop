# CTA Track - Transit Notification Service

A smart CTA (Chicago Transit Authority) tracking service that sends scheduled SMS notifications for your favorite train and bus routes, and allows on-demand queries via text message.

## Features

- **AI-Powered SMS**: Text questions in plain English and get intelligent responses with real arrival times (powered by Google Gemini AI)
- **Scheduled Notifications**: Get arrival times sent to your phone at specific times (e.g., "Send Blue Line times at 8:45 AM and 9:00 AM on weekdays")
- **Natural Language Queries**: Ask "When is the next 60 bus?" or "How do I get to Willis Tower?" via SMS or API
- **Smart Location Search**: Find stops using descriptions like "coffee shop near Northwestern" or "my office at 123 Main St"
- **Favorites Management**: Save your frequently used routes with custom names
- **Multi-User Support**: Secure authentication with JWT tokens
- **Redis Caching**: Fast response times with intelligent caching
- **Scalable Architecture**: Built with TypeScript, Express, PostgreSQL, and BullMQ

## Tech Stack

- **Backend**: Node.js, TypeScript, Express
- **Database**: PostgreSQL with Prisma ORM
- **Cache & Jobs**: Redis, BullMQ
- **SMS**: AWS SNS (Amazon Simple Notification Service)
- **AI**: Google Gemini (for natural language location resolution)
- **APIs**: CTA Train Tracker & Bus Tracker APIs

## Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose (for PostgreSQL and Redis)
- AWS account with SNS enabled (for SMS functionality)
- CTA API keys (free from [CTA Developer Portal](https://www.transitchicago.com/developers/))
- Google Gemini API key (optional, for natural language location search - get it from [Google AI Studio](https://ai.google.dev/))

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd cta-track
npm install
```

### 2. Environment Setup

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL="postgresql://ctauser:ctapassword@localhost:5432/cta_track?schema=public"

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=7d

# CTA API Keys
CTA_TRAIN_API_KEY=your-cta-train-api-key
CTA_BUS_API_KEY=your-cta-bus-api-key

# AWS Configuration (for SNS SMS)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
# Optional: Origination phone number (requires dedicated number from AWS)
# AWS_SNS_PHONE_NUMBER=+1234567890

# Google Gemini API (for natural language location search)
GOOGLE_GEMINI_API_KEY=your-google-gemini-api-key

# Cache TTL (seconds)
CACHE_TTL=60
```

### 3. Start Infrastructure

Start PostgreSQL and Redis using Docker Compose:

```bash
docker-compose up -d
```

### 4. Database Setup

Generate Prisma client and run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

### 5. Run the Application

Start the API server:

```bash
npm run dev
```

Start the job worker (in a separate terminal):

```bash
npm run worker
```

The API will be available at `http://localhost:3000`

## API Documentation

### User Workflow: Setting Up Your First Favorite

**Example**: You live on Lytle St and want to track the Route 60 Eastbound bus.

1. **Find your route** by listing all bus routes:
   ```bash
   curl http://localhost:3000/api/cta/bus/routes
   ```
   Look for "60" in the response.

2. **Get directions** for Route 60:
   ```bash
   curl http://localhost:3000/api/cta/bus/60/directions
   ```
   You'll see "Eastbound" and "Westbound".

3. **Find your stop** using search:
   ```bash
   curl "http://localhost:3000/api/cta/bus/60/stops?direction=Eastbound&search=Lytle"
   ```
   Or use your location (if you have GPS coordinates):
   ```bash
   curl "http://localhost:3000/api/cta/bus/60/stops/nearby?direction=Eastbound&lat=41.8781&lon=-87.6298&radius=0.25"
   ```
   Note the `stpid` (stop ID) from the response, e.g., "1234".

4. **Register** and get your auth token:
   ```bash
   curl -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"phoneNumber":"+15551234567","password":"secure123"}'
   ```
   Save the `token` from the response.

5. **Create a favorite** with the stop ID you found:
   ```bash
   curl -X POST http://localhost:3000/api/favorites \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "routeType":"BUS",
       "routeId":"60",
       "stopId":"1234",
       "name":"Route 60 East at Lytle"
     }'
   ```

6. **Schedule notifications** for when you need them:
   ```bash
   curl -X POST http://localhost:3000/api/schedules \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "favoriteId":"FAVORITE_ID_FROM_STEP_5",
       "time":"08:45",
       "daysOfWeek":[1,2,3,4,5]
     }'
   ```

7. **Text the number** to get on-demand updates:
   - Text "60" to get next 3 arrivals
   - Text "favorites" to see all your routes

### Authentication

#### Register

```http
POST /api/auth/register
Content-Type: application/json

{
  "phoneNumber": "+15551234567",
  "password": "securepassword123"
}
```

Response:
```json
{
  "message": "User registered successfully",
  "user": {
    "id": "...",
    "phoneNumber": "+15551234567",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "phoneNumber": "+15551234567",
  "password": "securepassword123"
}
```

### CTA Route & Stop Lookup

These endpoints help you find route information and stop IDs needed to create favorites.

#### Get All Bus Routes

```http
GET /api/cta/bus/routes
```

Response:
```json
{
  "routes": [
    {
      "rt": "60",
      "rtnm": "Blue Island/26th",
      "rtclr": "#336633"
    },
    {
      "rt": "157",
      "rtnm": "Streeterville/Taylor",
      "rtclr": "#ff6633"
    }
  ]
}
```

#### Get Directions for a Route

```http
GET /api/cta/bus/60/directions
```

Response:
```json
{
  "route": "60",
  "directions": ["Eastbound", "Westbound"]
}
```

#### Get Stops for a Route

```http
GET /api/cta/bus/60/stops?direction=Eastbound
```

Optional query param `search` to filter stops:
```http
GET /api/cta/bus/60/stops?direction=Eastbound&search=Lytle
```

Response:
```json
{
  "route": "60",
  "direction": "Eastbound",
  "stops": [
    {
      "stpid": "1234",
      "stpnm": "Blue Island at Lytle",
      "lat": 41.8781,
      "lon": -87.6298
    }
  ]
}
```

#### Find Nearby Stops

Find stops near your current location:

```http
GET /api/cta/bus/60/stops/nearby?direction=Eastbound&lat=41.8781&lon=-87.6298&radius=0.5
```

Response:
```json
{
  "route": "60",
  "direction": "Eastbound",
  "location": { "lat": 41.8781, "lon": -87.6298 },
  "radius": 0.5,
  "stops": [
    {
      "stpid": "1234",
      "stpnm": "Blue Island at Lytle",
      "lat": 41.8781,
      "lon": -87.6298,
      "distance": 0.05
    }
  ]
}
```

#### Get All Train Lines

```http
GET /api/cta/train/lines
```

Response:
```json
{
  "lines": [
    { "route": "Red", "name": "Red Line", "color": "#c60c30" },
    { "route": "Blue", "name": "Blue Line", "color": "#00a1de" }
  ]
}
```

### Natural Language Location Search (Gemini AI)

Use Google's Gemini AI with Maps grounding to find stops using natural language instead of coordinates!

#### Resolve a Location

Convert natural language to coordinates:

```http
GET /api/cta/location/resolve?query=Willis Tower
```

or

```http
GET /api/cta/location/resolve?query=coffee shop near Northwestern University
```

Response:
```json
{
  "location": {
    "name": "Willis Tower",
    "address": "233 S Wacker Dr, Chicago, IL 60606",
    "coordinates": {
      "lat": 41.8789,
      "lon": -87.6359
    }
  }
}
```

#### Find Stops Near a Location (Natural Language)

Find bus stops using natural language location descriptions:

```http
GET /api/cta/bus/60/stops/near-location?direction=Eastbound&location=my office at Northwestern University&radius=0.5
```

Response:
```json
{
  "route": "60",
  "direction": "Eastbound",
  "location": {
    "name": "Northwestern University",
    "address": "633 Clark St, Evanston, IL 60208",
    "coordinates": {
      "lat": 42.0565,
      "lon": -87.6753
    }
  },
  "radius": 0.5,
  "stops": [
    {
      "stpid": "5678",
      "stpnm": "Chicago Ave at Campus Dr",
      "lat": 42.0571,
      "lon": -87.6748,
      "distance": 0.08
    }
  ]
}
```

#### Ask Transit Questions

Get natural language transit suggestions:

```http
GET /api/cta/transit/ask?query=How do I get from Northwestern to Willis Tower using CTA?
```

Response:
```json
{
  "query": "How do I get from Northwestern to Willis Tower using CTA?",
  "suggestion": "To get from Northwestern University in Evanston to Willis Tower in downtown Chicago using CTA:\n\n1. Take the Purple Line from any Evanston station heading southbound toward the Loop\n2. Transfer at Howard station to the Red Line southbound\n3. Get off at Jackson station\n4. Walk about 3 blocks west to Willis Tower at 233 S Wacker Drive\n\nAlternatively, you can take the Purple Line Express during rush hours which goes directly to the Loop without the transfer."
}
```

**Example Use Cases:**
- "Find Route 157 stops near my apartment at 123 Main St"
- "Show me Blue Line stations near the Art Institute"
- "Where can I catch the 66 bus near Millennium Park?"
- "How do I get from O'Hare Airport to Navy Pier?"

### Favorites Management

All favorites endpoints require authentication. Include the JWT token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

#### Create a Favorite

**Train Example:**
```http
POST /api/favorites
Content-Type: application/json
Authorization: Bearer <token>

{
  "routeType": "TRAIN",
  "routeId": "Blue",
  "stationId": "40380",
  "direction": "5",
  "name": "Blue Line to O'Hare from Jackson"
}
```

**Bus Example:**
```http
POST /api/favorites
Content-Type: application/json
Authorization: Bearer <token>

{
  "routeType": "BUS",
  "routeId": "157",
  "stopId": "1234",
  "name": "Route 157 Northbound"
}
```

#### Get All Favorites

```http
GET /api/favorites
Authorization: Bearer <token>
```

#### Update a Favorite

```http
PUT /api/favorites/:id
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "Updated name"
}
```

#### Delete a Favorite

```http
DELETE /api/favorites/:id
Authorization: Bearer <token>
```

### Schedules

#### Create a Schedule

```http
POST /api/schedules
Content-Type: application/json
Authorization: Bearer <token>

{
  "favoriteId": "...",
  "time": "08:45",
  "daysOfWeek": [1, 2, 3, 4, 5]
}
```

Days of week: 0=Sunday, 1=Monday, ..., 6=Saturday

#### Get All Schedules

```http
GET /api/schedules
Authorization: Bearer <token>
```

#### Update a Schedule

```http
PUT /api/schedules/:id
Content-Type: application/json
Authorization: Bearer <token>

{
  "time": "09:00",
  "enabled": true
}
```

#### Delete a Schedule

```http
DELETE /api/schedules/:id
Authorization: Bearer <token>
```

## SMS Usage

### AI-Powered Natural Language Queries

With Google Gemini API configured, users can text in **plain English**! The system understands:

**Simple Route Queries:**
```
You: 157
Bot: Route 157 Northbound

1. Howard Station
   5 min

2. Loyola Station
   12 min

3. Morse Station
   20 min
```

**Natural Language Route Queries:**
```
You: When is the next 60 bus?
Bot: Route 60 East at Lytle

1. Blue Island at Lytle
   4 min

2. Blue Island at Morgan
   12 min

3. Blue Island at Halsted
   23 min
```

**Find Stops Near Locations:**
```
You: Find Route 60 stops near Lytle Street
Bot: Route 60 Eastbound
Near: Lytle Street, Chicago

1. Blue Island at Lytle
   0.05 mi away

2. Blue Island at Morgan
   0.12 mi away

Text route number for arrivals or reply SAVE to add favorite.
```

**Transit Directions:**
```
You: How do I get to Willis Tower from Northwestern?
Bot: Take Purple Line southbound to Loop. Transfer to Red Line at Howard. Get off at Jackson (25 min). Walk 3 blocks west to Willis Tower.
```

**View Favorites:**
```
You: favorites
Bot: Your Favorites:

60: 4min, 12min
Blue: 3min, 9min
157: 6min, 15min

Text route number for details.
```

### Supported Query Types

1. **Route Arrivals**: "157", "When is the next Blue Line?", "Next bus on route 60"
2. **Find Stops**: "Find Route 60 stops near [location]", "Where can I catch the 157 near Northwestern?"
3. **Transit Directions**: "How do I get from [A] to [B]?", "Route from O'Hare to downtown"
4. **Favorites**: "favorites", "fav", "show my routes"

### Fallback Mode

If Gemini API is not configured, the system works in simple mode:
- Text a route number (e.g., "157") for arrivals
- Text "favorites" to see saved routes

## Finding CTA IDs

### Train Station IDs

Find station IDs from the [CTA Train Tracker API Documentation](https://www.transitchicago.com/developers/ttdocs/):
- Jackson Blue Line: `40380`
- Chicago Blue Line: `41410`
- UIC-Halsted Blue Line: `40350`

### Bus Stop IDs

Find stop IDs on bus stop signs or via the [CTA Bus Tracker API](https://www.transitchicago.com/developers/bustracker/):
- Each physical stop has a unique 4-5 digit ID printed on the sign

## Production Deployment

### Build the Application

```bash
npm run build
```

### Environment Variables

Update your production `.env`:
- Set `NODE_ENV=production`
- Use strong `JWT_SECRET`
- Configure production database URL
- Set up production Redis instance

### Run in Production

```bash
# Start the API server
npm start

# Start the worker (in a separate process/container)
npm run worker
```

### Twilio Webhook Configuration

Configure your Twilio phone number's SMS webhook to point to:
```
https://your-domain.com/api/sms/webhook
```

Method: POST

## Database Schema

### Users
- Phone number (unique identifier)
- Password (hashed with bcrypt)

### Favorites
- User relationship
- Route type (TRAIN or BUS)
- Route ID, Station/Stop ID
- Custom name

### Schedules
- Favorite relationship
- Time (HH:mm format)
- Days of week array
- Enabled flag

## Architecture

```
┌─────────────┐
│   Client    │
│  (SMS/API)  │
└──────┬──────┘
       │
┌──────▼──────────────────────┐
│     Express API Server       │
│  - Auth                      │
│  - Favorites CRUD            │
│  - SMS Webhook Handler       │
└──────┬──────────────────────┘
       │
┌──────▼──────┐    ┌──────────┐
│  PostgreSQL │    │  Redis   │
│  (Prisma)   │    │ (Cache)  │
└─────────────┘    └────┬─────┘
                        │
                   ┌────▼────────┐
                   │   BullMQ    │
                   │  (Jobs)     │
                   └────┬────────┘
                        │
                   ┌────▼────────┐
                   │   Worker    │
                   │ (Scheduler) │
                   └─────────────┘
```

## License

MIT

## Support

For issues or questions, please open an issue in the GitHub repository.
