import * as kalshi from '../kalshi/client.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { logSettlement } from './tracker.js';

const log = createLogger('settlement');

export async function checkSettlements(): Promise<void> {
  log.info('Checking settlements');

  // Fetch recently settled markets in our series
  const markets = await kalshi.getMarkets({
    series_ticker: config.trading.seriesTicker,
    status: 'settled',
    limit: 20,
  });

  // Get our positions to see if we had exposure
  const positions = await kalshi.getPositions();
  const positionTickers = new Set(positions.map(p => p.ticker));

  for (const market of markets) {
    if (!positionTickers.has(market.ticker)) continue;

    const pos = positions.find(p => p.ticker === market.ticker);
    if (!pos) continue;

    log.info(
      {
        ticker: market.ticker,
        result: market.result,
        pnl: pos.realized_pnl,
      },
      'Settlement recorded',
    );

    logSettlement(
      market.ticker,
      market.result as 'yes' | 'no',
      pos.realized_pnl,
    );
  }

  log.info({ checked: markets.length }, 'Settlement check complete');
}
