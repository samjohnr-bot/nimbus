import { config } from '../config.js';
import type { BracketSignal, TradeSignal } from '../types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sizing');

export function calculateFee(priceInCents: number, contracts: number): number {
  const priceInDollars = priceInCents / 100;
  const feePerContract = 0.07 * priceInDollars * (1 - priceInDollars);
  return Math.ceil(feePerContract * contracts * 100); // return in cents
}

export function sizePosition(
  signal: BracketSignal,
  availableBankroll: number,
  cityId: string = config.trading.city,
  seriesTicker: string = config.trading.seriesTicker,
): TradeSignal | null {
  const { edge, price, modelProb } = signal;
  const priceInDollars = price / 100;
  const { kellyFraction, maxTradeSize } = config.trading;

  // Fractional Kelly: f* = kelly * (edge / (1 - priceInDollars))
  // This is the fraction of bankroll to risk
  const kellyBet = kellyFraction * (edge / (1 - priceInDollars));

  if (kellyBet <= 0) return null;

  // Max dollar amount to spend
  const maxSpend = Math.min(
    kellyBet * availableBankroll,
    maxTradeSize,
    availableBankroll * 0.3, // never more than 30% of bankroll on one trade
  );

  // Convert to contracts (each contract costs `price` cents)
  const contracts = Math.floor(maxSpend / price);

  if (contracts < 1) return null;

  const maxCost = contracts * price;
  const fee = calculateFee(price, contracts);

  // Verify edge still positive after fees
  const effectiveEdge = edge - fee / (contracts * 100);
  if (effectiveEdge <= 0) {
    log.debug(
      { ticker: signal.bracket.ticker, edge, fee, effectiveEdge },
      'Edge eliminated by fees, skipping',
    );
    return null;
  }

  log.debug(
    {
      ticker: signal.bracket.ticker,
      contracts,
      price,
      maxCost,
      fee,
      kellyBet: kellyBet.toFixed(4),
    },
    'Position sized',
  );

  return {
    ...signal,
    cityId,
    seriesTicker,
    contracts,
    maxCost,
    fee,
  };
}
