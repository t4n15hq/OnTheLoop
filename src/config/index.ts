import dotenv from 'dotenv';

dotenv.config();

interface Config {
  port: number;
  nodeEnv: string;
  publicUrl: string;
  databaseUrl: string;
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  cta: {
    trainApiKey: string;
    busApiKey: string;
  };
  google: {
    geminiApiKey: string;
  };
  telegram: {
    botToken: string;
    botUsername: string;
    webhookSecret: string;
  };
  email?: {
    user: string;
    pass: string;
    host?: string;
    port?: number;
    from?: string;
    fromName?: string;
  };
  cache: {
    ttl: number;
  };
}

const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL || '',
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  cta: {
    trainApiKey: process.env.CTA_TRAIN_API_KEY || '',
    busApiKey: process.env.CTA_BUS_API_KEY || '',
  },
  google: {
    geminiApiKey: process.env.GOOGLE_GEMINI_API_KEY || '',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  },
  email: process.env.EMAIL_USER && process.env.EMAIL_PASS ? {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT, 10) : undefined,
    from: process.env.EMAIL_FROM,
    fromName: process.env.EMAIL_FROM_NAME,
  } : undefined,
  cache: {
    ttl: parseInt(process.env.CACHE_TTL || '60', 10),
  },
};

export default config;
