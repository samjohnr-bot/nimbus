import pino from 'pino';
import { config } from '../config.js';

const transport = process.stdout.isTTY
  ? { target: 'pino-pretty', options: { colorize: true } }
  : undefined;

export const logger = pino({
  level: config.logging.level,
  transport,
});

export function createLogger(module: string) {
  return logger.child({ module });
}
