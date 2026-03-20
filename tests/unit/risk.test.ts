import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetDaily,
  updatePnl,
  updateExposure,
  isDailyLossBreached,
  checkTradeAllowed,
  getRiskState,
} from '../../src/strategy/risk.js';
import type { TradeSignal } from '../../src/types.js';

function makeTradeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    bracket: { ticker: 'B3', rangeLabel: '80-82°F', lowBound: 80, highBound: 82 },
    side: 'yes',
    modelProb: 0.75,
    marketImpliedProb: 0.62,
    edge: 0.13,
    spread: 4,
    price: 62,
    contracts: 5,
    maxCost: 310,
    fee: 8,
    ...overrides,
  };
}

describe('risk management', () => {
  beforeEach(() => {
    resetDaily();
  });

  describe('daily loss limit', () => {
    it('should not be breached initially', () => {
      expect(isDailyLossBreached()).toBe(false);
    });

    it('should be breached when losses exceed limit', () => {
      updatePnl(-15000); // -$150, equals maxDailyLoss
      expect(isDailyLossBreached()).toBe(true);
    });

    it('should not be breached with small losses', () => {
      updatePnl(-5000); // -$50
      expect(isDailyLossBreached()).toBe(false);
    });

    it('should accumulate losses across multiple updates', () => {
      updatePnl(-5000);
      updatePnl(-5000);
      updatePnl(-5000); // total: -$150
      expect(isDailyLossBreached()).toBe(true);
    });

    it('should net gains against losses', () => {
      updatePnl(-10000);
      updatePnl(5000); // net: -$50
      expect(isDailyLossBreached()).toBe(false);
    });
  });

  describe('resetDaily', () => {
    it('should clear all counters', () => {
      updatePnl(-10000);
      updateExposure(5000, new Map([['B3', 5000]]));

      resetDaily();

      const state = getRiskState();
      expect(state.dailyPnl).toBe(0);
      expect(state.totalExposure).toBe(0);
      expect(state.positionsByTicker.size).toBe(0);
    });
  });

  describe('checkTradeAllowed', () => {
    it('should allow a valid trade', () => {
      const result = checkTradeAllowed(makeTradeSignal(), 100000);
      expect(result.allowed).toBe(true);
    });

    it('should reject when daily loss breached', () => {
      updatePnl(-15000);
      const result = checkTradeAllowed(makeTradeSignal(), 100000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('daily_loss_limit');
    });

    it('should reject when edge below threshold', () => {
      const result = checkTradeAllowed(
        makeTradeSignal({ edge: 0.05 }), // below 0.08 default
        100000,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('edge_too_low');
    });

    it('should reject when spread too wide', () => {
      const result = checkTradeAllowed(
        makeTradeSignal({ spread: 12 }), // above 8 default
        100000,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('spread_too_wide');
    });

    it('should reject when trade exceeds 30% of balance', () => {
      const result = checkTradeAllowed(
        makeTradeSignal({ maxCost: 400 }),
        1000, // $10 balance, 30% = $3 = 300 cents
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('insufficient_balance');
    });

    it('should reject when total exposure would exceed 60%', () => {
      updateExposure(55000, new Map()); // already 55% of 100000
      const result = checkTradeAllowed(
        makeTradeSignal({ maxCost: 6000 }), // would push to 61%
        100000,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('exposure_limit');
    });

    it('should allow when exposure stays under 60%', () => {
      updateExposure(40000, new Map());
      const result = checkTradeAllowed(
        makeTradeSignal({ maxCost: 310 }),
        100000,
      );
      expect(result.allowed).toBe(true);
    });
  });
});
