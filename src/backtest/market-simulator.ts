import type { KalshiOrderbook } from '../kalshi/types.js';
import type { Bracket } from '../types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('backtest:simulator');

/**
 * Synthesize a KalshiOrderbook from bid/ask prices (in cents).
 * Creates a single-level orderbook that buildMarketSnapshot can consume.
 */
export function synthesizeOrderbook(yesBid: number, yesAsk: number): KalshiOrderbook {
  // Ensure valid price range (1-99 cents)
  yesBid = Math.max(1, Math.min(99, yesBid));
  yesAsk = Math.max(1, Math.min(99, yesAsk));

  // Ensure bid <= ask
  if (yesBid > yesAsk) {
    const mid = Math.round((yesBid + yesAsk) / 2);
    yesBid = mid;
    yesAsk = mid;
  }

  // No side: noBid = 100 - yesAsk, noAsk = 100 - yesBid
  const noBid = 100 - yesAsk;
  const noAsk = 100 - yesBid;

  return {
    yes: [{ price: yesBid, size: 100 }],
    no: [{ price: noBid, size: 100 }],
  };
}

/**
 * Estimate market prices from a settled market's result and last price.
 * When we don't have candlestick data, we approximate what the orderbook
 * might have looked like based on the market's properties.
 *
 * For settled markets, yesBid/yesAsk represent the last known prices.
 * We add a synthetic spread around those prices.
 */
export function estimateOrderbookFromMarket(
  yesBid: number,
  yesAsk: number,
  lastPrice: number,
): KalshiOrderbook {
  // Settled markets have bid=0, ask=100 (meaningless post-settlement).
  // Use lastPrice (the last traded price before settlement) as the reference.
  const isSettled = (yesBid === 0 && yesAsk >= 99) || (yesBid === 0 && yesAsk === 0);

  if (isSettled || yesBid === 0) {
    if (lastPrice > 0 && lastPrice < 100) {
      // Estimate a spread around the last traded price
      // Typical KXHIGHCHI spreads are 2-5 cents
      const halfSpread = Math.max(2, Math.round(lastPrice * 0.05));
      const bid = Math.max(1, lastPrice - halfSpread);
      const ask = Math.min(99, lastPrice + halfSpread);
      return synthesizeOrderbook(bid, ask);
    } else {
      // No usable price — use a wide spread around 50
      return synthesizeOrderbook(45, 55);
    }
  }

  return synthesizeOrderbook(yesBid, yesAsk);
}

/**
 * Determine settlement value for a position.
 * Returns payout in cents per contract.
 *
 * - If you bought YES and the bracket wins: you get 100 cents
 * - If you bought YES and the bracket loses: you get 0
 * - If you bought NO and the bracket loses: you get 100 cents
 * - If you bought NO and the bracket wins: you get 0
 */
export function settlePosition(
  side: 'yes' | 'no',
  bracketWon: boolean,
): number {
  if (side === 'yes') {
    return bracketWon ? 100 : 0;
  } else {
    return bracketWon ? 0 : 100;
  }
}

/**
 * Check if an actual temperature falls within a bracket.
 */
export function temperatureInBracket(temp: number, bracket: Bracket): boolean {
  const roundedTemp = Math.round(temp);
  const { lowBound, highBound } = bracket;

  // Open-ended low bracket: temp < highBound
  if (lowBound === null && highBound !== null) {
    return roundedTemp < highBound;
  }

  // Open-ended high bracket: temp > lowBound
  if (lowBound !== null && highBound === null) {
    return roundedTemp > lowBound;
  }

  // Bounded bracket: lowBound <= temp <= highBound
  if (lowBound !== null && highBound !== null) {
    return roundedTemp >= lowBound && roundedTemp <= highBound;
  }

  return false;
}
