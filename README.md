# On the Loop

**Chicago transit, in your pocket.**

[ontheloop.app](https://ontheloop.app)

On the Loop is a live CTA companion for Chicagoans who'd rather not refresh a transit app five times before leaving the apartment. Save the stops you actually use, get arrivals pushed to Telegram at the exact minute you need them, and ask a plain-English assistant anything about the city's trains and buses.

---

## What it does

**Live arrivals for every CTA train and bus.** Every Red, Blue, Brown, Green, Orange, Pink, Purple, and Yellow Line station. Every bus route. Real-time data straight from the CTA Train Tracker and Bus Tracker APIs, cached fast so it feels instant.

**Saved routes that learn your commute.** Pin the trips you take — "Belmont to the Loop on the Red Line," "66 bus at Ashland" — and your dashboard becomes a one-glance board of everything you actually ride. Color-coded by line, brutalist by design.

**Scheduled Telegram pings.** Tell it to ping you at 8:45 AM on weekdays with the next three Red Lines from Belmont. At 8:45 AM, Telegram buzzes with exactly that. Nothing to open, nothing to refresh. Email opt-in works as a secondary channel for anyone who lives in their inbox.

**A transit assistant that speaks human.** Powered by Google Gemini with Maps grounding, the assistant takes questions like *"next Blue Line from UIC-Halsted,"* *"how do I get from Wrigley to Willis Tower,"* or *"find Route 60 stops near Northwestern"* and answers them with real arrival times, real walking directions, and real stop IDs you can save in one tap.

**Natural-language location search.** You don't need GPS coordinates or CTA stop numbers. Say *"the coffee shop on Damen"* or *"my office on Wacker"* and it finds the nearest stops on the routes you asked about.

---

## The product

On the Loop is built around three ideas:

1. **Transit UX should feel like a platform sign**, not a SaaS dashboard. The whole app leans into Chicago's transit signage language — rainbow line-color accents, monospaced platform kickers, Space Grotesk headlines, Instrument Serif italics for warmth. It feels like the city looks.

2. **Push, don't pull.** The best transit info is the info that reaches you before you reach for it. Schedules + Telegram mean you're ready to walk out the door instead of fumbling for a phone on the platform.

3. **The assistant is the power user's shortcut.** Saving favorites is for routines. The assistant is for everything else — the occasional Cubs game, the trip to O'Hare, the meeting on the North Side. One box, answers that include live arrivals.

---

## Who it's for

Anyone in Chicago who rides the CTA. It's especially nice if you:

- Have two or three regular commutes and want them on a single board
- Run late often enough that a 8:45 AM Telegram ping would change your morning
- Travel across the city enough to need trip directions, not just next-train lookups
- Appreciate something that doesn't look like every other transit app

---

## Tech, briefly

TypeScript + Express API on Node, PostgreSQL via Prisma, Redis for caching, BullMQ for the scheduler worker, Telegram Bot API for pushes, Google Gemini for the assistant and location resolution, and a vanilla-JS SPA frontend (no framework — the app is fast because it's light). Playwright covers the critical UI flows.

---

© 2026 · On the Loop · Chicago, IL · 60607
