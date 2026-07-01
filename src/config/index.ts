import dotenv from 'dotenv';

dotenv.config();

interface Config {
  port: number;
  nodeEnv: string;
  publicUrl: string;
  databaseUrl: string;
  redis: {
    url?: string;
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
  // iMessage delivery via the Spectrum TS cloud provider (issue #10).
  // Disabled by default: no send is attempted unless `enabled` is true AND
  // the mode's credentials are present. Kept behind a flag so the app
  // compiles and runs normally with iMessage turned off.
  imessage: {
    enabled: boolean;
    // "cloud"  — Spectrum Cloud shared/dedicated line (needs project creds)
    // "local"  — Mac dev relay (Spectrum local mode, no cloud creds)
    // "dedicated" — self-hosted relay (treated like cloud for init here)
    mode: 'cloud' | 'local' | 'dedicated';
    projectId: string;
    projectSecret: string;
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
  // IANA zone that schedules' HH:mm values are interpreted in.
  // Defaults to Chicago so the app behaves correctly regardless of host TZ.
  scheduleTimezone: string;
  // When true (default), the Express process also runs the BullMQ worker
  // so a single-process deployment ("npm start") delivers end-to-end.
  // Set to "false" if you run a dedicated worker container.
  runWorkerInProcess: boolean;
}

const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL || '',
  redis: {
    url: process.env.REDIS_URL,
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
    // Accept either name: historical code uses GOOGLE_GEMINI_API_KEY,
    // but docker-compose and many deploy scripts pass GEMINI_API_KEY.
    geminiApiKey: process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  },
  imessage: {
    // Off unless explicitly enabled. This is the master gate for issue #10.
    enabled: process.env.IMESSAGE_ENABLED === 'true',
    mode: (process.env.IMESSAGE_MODE as 'cloud' | 'local' | 'dedicated') || 'cloud',
    projectId: process.env.SPECTRUM_PROJECT_ID || '',
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET || '',
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
  scheduleTimezone: process.env.SCHEDULE_TIMEZONE || 'America/Chicago',
  runWorkerInProcess: process.env.RUN_WORKER_IN_PROCESS !== 'false',
};

export default config;
