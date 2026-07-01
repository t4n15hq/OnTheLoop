import config, { Config } from './index';
import logger from '../utils/logger';

export class ConfigValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

export function getConfigProblems(current: Config = config): string[] {
  const problems: string[] = [];
  const isProd = current.nodeEnv === 'production';

  if (
    current.jwt.secret === 'default-secret-change-me' ||
    current.jwt.secret.length < 32
  ) {
    problems.push('JWT_SECRET must be set to a strong (32+ char) value');
  }

  if (isProd) {
    if (!current.databaseUrl) problems.push('DATABASE_URL is required');
    if (!current.redis.url && !current.redis.host) {
      problems.push('REDIS_URL or REDIS_HOST is required');
    }
    if (!current.cta.trainApiKey || !current.cta.busApiKey) {
      problems.push('CTA_TRAIN_API_KEY and CTA_BUS_API_KEY are required');
    }
    if (current.telegram.botToken && !current.telegram.webhookSecret) {
      problems.push('TELEGRAM_WEBHOOK_SECRET is required when the bot is enabled');
    }
  }

  return problems;
}

export function validateConfig(current: Config = config): void {
  const problems = getConfigProblems(current);
  if (!problems.length) return;

  const error = new ConfigValidationError(problems);
  logger.error(`FATAL: ${error.message}`);
  throw error;
}
