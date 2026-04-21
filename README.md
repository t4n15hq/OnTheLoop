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

### A few engineering notes

**Request coalescing on CTA API calls** (`src/services/cta.service.ts`). When 50 users hit Belmont in the same 200ms, they share one upstream call instead of firing 50 parallel ones. Combined with adaptive TTLs (8–25s based on how imminent the next train is) and a 10-min stale-while-error fallback, CTA's often-flaky API stops being a single point of failure.

**BullMQ with idempotent scheduling** (`src/jobs/notification.job.ts`). The scheduler stamps `lastTriggeredAt` *before* enqueueing, so a concurrent tick or a multi-instance deploy can't double-fire a schedule.

**Telegram 429 handling** (`src/services/telegram.service.ts`). Reads `retry_after` from Telegram's rate-limit response and waits exactly that long before retrying. Bursts of simultaneous schedules back off gracefully instead of getting throttled into oblivion.

---

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with the Chicago Transit Authority. CTA data is sourced from the [official public API](https://www.transitchicago.com/developers/).
