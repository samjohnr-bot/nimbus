import type { Bracket, BracketProbability, MarketSnapshot, BracketSignal } from '../types.js';
import type { KalshiOrderbook } from '../kalshi/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('edge');

export function buildMarketSnapshot(
  bracket: Bracket,
  orderbook: KalshiOrderbook,
): MarketSnapshot {
  // Orderbook entries are { price, size } in cents, sorted ascending by price.
  // Yes side: people bidding to buy yes contracts.
  //   Best yes bid = highest price → last entry
  // No side: people bidding to buy no contracts.
  //   Best no bid = highest price → last entry
  //   Ask for yes = 100 - best no bid (buying yes = selling no)
  //   Ask for no = 100 - best yes bid

  const yesSorted = [...orderbook.yes].sort((a, b) => a.price - b.price);
  const noSorted = [...orderbook.no].sort((a, b) => a.price - b.price);

  const topYesBid = yesSorted.length > 0 ? yesSorted[yesSorted.length - 1].price : 0;
  const topNoBid = noSorted.length > 0 ? noSorted[noSorted.length - 1].price : 0;

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
