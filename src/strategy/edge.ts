import type { Bracket, BracketProbability, MarketSnapshot, BracketSignal } from '../types.js';
import type { KalshiOrderbook } from '../kalshi/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('edge');

export function buildMarketSnapshot(
  bracket: Bracket,
  orderbook: KalshiOrderbook,
): MarketSnapshot {
  // Orderbook prices are in cents (1-99)
  const bestBidYes = orderbook.yes.length > 0 ? orderbook.yes[0][0] : 0;
  const bestAskYes = orderbook.yes.length > 0
    ? orderbook.yes[orderbook.yes.length - 1][0]
    : 100;
  const bestBidNo = orderbook.no.length > 0 ? orderbook.no[0][0] : 0;
  const bestAskNo = orderbook.no.length > 0
    ? orderbook.no[orderbook.no.length - 1][0]
    : 100;

  // For Kalshi, orderbook.yes = [[price, size], ...] sorted by price
  // Best bid = highest price someone will pay for yes
  // Best ask = lowest price someone will sell yes at
  const yesBids = orderbook.yes.sort((a, b) => b[0] - a[0]);
  const noBids = orderbook.no.sort((a, b) => b[0] - a[0]);

  const topYesBid = yesBids.length > 0 ? yesBids[0][0] : 0;
  const topNoBid = noBids.length > 0 ? noBids[0][0] : 0;

  // Ask for yes = 100 - best no bid
  // Ask for no = 100 - best yes bid
  const computedAskYes = topNoBid > 0 ? 100 - topNoBid : 99;
  const computedAskNo = topYesBid > 0 ? 100 - topYesBid : 99;

  const spread = computedAskYes - topYesBid;
  const midpoint = (computedAskYes + topYesBid) / 2;
  const marketImpliedProb = midpoint / 100;

  return {
    bracket,
    bestBidYes: topYesBid,
    bestAskYes: computedAskYes,
    bestBidNo: topNoBid,
    bestAskNo: computedAskNo,
    spread,
    midpoint,
    marketImpliedProb,
  };
}

export function calculateEdge(
  modelProbs: BracketProbability[],
  snapshots: MarketSnapshot[],
): BracketSignal[] {
  const signals: BracketSignal[] = [];

  for (const { bracket, modelProb } of modelProbs) {
    const snapshot = snapshots.find(s => s.bracket.ticker === bracket.ticker);
    if (!snapshot) continue;

    // Check YES side: model thinks probability is higher than market
    const yesEdge = modelProb - snapshot.bestAskYes / 100;
    if (yesEdge > 0) {
      signals.push({
        bracket,
        side: 'yes',
        modelProb,
        marketImpliedProb: snapshot.bestAskYes / 100,
        edge: yesEdge,
        spread: snapshot.spread,
        price: snapshot.bestAskYes,
      });
    }

    // Check NO side: model thinks probability is lower than market
    const noProb = 1 - modelProb;
    const noEdge = noProb - snapshot.bestAskNo / 100;
    if (noEdge > 0) {
      signals.push({
        bracket,
        side: 'no',
        modelProb: noProb,
        marketImpliedProb: snapshot.bestAskNo / 100,
        edge: noEdge,
        spread: snapshot.spread,
        price: snapshot.bestAskNo,
      });
    }
  }

  // Sort by edge descending
  signals.sort((a, b) => b.edge - a.edge);

  log.info(
    { signalCount: signals.length, topEdge: signals[0]?.edge.toFixed(3) },
    'Edge calculation complete',
  );

  return signals;
}
