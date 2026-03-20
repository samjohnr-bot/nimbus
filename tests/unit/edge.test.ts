import { describe, it, expect } from 'vitest';
import { buildMarketSnapshot, calculateEdge } from '../../src/strategy/edge.js';
import type { Bracket, BracketProbability, MarketSnapshot } from '../../src/types.js';
import type { KalshiOrderbook } from '../../src/kalshi/types.js';

const bracket: Bracket = {
  ticker: 'KXHIGHCHI-B3',
  rangeLabel: '80-82°F',
  lowBound: 80,
  highBound: 82,
};

describe('buildMarketSnapshot', () => {
  it('should compute spread and midpoint from orderbook', () => {
    const orderbook: KalshiOrderbook = {
      yes: [[60, 10], [55, 20]],  // bids at 60 and 55
      no: [[35, 15], [30, 25]],   // bids at 35 and 30
    };

    const snapshot = buildMarketSnapshot(bracket, orderbook);

    // Best yes bid = 60 (highest)
    expect(snapshot.bestBidYes).toBe(60);
    // Ask for yes = 100 - best no bid (35) = 65
    expect(snapshot.bestAskYes).toBe(65);
    // Spread = ask - bid = 65 - 60 = 5
    expect(snapshot.spread).toBe(5);
    // Midpoint = (65 + 60) / 2 = 62.5
    expect(snapshot.midpoint).toBe(62.5);
    expect(snapshot.marketImpliedProb).toBeCloseTo(0.625, 3);
  });

  it('should handle empty orderbook with defaults', () => {
    const orderbook: KalshiOrderbook = { yes: [], no: [] };
    const snapshot = buildMarketSnapshot(bracket, orderbook);

    expect(snapshot.bestBidYes).toBe(0);
    expect(snapshot.bestAskYes).toBe(99);
    expect(snapshot.spread).toBe(99);
    expect(snapshot.midpoint).toBe(49.5);
  });

  it('should handle one-sided orderbook', () => {
    const orderbook: KalshiOrderbook = {
      yes: [[70, 5]],
      no: [],
    };
    const snapshot = buildMarketSnapshot(bracket, orderbook);

    expect(snapshot.bestBidYes).toBe(70);
    // No no-side bids → ask defaults to 99
    expect(snapshot.bestAskYes).toBe(99);
    // Ask for no = 100 - best yes bid = 30
    expect(snapshot.bestAskNo).toBe(30);
  });
});

describe('calculateEdge', () => {
  function makeSnapshot(ticker: string, askYes: number, askNo: number, spread: number): MarketSnapshot {
    return {
      bracket: { ticker, rangeLabel: '', lowBound: null, highBound: null },
      bestBidYes: askYes - spread,
      bestAskYes: askYes,
      bestBidNo: askNo - spread,
      bestAskNo: askNo,
      spread,
      midpoint: (askYes + askYes - spread) / 2,
      marketImpliedProb: askYes / 100,
    };
  }

  it('should detect YES edge when model prob > market ask', () => {
    const modelProbs: BracketProbability[] = [
      { bracket: { ticker: 'B3', rangeLabel: '', lowBound: 80, highBound: 82 }, modelProb: 0.75 },
    ];
    const snapshots: MarketSnapshot[] = [
      makeSnapshot('B3', 62, 42, 4), // market ask yes = 62¢ → 0.62 implied
    ];

    const signals = calculateEdge(modelProbs, snapshots);

    const yesSig = signals.find(s => s.side === 'yes');
    expect(yesSig).toBeDefined();
    expect(yesSig!.edge).toBeCloseTo(0.13, 2); // 0.75 - 0.62
    expect(yesSig!.price).toBe(62);
  });

  it('should detect NO edge when model prob is low', () => {
    const modelProbs: BracketProbability[] = [
      { bracket: { ticker: 'B1', rangeLabel: '', lowBound: null, highBound: 78 }, modelProb: 0.05 },
    ];
    const snapshots: MarketSnapshot[] = [
      makeSnapshot('B1', 20, 84, 4), // ask no = 84¢ → 0.84 for no
    ];

    const signals = calculateEdge(modelProbs, snapshots);

    // noProb = 1 - 0.05 = 0.95, noEdge = 0.95 - 0.84 = 0.11
    const noSig = signals.find(s => s.side === 'no');
    expect(noSig).toBeDefined();
    expect(noSig!.edge).toBeCloseTo(0.11, 2);
  });

  it('should return no signals when market is fairly priced', () => {
    const modelProbs: BracketProbability[] = [
      { bracket: { ticker: 'B3', rangeLabel: '', lowBound: 80, highBound: 82 }, modelProb: 0.50 },
    ];
    const snapshots: MarketSnapshot[] = [
      makeSnapshot('B3', 52, 52, 4), // ask yes = 52, ask no = 52 → both sides ~0.50
    ];

    const signals = calculateEdge(modelProbs, snapshots);

    // Model says 0.50, ask yes is 0.52 → negative edge on yes
    // No prob = 0.50, ask no is 0.52 → negative edge on no
    expect(signals).toHaveLength(0);
  });

  it('should sort signals by edge descending', () => {
    const modelProbs: BracketProbability[] = [
      { bracket: { ticker: 'B2', rangeLabel: '', lowBound: 78, highBound: 80 }, modelProb: 0.30 },
      { bracket: { ticker: 'B3', rangeLabel: '', lowBound: 80, highBound: 82 }, modelProb: 0.50 },
    ];
    const snapshots: MarketSnapshot[] = [
      makeSnapshot('B2', 15, 88, 4), // yes edge = 0.30 - 0.15 = 0.15
      makeSnapshot('B3', 40, 64, 4), // yes edge = 0.50 - 0.40 = 0.10
    ];

    const signals = calculateEdge(modelProbs, snapshots);

    // Should be sorted: B2 yes (0.15) before B3 yes (0.10)
    expect(signals.length).toBeGreaterThan(0);
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i].edge).toBeLessThanOrEqual(signals[i - 1].edge);
    }
  });
});
