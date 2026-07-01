import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
  flushdb: vi.fn(),
}));

vi.mock('../utils/redis', () => ({
  cacheRedis: mocks,
}));

vi.mock('../utils/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('CacheService Redis failure behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats Redis get failures as cache misses', async () => {
    mocks.get.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(CacheService.get('arrivals:test')).resolves.toBeNull();
  });
});
