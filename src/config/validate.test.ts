import { describe, expect, it, vi } from 'vitest';
import { Config } from './index';
import { ConfigValidationError, validateConfig } from './validate';

vi.mock('../utils/logger', () => ({
  default: {
    error: vi.fn(),
  },
}));

const validConfig: Config = {
  port: 3000,
  nodeEnv: 'production',
  publicUrl: 'https://ontheloop.app',
  databaseUrl: 'postgres://user:pass@localhost:5432/ontheloop',
  redis: {
    url: 'redis://localhost:6379',
    host: 'localhost',
    port: 6379,
  },
  jwt: {
    secret: 'a-strong-jwt-secret-with-at-least-32-chars',
    expiresIn: '7d',
  },
  cta: {
    trainApiKey: 'train-key',
    busApiKey: 'bus-key',
  },
  google: {
    geminiApiKey: '',
  },
  telegram: {
    botToken: '',
    botUsername: '',
    webhookSecret: '',
  },
  cache: {
    ttl: 60,
  },
  scheduleTimezone: 'America/Chicago',
  runWorkerInProcess: true,
};

describe('validateConfig', () => {
  it('rejects placeholder and weak JWT secrets', () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, secret: 'default-secret-change-me' },
      })
    ).toThrow(ConfigValidationError);

    expect(() =>
      validateConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, secret: '' },
      })
    ).toThrow('JWT_SECRET must be set');
  });

  it('accepts documented development defaults with a strong local JWT secret', () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        nodeEnv: 'development',
        databaseUrl: '',
        redis: { url: undefined, host: 'localhost', port: 6379 },
        cta: { trainApiKey: '', busApiKey: '' },
        jwt: { ...validConfig.jwt, secret: 'dev-only-insecure-secret-for-local-dev' },
      })
    ).not.toThrow();
  });
});
