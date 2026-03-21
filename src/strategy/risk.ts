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

export function filterPortfolioRisk(
  allSignals: TradeSignal[],
  balance: number,
): TradeSignal[] {
  // Sort by edge descending — prioritize highest-edge signals
  const sorted = [...allSignals].sort((a, b) => b.edge - a.edge);

  const exposureByCity = new Map<string, number>();
  let totalExposure = 0;
  const approved: TradeSignal[] = [];

  for (const signal of sorted) {
    const cityExposure = exposureByCity.get(signal.cityId) ?? 0;

    // Clamp contracts to maxContractsPerStrike if over
    let contracts = signal.contracts;
    let maxCost = signal.maxCost;
    if (contracts > config.portfolio.maxContractsPerStrike) {
      contracts = config.portfolio.maxContractsPerStrike;
      maxCost = contracts * signal.price + signal.fee;
    }

    // Per-city exposure limit
    if (cityExposure + maxCost > balance * config.portfolio.maxExposurePerCity) {
      log.debug(
        { ticker: signal.bracket.ticker, cityId: signal.cityId, cityExposure, maxCost },
        'Signal rejected: city exposure limit',
      );
      continue;
    }

    // Total portfolio exposure limit (60% of balance)
    if (totalExposure + maxCost > balance * 0.6) {
      log.debug(
        { ticker: signal.bracket.ticker, totalExposure, maxCost },
        'Signal rejected: total exposure limit',
      );
      continue;
    }

    // Approved — update running totals
    exposureByCity.set(signal.cityId, cityExposure + maxCost);
    totalExposure += maxCost;
    approved.push({ ...signal, contracts, maxCost });
  }

  log.info(
    { total: allSignals.length, approved: approved.length, totalExposure },
    'Portfolio risk filter applied',
  );

  return approved;
}

export function getRiskState(): Readonly<RiskState> {
  return state;
}
