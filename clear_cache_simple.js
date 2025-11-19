const { createClient } = require('redis');
require('dotenv').config();

const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

async function clear() {
    try {
        await client.connect();
        console.log('Connected to Redis');
        await client.flushAll();
        console.log('Redis Flushed');
    } catch (e) {
        console.error(e);
    } finally {
        await client.disconnect();
    }
}

clear();

