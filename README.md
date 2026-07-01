# On the Loop

**Live Chicago CTA tracker with Telegram pings before your train arrives.**

[ontheloop.app](https://ontheloop.app) · [@OnTheLoop_bot](https://t.me/OnTheLoop_bot) · [Discord](https://discord.gg/cwqSwUVPu5)

---

Chicago transit, in your pocket. Save the stops you actually use, get arrivals pushed to Telegram at the exact minute you need them, and ask a plain-English assistant anything about the city's trains and buses.

It's free. Made in Chicago, for Chicago.

---

## How to use it

**1. Sign up at [ontheloop.app](https://ontheloop.app).** Email + password, takes 10 seconds.

**2. Add a saved route.** Pick the station or stop you commute from, the route, the direction. You can save as many as you want. They show up on your dashboard with live arrival times.

**3. Link Telegram.** Click *Link Telegram* in the app — it'll send you to [@OnTheLoop_bot](https://t.me/OnTheLoop_bot) with a one-tap link token. Send the link the bot gives you. Done.

**4. Set a schedule.** On any saved route, click the clock icon and tell it when to ping you — *"weekdays at 8:45 AM, next three Red Lines."* At 8:45 AM, Telegram buzzes with exactly that.

**5. Or just ask the bot.** Once linked, send the bot messages like:

- *"when's the next blue line?"*
- *"how do I get from Wrigley to Willis Tower?"*
- *"Route 60 stops near Northwestern"*

Answers include real arrival times and stop IDs you can save in one tap.

---

## What you get

- **Live arrivals** for every CTA train line and bus route, straight from the official Train Tracker and Bus Tracker APIs.
- **Saved routes** — pin your commutes to a one-glance dashboard.
- **Scheduled Telegram pings** — no app to open, no refresh. Buzz arrives before you leave.
- **Natural-language assistant** — ask for arrivals, directions, or nearby stops in plain English.
- **Quiet hours** — tell it when you sleep; no pings during those hours.
- **Service alerts** — flags when the CTA is slow so your scheduled pings aren't lying to you.

---

## Feedback

Bug reports, feature requests, and questions land fastest in the [Discord](https://discord.gg/cwqSwUVPu5).

---

## Stack

| Layer | Choice |
|---|---|
| API | TypeScript + Express on Node 20 |
| DB | PostgreSQL via Prisma |
| Cache + queue | Redis (ioredis) + BullMQ |
| Notifications | Telegram Bot API, optional email |
| AI | Google Gemini (function-calling + Maps grounding) |
| Frontend | Vanilla JS SPA (no framework) served as static files |
| Tests | Playwright for critical UI flows |
| Errors | Sentry |

## Local configuration

Copy `.env.example` to `.env` and fill in the values for the services you want to run locally. Production startup fails fast when required secrets or provider settings are missing.

### A few engineering notes

**Request coalescing on CTA API calls** (`src/services/cta.service.ts`). When 50 users hit Belmont in the same 200ms, they share one upstream call instead of firing 50 parallel ones. Combined with adaptive TTLs (8–25s based on how imminent the next train is) and a 10-min stale-while-error fallback, CTA's often-flaky API stops being a single point of failure.

**BullMQ with idempotent scheduling** (`src/jobs/notification.job.ts`). The scheduler stamps `lastTriggeredAt` *before* enqueueing, so a concurrent tick or a multi-instance deploy can't double-fire a schedule.

**Telegram 429 handling** (`src/services/telegram.service.ts`). Reads `retry_after` from Telegram's rate-limit response and waits exactly that long before retrying. Bursts of simultaneous schedules back off gracefully instead of getting throttled into oblivion.

---

## Architecture

On the Loop is a single TypeScript service: an **Express** API (Node 20) that persists to **PostgreSQL** through **Prisma**, uses **Redis** for caching and as the backing store for a **BullMQ** job queue, and serves a vanilla-JS **static SPA** from `public/`. Scheduled notifications are enqueued onto BullMQ and delivered by a worker (run in-process by default, or as a separate `worker` container when scaled out). Live arrivals come from the official **CTA** Train and Bus Tracker APIs; the natural-language assistant is powered by **Google Gemini**; user-facing pings go out over the **Telegram** Bot API (optional email as a fallback). Errors are reported to **Sentry**.

## Running locally

**Prerequisites:** Node 20, plus a PostgreSQL and a Redis instance. The quickest way to get the two datastores is Docker:

```bash
docker compose up -d postgres redis
```

Then:

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# edit .env and fill in credentials (CTA_TRAIN_API_KEY, CTA_BUS_API_KEY,
# GEMINI_API_KEY, JWT_SECRET, etc.). See the comments in .env.example for
# which vars are required in production.

# 3. Apply the database schema
npx prisma migrate dev

# 4. Start the dev server (Express + in-process worker) with hot reload
npm run dev
```

The app boots on `http://localhost:3000` (`PORT`) and exposes a health check at `/health`.

**Where to get credentials:**

- **CTA API keys** — request Train Tracker and Bus Tracker keys from the [CTA developer portal](https://www.transitchicago.com/developers/).
- **Gemini API key** — create one in [Google AI Studio](https://aistudio.google.com/app/apikey) (`GEMINI_API_KEY`, or the legacy `GOOGLE_GEMINI_API_KEY`).
- **Telegram bot** — register a bot with [@BotFather](https://t.me/BotFather) to get `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME`; set `TELEGRAM_WEBHOOK_SECRET` (required in prod when the bot is enabled).
- **JWT_SECRET** — any random string of 32+ characters. The app refuses to boot in production without it.

## Testing

```bash
npm test          # unit tests (Vitest, src/**/*.test.ts)
npm run test:e2e  # end-to-end tests (Playwright, tests/*.spec.ts)
```

The Playwright suite drives a running app on `http://localhost:3100`. Start the server on that port first (e.g. `PORT=3100 npm run dev` in a separate shell) before running `npm run test:e2e`.

## Deploying (Railway)

Production runs from the `Dockerfile` on [Railway](https://railway.app), configured by `railway.json`:

- **Start command:** `npm run start:prod`, which runs `prisma migrate deploy` and then `node dist/index.js`.
- **Health check:** Railway polls `/health`; deploys restart on failure (up to 5 retries).
- **Environment:** set every required var from `.env.example` in the Railway service (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CTA_*`, `GEMINI_API_KEY`, `TELEGRAM_*`, etc.). Railway's managed Postgres and Redis plugins provide `DATABASE_URL` and `REDIS_URL`.
- **Worker:** by default the web process runs the BullMQ worker in-process (`RUN_WORKER_IN_PROCESS=true`). To scale the worker out to its own service, set `RUN_WORKER_IN_PROCESS=false` and run `npm run worker` there.

The same image works with `docker compose up` for a local production-like stack (app + Postgres + Redis + optional worker profile).

---

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with the Chicago Transit Authority. CTA data is sourced from the [official public API](https://www.transitchicago.com/developers/).
