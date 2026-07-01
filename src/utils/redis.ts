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

// A bounded connection (fails fast instead of buffering forever) shared by the
// cache path and the rate-limit store. Only BullMQ needs maxRetriesPerRequest: null.
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

// #3 (rate-limit store) and #12 (cache) both wanted an identical bounded client — share one socket.
export const rateLimitRedis = cacheRedis;

cacheRedis.on('error', (error) => {
  logger.error('Bounded Redis error:', error);
});
