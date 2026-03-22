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
  const { maxDailyLoss, edgeThreshold, maxSpread } = config.trading;

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

  return { allowed: true };
}

/**
 * Filter signals through portfolio-level risk constraints.
 * @param existingExposure - total cost of positions already held (from paper portfolio or real)
 * @param startingBankroll - the original bankroll (not current balance) for total deployment cap
 */
export function filterPortfolioRisk(
  allSignals: TradeSignal[],
  balance: number,
  existingExposure: number = 0,
  startingBankroll: number = balance,
): TradeSignal[] {
  // Sort by edge descending — prioritize highest-edge signals
  const sorted = [...allSignals].sort((a, b) => b.edge - a.edge);

  const exposureByCity = new Map<string, number>();
  // Start with existing exposure from held positions
  let totalExposure = existingExposure;
  const approved: TradeSignal[] = [];

  // Hard cap: never deploy more than X% of STARTING bankroll total
  const maxTotalDeployed = startingBankroll * config.portfolio.maxTotalDeployed;

  for (const signal of sorted) {
    const cityExposure = exposureByCity.get(signal.cityId) ?? 0;

    // Clamp contracts to maxContractsPerStrike
    let contracts = Math.min(signal.contracts, config.portfolio.maxContractsPerStrike);
    const fee = Math.ceil(0.07 * (signal.price / 100) * (1 - signal.price / 100) * contracts * 100);
    let maxCost = contracts * signal.price + fee;

    // Per-trade cap: no more than 10% of current balance
    if (maxCost > balance * 0.10) {
      contracts = Math.floor((balance * 0.10) / signal.price);
      if (contracts < 1) continue;
      const newFee = Math.ceil(0.07 * (signal.price / 100) * (1 - signal.price / 100) * contracts * 100);
      maxCost = contracts * signal.price + newFee;
    }

    // Per-city exposure limit
    if (cityExposure + maxCost > startingBankroll * config.portfolio.maxExposurePerCity) {
      log.debug(
        { ticker: signal.bracket.ticker, cityId: signal.cityId, cityExposure, maxCost },
        'Signal rejected: city exposure limit',
      );
      continue;
    }

    // Total deployment cap against starting bankroll
    if (totalExposure + maxCost > maxTotalDeployed) {
      log.debug(
        { ticker: signal.bracket.ticker, totalExposure, maxCost, maxTotalDeployed },
        'Signal rejected: total deployment cap',
      );
      continue;
    }

    // Balance check — can we actually afford this?
    if (maxCost > balance) {
      continue;
    }

    // Approved — update running totals
    exposureByCity.set(signal.cityId, cityExposure + maxCost);
    totalExposure += maxCost;
    approved.push({ ...signal, contracts, maxCost, fee });
  }

  log.info(
    {
      total: allSignals.length,
      approved: approved.length,
      existingExposure,
      newExposure: totalExposure - existingExposure,
      totalExposure,
      maxAllowed: maxTotalDeployed,
    },
    'Portfolio risk filter applied',
  );

  return approved;
}

export function getRiskState(): Readonly<RiskState> {
  return state;
}
