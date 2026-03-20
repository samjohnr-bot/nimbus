import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NIMBUS_ENV: z.enum(['demo', 'production']).default('demo'),
  KALSHI_API_KEY: z.string().min(1),
  KALSHI_PRIVATE_KEY: z.string().optional(),
  KALSHI_PRIVATE_KEY_PATH: z.string().default('./keys/kalshi-demo.pem'),
  NIMBUS_DRY_RUN: z.string().transform(v => v === 'true').default('true'),
  NIMBUS_EDGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.08),
  NIMBUS_MAX_TRADE_SIZE: z.coerce.number().int().positive().default(7500),
  NIMBUS_MAX_DAILY_LOSS: z.coerce.number().int().positive().default(15000),
  NIMBUS_KELLY_FRACTION: z.coerce.number().min(0).max(1).default(0.15),
  NIMBUS_POLL_INTERVAL: z.coerce.number().int().min(1).default(10),
  NIMBUS_MAX_SPREAD: z.coerce.number().int().positive().default(8),
  NIMBUS_DATA_MAX_AGE: z.coerce.number().int().positive().default(7200),
  NIMBUS_MIN_TIME_BEFORE_CLOSE: z.coerce.number().int().positive().default(3600),
  NIMBUS_RUN_ON_START: z.string().transform(v => v === 'true').default('false'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  const env = parsed.data;

  const isDemo = env.NIMBUS_ENV === 'demo';
  const baseUrl = isDemo
    ? 'https://demo-api.kalshi.co/trade-api/v2'
    : 'https://api.elections.kalshi.com/trade-api/v2';

  return {
    env: env.NIMBUS_ENV,
    dryRun: env.NIMBUS_DRY_RUN,
    runOnStart: env.NIMBUS_RUN_ON_START,

    kalshi: {
      apiKey: env.KALSHI_API_KEY,
      privateKey: env.KALSHI_PRIVATE_KEY || null,
      privateKeyPath: env.KALSHI_PRIVATE_KEY_PATH,
      baseUrl,
    },

    trading: {
      city: 'CHI' as const,
      seriesTicker: 'KXHIGHCHI',
      maxTradeSize: env.NIMBUS_MAX_TRADE_SIZE,
      maxDailyLoss: env.NIMBUS_MAX_DAILY_LOSS,
      edgeThreshold: env.NIMBUS_EDGE_THRESHOLD,
      maxSpread: env.NIMBUS_MAX_SPREAD,
      kellyFraction: env.NIMBUS_KELLY_FRACTION,
      dataMaxAge: env.NIMBUS_DATA_MAX_AGE,
      minTimeBeforeClose: env.NIMBUS_MIN_TIME_BEFORE_CLOSE,
    },

    weather: {
      // Chicago Midway Airport (KMDW) — Kalshi settlement station
      latitude: 41.7868,
      longitude: -87.7522,
      models: ['gfs025', 'ecmwf_ifs025'] as const,
      temperatureUnit: 'fahrenheit' as const,
    },

    scheduler: {
      pollIntervalMinutes: env.NIMBUS_POLL_INTERVAL,
      activeHoursStart: 10,
      activeHoursEnd: 23,
      timezone: 'America/Chicago',
    },

    logging: {
      level: env.LOG_LEVEL,
      directory: './data/logs',
    },
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig();
