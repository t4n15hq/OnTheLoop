# Deploying to Railway

One-service deployment: Node app (API + static frontend + BullMQ worker) + Postgres + Redis, all on Railway. Migrations run automatically on every deploy via `npm run start:prod`.

## 1. Create the Railway project

1. Sign in at https://railway.app.
2. **New Project → Deploy from GitHub repo → `t4n15hq/OnTheLoop`**, branch `main`.
3. Railway detects `railway.json` and uses the `Dockerfile`. First build will fail (no DB yet) — that's expected.

## 2. Add the addons

In the same project, click **+ New**:

- **Database → Add PostgreSQL** — Railway creates a service and exposes `DATABASE_URL` as a reference variable.
- **Database → Add Redis** — exposes `REDIS_URL`.

## 3. Wire env vars on the web service

Click the web service → **Variables** tab. Add (names exactly as shown):

### From Railway references (click "Add Reference")
| Var | Reference |
|---|---|
| `DATABASE_URL` | Postgres → `DATABASE_URL` |
| `REDIS_URL` | Redis → `REDIS_URL` |

### Static values (copy from your local `.env`)
| Var | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (Railway maps this to its edge) |
| `TZ` | `America/Chicago` — the app parses naive CTA timestamps as local; without this it misbehaves in UTC containers |
| `JWT_SECRET` | long random string (rotate from the `.env` default) |
| `CTA_TRAIN_API_KEY` | from your `.env` |
| `CTA_BUS_API_KEY` | from your `.env` |
| `GOOGLE_GEMINI_API_KEY` | from your `.env` |
| `TELEGRAM_BOT_TOKEN` | **rotate first** (it was pasted in chat during local testing) |
| `TELEGRAM_BOT_USERNAME` | `OnTheLoop_bot` |
| `TELEGRAM_WEBHOOK_SECRET` | new long random string (doesn't have to match local) |
| `PUBLIC_URL` | fill in **after** step 4 |
| `SCHEDULE_TIMEZONE` | `America/Chicago` |

### Optional

| Var | Notes |
|---|---|
| `SENTRY_DSN` | Enable error reporting. Grab from sentry.io → Project → Settings → Client Keys (DSN). No-op if unset. |
| `SENTRY_TRACES_SAMPLE_RATE` | Float 0.0–1.0. Default 0 (errors only, no perf tracing). |

### Optional (add later when SES sandbox is lifted)
`EMAIL_USER`, `EMAIL_PASS`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_FROM`, `EMAIL_FROM_NAME`.

## 4. Expose a public URL

Web service → **Settings → Networking → Generate Domain**. You'll get something like `ontheloop-production.up.railway.app`. Copy it into the `PUBLIC_URL` variable from step 3, **with the `https://` prefix**:

```
PUBLIC_URL=https://ontheloop-production.up.railway.app
```

Saving env vars triggers a redeploy. Wait for it to go green.

## 5. Register the Telegram webhook (one-time)

Once the deploy is live, register the webhook so Telegram can reach your bot:

```bash
curl -X POST https://ontheloop-production.up.railway.app/api/telegram/setup \
  -H "x-telegram-admin-secret: <TELEGRAM_WEBHOOK_SECRET from step 3>"
```

You should see `{"url": "...", "info": {"ok": true, ...}}`.

## 6. Verify

- `https://ontheloop-production.up.railway.app/health` → `{"status":"ok",...}`
- Sign up with a fresh account → link Telegram → hit ▶ on a schedule. Ping should land in Telegram within a few seconds.
- Logs (`railway logs`) should show `Notification worker running in-process` and, at the minute a schedule fires, `Found N schedule(s) due to fire`.

## Operational notes

- **Auto-deploys**: every push to `main` redeploys. `prisma migrate deploy` runs at startup, so new migrations apply automatically. No manual migrate step needed.
- **Scaling**: the app runs the BullMQ worker in-process by default, so a single replica handles everything. If you ever need >1 replica, set `RUN_WORKER_IN_PROCESS=false` on the web service and add a separate "worker" service with the same image + `npm run worker` as its start command.
- **Rotating secrets**: change the var in Railway and the service redeploys. Do this for `JWT_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, and the Telegram bot token whenever you rotate.
- **Rollback**: Railway keeps previous deployments; click any to redeploy in <30s.

## Troubleshooting

- **Migrations fail on deploy with "P3005" (database is not empty)**: Railway's Postgres is fresh so this shouldn't happen, but if you restore a snapshot later, `npx prisma migrate resolve --applied <migration>` from the Railway shell.
- **Prisma engine "not found for this platform"**: add `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` to the `generator client` block in `prisma/schema.prisma` and redeploy.
- **Telegram webhook shows `pending_update_count` climbing**: the bot is receiving updates but can't POST to your server — usually means `PUBLIC_URL` is wrong. Re-run step 5 after fixing it.
- **Rate limit hits on yourself during testing**: the auth limiter is IP-based. Hit it once by spamming login, and your own IP is blocked for 10 min. Wait it out or temporarily raise `max` in `src/middleware/rate-limit.middleware.ts`.
