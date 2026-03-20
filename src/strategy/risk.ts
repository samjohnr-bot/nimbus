import { config } from '../config.js';
import type { TradeSignal } from '../types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('risk');

interface RiskState {
  dailyPnl: number;
  totalExposure: number;
  positionsByTicker: Map<string, number>;
}

let state: RiskState = {
  dailyPnl: 0,
  totalExposure: 0,
  positionsByTicker: new Map(),
};

export function resetDaily(): void {
  state = {
    dailyPnl: 0,
    totalExposure: 0,
    positionsByTicker: new Map(),
  };
  log.info('Daily risk counters reset');
}

export function updatePnl(pnl: number): void {
  state.dailyPnl += pnl;
}

export function updateExposure(totalExposure: number, positions: Map<string, number>): void {
  state.totalExposure = totalExposure;
  state.positionsByTicker = positions;
}

export function isDailyLossBreached(): boolean {
  const breached = state.dailyPnl <= -config.trading.maxDailyLoss;
  if (breached) {
    log.warn({ dailyPnl: state.dailyPnl, limit: config.trading.maxDailyLoss }, 'Daily loss limit breached');
  }
  return breached;
}

export function checkTradeAllowed(
  signal: TradeSignal,
  balance: number,
): { allowed: boolean; reason?: string } {
  const { maxDailyLoss, edgeThreshold, maxSpread, maxTradeSize } = config.trading;

  // Daily loss limit
  if (state.dailyPnl <= -maxDailyLoss) {
    return { allowed: false, reason: 'daily_loss_limit' };
  }

  // Edge threshold
  if (signal.edge < edgeThreshold) {
    return { allowed: false, reason: `edge_too_low: ${signal.edge.toFixed(3)} < ${edgeThreshold}` };
  }

  // Spread check
  if (signal.spread > maxSpread) {
    return { allowed: false, reason: `spread_too_wide: ${signal.spread} > ${maxSpread}` };
  }

  // Per-trade size cap
  if (signal.maxCost > maxTradeSize) {
    return { allowed: false, reason: `trade_too_large: ${signal.maxCost} > ${maxTradeSize}` };
  }

  // Balance check
  if (signal.maxCost > balance * 0.3) {
    return { allowed: false, reason: 'insufficient_balance' };
  }

  // Total exposure check: no more than 60% of balance deployed
  if (state.totalExposure + signal.maxCost > balance * 0.6) {
    return { allowed: false, reason: 'exposure_limit' };
  }

  return { allowed: true };
}

export function getRiskState(): Readonly<RiskState> {
  return state;
}
