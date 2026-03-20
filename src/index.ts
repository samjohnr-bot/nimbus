import http from 'node:http';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { startScheduler, runTradingCycle } from './scheduler/cron.js';
import * as kalshi from './kalshi/client.js';

const log = createLogger('main');

// Health check endpoint for Railway/hosting
const PORT = parseInt(process.env.PORT || '3000', 10);
const startedAt = new Date().toISOString();

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'nimbus',
    env: config.env,
    dryRun: config.dryRun,
    startedAt,
    uptime: process.uptime(),
  }));
});

server.listen(PORT, () => {
  log.info({ port: PORT }, 'Health check server listening');
});

async function main(): Promise<void> {
  log.info(
    {
      env: config.env,
      dryRun: config.dryRun,
      city: config.trading.city,
      series: config.trading.seriesTicker,
      edgeThreshold: config.trading.edgeThreshold,
      maxTradeSize: config.trading.maxTradeSize,
      kellyFraction: config.trading.kellyFraction,
      pollInterval: `${config.scheduler.pollIntervalMinutes}m`,
    },
    'Nimbus starting',
  );

  // Verify Kalshi connectivity
  try {
    const balance = await kalshi.getBalance();
    log.info(
      { balance: balance.balance, portfolioValue: balance.portfolio_value },
      'Kalshi connection verified',
    );
  } catch (error) {
    log.fatal({ error: String(error) }, 'Failed to connect to Kalshi API — check credentials');
    process.exit(1);
  }

  // Start the scheduler
  const scheduler = startScheduler();

  // Optionally run one cycle immediately
  if (config.runOnStart) {
    log.info('Running initial trading cycle');
    await runTradingCycle();
  }

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    scheduler.stop();

    // Cancel any resting orders
    try {
      const positions = await kalshi.getPositions();
      log.info({ openPositions: positions.length }, 'Shutdown complete');
    } catch {
      // Best-effort
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('Nimbus is running. Press Ctrl+C to stop.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
