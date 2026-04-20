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
