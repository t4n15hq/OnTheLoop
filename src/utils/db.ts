import { PrismaClient } from '@prisma/client';

// Explicitly size the connection pool. The default (≈num_cpus*2+1) is tiny on a
// small Railway instance, and a notification burst (10-concurrency worker) +
// web traffic + the per-minute scheduler can exhaust it and surface P2024
// timeouts on user requests. Default 10; override per-service with
// DB_CONNECTION_LIMIT (e.g. a lower value on the web service, higher on the worker).
// ponytail: URL param is the Prisma-native knob; no pool library needed.
function datasourceUrl(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  const limit = process.env.DB_CONNECTION_LIMIT || '10';
  try {
    const u = new URL(base);
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', limit);
    }
    return u.toString();
  } catch {
    return base; // malformed URL — let Prisma surface the real error
  }
}

const url = datasourceUrl();

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  ...(url ? { datasources: { db: { url } } } : {}),
});

export default prisma;
