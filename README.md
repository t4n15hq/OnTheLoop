# On the Loop

**Live Chicago CTA tracker with Telegram pings before your train arrives.**

[ontheloop.app](https://ontheloop.app) · [@OnTheLoop_bot](https://t.me/OnTheLoop_bot) · [Discord](https://discord.gg/cwqSwUVPu5)

Save the stops you actually use, get arrivals pushed to Telegram at the exact minute you need them, and ask a plain-English assistant anything about Chicago's trains and buses.

---

## What it does

- **Live arrivals** for every CTA train line and bus route, pulled from the official Train Tracker + Bus Tracker APIs.
- **Saved routes** — pin your commutes (e.g. *"Belmont Red Line inbound"*) to a one-glance dashboard.
- **Scheduled Telegram pings** — "weekdays at 8:45 AM, send me the next three Red Lines." No app to open, no refresh.
- **Natural-language assistant** — *"next Blue Line from UIC-Halsted"*, *"how do I get from Wrigley to Willis Tower"* — powered by Gemini with Maps grounding, answers include live arrivals and real stop IDs you can save in one tap.
- **Service alerts + quiet hours** — we skip pings during the hours you sleep, and flag when the CTA is slow.

---

## Try it

- **Web app**: [ontheloop.app](https://ontheloop.app) — sign up with email.
- **Telegram bot**: [@OnTheLoop_bot](https://t.me/OnTheLoop_bot) — once linked, send `/favorites` or just ask *"when's the next blue line?"*.
- **Community**: [Discord](https://discord.gg/cwqSwUVPu5) — feedback, bug reports, feature requests.

---

## Stack

| Layer | Choice |
|---|---|
| API | TypeScript + Express on Node 20 |
| DB | PostgreSQL via Prisma |
| Cache + queue | Redis (ioredis) + BullMQ |
| Notifications | Telegram Bot API, optional email (Nodemailer/SES) |
| AI | Google Gemini (function-calling + Maps grounding) |
| Frontend | Vanilla JS SPA (no framework) served as static files |
| Tests | Playwright for critical UI flows |
| Errors | Sentry (opt-in via `SENTRY_DSN`) |
| Deploy | Single Docker container on Railway (API + worker + static frontend) |

---

## A few engineering notes

A couple of things worth flagging if you're curious about the code:

**Request coalescing on CTA API calls** (`src/services/cta.service.ts`). When 50 users hit Belmont in the same 200ms, they share one upstream call instead of firing 50 parallel ones. Combined with adaptive TTLs (8–25s based on how imminent the next train is) and a 10-min stale-while-error fallback, CTA's often-flaky API stops being a single point of failure.

**BullMQ with idempotent scheduling** (`src/jobs/notification.job.ts`). The scheduler stamps `lastTriggeredAt` *before* enqueueing, so a concurrent tick or a multi-instance deploy can't double-fire a schedule.

**Telegram 429 handling** (`src/services/telegram.service.ts`). Reads `retry_after` from Telegram's rate-limit response and waits exactly that long before retrying. Bursts of simultaneous schedules back off gracefully instead of getting throttled into oblivion.

**Single-container deploy**. The Express process also runs the BullMQ worker in-process by default (`RUN_WORKER_IN_PROCESS=true`), so one container handles API + scheduler + delivery. Flip the flag to split into a dedicated worker service when you scale past ~500 active users.

---

## Run it locally

```bash
git clone https://github.com/t4n15hq/OnTheLoop.git
cd OnTheLoop
cp .env.example .env  # fill in the required keys
docker compose up
```

Open `http://localhost:3000`. The `docker-compose.yml` brings up Postgres + Redis alongside the app.

You'll need:

- **CTA API keys** — free at [transitchicago.com/developers](https://www.transitchicago.com/developers/) (separate keys for train + bus).
- **Google Gemini API key** — free tier at [ai.google.dev](https://ai.google.dev).
- **Telegram bot token** — from [@BotFather](https://t.me/BotFather), optional but the bot is half the product.

---

## Deploy to Railway

See [DEPLOY.md](./DEPLOY.md). One Postgres addon, one Redis addon, one web service pointing at this repo — migrations run automatically on each deploy.

---

## Contributing

Issues and PRs welcome. The fastest way to flag something is the [Discord](https://discord.gg/cwqSwUVPu5) `#bug-reports` channel — that's where I watch first.

---

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with the Chicago Transit Authority. CTA data is sourced from the [official public API](https://www.transitchicago.com/developers/).
