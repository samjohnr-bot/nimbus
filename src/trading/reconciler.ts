import * as kalshi from '../kalshi/client.js';
import * as portfolio from './portfolio.js';
import * as risk from '../strategy/risk.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('reconciler');

let lastFillTimestamp: string | null = null;

export async function reconcile(): Promise<void> {
  // Sync portfolio state from Kalshi
  const state = await portfolio.sync();

  // Update risk engine with current exposure
  risk.updateExposure(state.totalExposure, state.positions);

  // Fetch recent fills to track realized P&L
  const fills = await kalshi.getFills({ limit: 50 });

  let newPnl = 0;
  for (const fill of fills) {
    if (lastFillTimestamp && fill.created_time <= lastFillTimestamp) {
      break;
    }

    // For sells, profit = sell_price - cost_basis (simplified: just track fill value)
    // Actual P&L is computed at settlement; here we track fill activity
    log.info(
      {
        ticker: fill.ticker,
        side: fill.side,
        action: fill.action,
        count: fill.count,
        yesPrice: fill.yes_price,
      },
      'New fill detected',
    );
  }

  if (fills.length > 0) {
    lastFillTimestamp = fills[0].created_time;
  }

  if (newPnl !== 0) {
    risk.updatePnl(newPnl);
  }

  log.debug('Reconciliation complete');
}
