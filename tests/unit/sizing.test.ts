import { describe, it, expect } from 'vitest';
import { calculateFee, sizePosition } from '../../src/strategy/sizing.js';
import type { BracketSignal } from '../../src/types.js';

describe('calculateFee', () => {
  it('should be highest at 50¢ contracts', () => {
    // Use 10 contracts so ceil rounding doesn't obscure the difference
    const fee50 = calculateFee(50, 10);
    const fee20 = calculateFee(20, 10);
    const fee80 = calculateFee(80, 10);

    expect(fee50).toBeGreaterThan(fee20);
    expect(fee50).toBeGreaterThan(fee80);
  });

  it('should be symmetric around 50¢', () => {
    const fee30 = calculateFee(30, 1);
    const fee70 = calculateFee(70, 1);
    expect(fee30).toBe(fee70);
  });

  it('should be near zero for extreme prices', () => {
    const fee5 = calculateFee(5, 1);
    const fee95 = calculateFee(95, 1);

    expect(fee5).toBeLessThanOrEqual(1); // ceil rounds up
    expect(fee95).toBeLessThanOrEqual(1);
  });

  it('should scale linearly with contracts', () => {
    const fee1 = calculateFee(50, 1);
    const fee10 = calculateFee(50, 10);

    // Fee is ceil(0.07 * contracts * p * (1-p) * 100)
    // For 1 contract at 50: ceil(0.07 * 1 * 0.5 * 0.5 * 100) = ceil(1.75) = 2
    expect(fee1).toBe(2);
    // For 10 contracts: ceil(0.07 * 10 * 0.5 * 0.5 * 100) = ceil(17.5) = 18
    expect(fee10).toBe(18);
  });

  it('should match Kalshi formula exactly', () => {
    // fee = ceil(0.07 * contracts * (price/100) * (1 - price/100) * 100)
    const fee = calculateFee(65, 5);
    const expected = Math.ceil(0.07 * 5 * 0.65 * 0.35 * 100);
    expect(fee).toBe(expected);
  });
});

describe('sizePosition', () => {
  function makeSignal(overrides: Partial<BracketSignal> = {}): BracketSignal {
    return {
      bracket: { ticker: 'B3', rangeLabel: '80-82°F', lowBound: 80, highBound: 82 },
      side: 'yes',
      modelProb: 0.75,
      marketImpliedProb: 0.62,
      edge: 0.13,
      spread: 4,
      price: 62,
      ...overrides,
    };
  }

  it('should return a trade signal for a valid signal', () => {
    const result = sizePosition(makeSignal(), 100000); // $1000 bankroll in cents
    expect(result).not.toBeNull();
    expect(result!.contracts).toBeGreaterThanOrEqual(1);
    expect(result!.maxCost).toBeLessThanOrEqual(7500); // max trade size
    expect(result!.fee).toBeGreaterThan(0);
  });

  it('should respect 30% bankroll cap per trade', () => {
    const result = sizePosition(makeSignal({ edge: 0.50 }), 10000); // $100 bankroll
    if (result) {
      expect(result.maxCost).toBeLessThanOrEqual(3000); // 30% of 10000
    }
  });

  it('should respect maxTradeSize', () => {
    const result = sizePosition(makeSignal({ edge: 0.50 }), 1000000); // $10k bankroll
    if (result) {
      expect(result.maxCost).toBeLessThanOrEqual(7500); // config default
    }
  });

  it('should return null for negative edge', () => {
    const result = sizePosition(makeSignal({ edge: -0.05 }), 100000);
    expect(result).toBeNull();
  });

  it('should return null when bankroll too small for 1 contract', () => {
    const result = sizePosition(makeSignal({ edge: 0.01, price: 90 }), 100); // $1 bankroll
    expect(result).toBeNull();
  });

  it('should include fee in the trade signal', () => {
    const result = sizePosition(makeSignal(), 100000);
    if (result) {
      const expectedFee = calculateFee(62, result.contracts);
      expect(result.fee).toBe(expectedFee);
    }
  });
});
