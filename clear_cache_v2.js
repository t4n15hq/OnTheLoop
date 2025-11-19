import { CacheService } from './src/services/cache.service';
import logger from './src/utils/logger';
import { createClient } from 'redis';
import config from './src/config';

// Mock config if needed or rely on defaults if CacheService handles it
// Actually CacheService uses ./src/config. 
// We need to make sure we can run this.
// Simplest way: use the Redis client directly to flushall.

const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

async function clear() {
    await client.connect();
    console.log('Connected to Redis');
    await client.flushAll();
    console.log('Redis Flushed');
    await client.disconnect();
}

clear().catch(console.error);

