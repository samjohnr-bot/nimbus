import http from 'node:http';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { startScheduler, runTradingCycle } from './scheduler/cron.js';
import * as kalshi from './kalshi/client.js';
import { handleApiRequest } from './dashboard/api.js';
import { getDashboardHtml } from './dashboard/page.js';

const log = createLogger('main');

// HTTP server — dashboard + API + health check
const PORT = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // API routes
  if (url.startsWith('/api/')) {
    if (handleApiRequest(req, res)) return;
  }

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Dashboard
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getDashboardHtml());
});

server.listen(PORT, () => {
  log.info({ port: PORT }, 'Dashboard server listening');
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
