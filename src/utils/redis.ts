import Redis from 'ioredis';
import config from '../config';
import logger from './logger';

// Accept REDIS_URL (preferred for containers) or fall back to host/port/password.
const redis = config.redis.url
  ? new Redis(config.redis.url, { maxRetriesPerRequest: null })
  : new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null,
    });

redis.on('connect', () => {
  logger.info(
    `Redis connected (${config.redis.url ? 'url' : `${config.redis.host}:${config.redis.port}`})`
  );
});

redis.on('error', (error) => {
  logger.error('Redis error:', error);
});

export default redis;

// Cache path (#12): fail fast instead of buffering forever, so a Redis outage
// degrades to a cache MISS (CacheService catches the throw) rather than a hang.
export const cacheRedis = config.redis.url
  ? new Redis(config.redis.url, {
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
      enableOfflineQueue: false,
    })
  : new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
      enableOfflineQueue: false,
    });

cacheRedis.on('error', (error) => {
  logger.error('Cache Redis error:', error);
});

// Rate-limit store (#3): its own connection with the DEFAULT offline queue so a
// command issued in the brief window before the socket connects buffers instead
// of throwing "Stream isn't writeable" and 500-ing the request. Bounded retries
// keep it from hanging forever. (Must NOT reuse cacheRedis: enableOfflineQueue:false
// there makes every rate-limited request 500 at startup.)
export const rateLimitRedis = config.redis.url
  ? new Redis(config.redis.url, { maxRetriesPerRequest: 3 })
  : new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: 3,
    });

rateLimitRedis.on('error', (error) => {
  logger.error('Rate limit Redis error:', error);
});
