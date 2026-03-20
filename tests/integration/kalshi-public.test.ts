import { describe, it, expect } from 'vitest';
import * as kalshi from '../../src/kalshi/client.js';
import { parseBracketsFromMarkets } from '../../src/weather/distribution.js';
import { buildMarketSnapshot } from '../../src/strategy/edge.js';

/**
 * Integration tests hitting the live Kalshi public API.
 * These use unauthenticated endpoints — no API key needed.
 * They may fail if Kalshi is down or if no KXHIGHCHI markets are open.
 */
describe('Kalshi Public API', () => {
  it('should fetch KXHIGHCHI markets', async () => {
    const markets = await kalshi.getMarkets({
      series_ticker: 'KXHIGHCHI',
      limit: 20,
    });

    expect(markets.length).toBeGreaterThan(0);

    const first = markets[0];
    expect(first.ticker).toContain('KXHIGHCHI');
    expect(first.strikeType).toMatch(/^(greater|less|between)$/);
    expect(typeof first.yesBid).toBe('number');
    expect(typeof first.yesAsk).toBe('number');
    expect(first.yesBid).toBeGreaterThanOrEqual(0);
    expect(first.yesAsk).toBeLessThanOrEqual(100);
  }, 15000);

  it('should fetch an orderbook for a market', async () => {
    // First get a market ticker
    const markets = await kalshi.getMarkets({
      series_ticker: 'KXHIGHCHI',
      limit: 1,
    });
    expect(markets.length).toBeGreaterThan(0);

    const orderbook = await kalshi.getOrderbook(markets[0].ticker);

    expect(orderbook).toHaveProperty('yes');
    expect(orderbook).toHaveProperty('no');
    expect(Array.isArray(orderbook.yes)).toBe(true);
    expect(Array.isArray(orderbook.no)).toBe(true);

    // If there are entries, verify structure
    if (orderbook.yes.length > 0) {
      expect(typeof orderbook.yes[0].price).toBe('number');
      expect(typeof orderbook.yes[0].size).toBe('number');
      expect(orderbook.yes[0].price).toBeGreaterThan(0);
      expect(orderbook.yes[0].price).toBeLessThanOrEqual(100);
    }
  }, 15000);

  it('should parse real markets into brackets', async () => {
    const markets = await kalshi.getMarkets({
      series_ticker: 'KXHIGHCHI',
      limit: 20,
    });

    // Filter to a single event (one day's brackets)
    const eventTicker = markets[0].eventTicker;
    const eventMarkets = markets.filter(m => m.eventTicker === eventTicker);

    const brackets = parseBracketsFromMarkets(eventMarkets);

    expect(brackets.length).toBeGreaterThanOrEqual(3); // at least less, between, greater

    // Should have exactly one 'less' bracket (lowBound null)
    const lessBrackets = brackets.filter(b => b.lowBound === null);
    expect(lessBrackets.length).toBe(1);

    // Should have exactly one 'greater' bracket (highBound null)
    const greaterBrackets = brackets.filter(b => b.highBound === null);
    expect(greaterBrackets.length).toBe(1);

    // Brackets should be sorted by lowBound ascending
    for (let i = 1; i < brackets.length; i++) {
      const prevLow = brackets[i - 1].lowBound ?? -Infinity;
      const currLow = brackets[i].lowBound ?? -Infinity;
      expect(currLow).toBeGreaterThanOrEqual(prevLow);
    }
  }, 15000);

  it('should build market snapshots from real orderbooks', async () => {
    const markets = await kalshi.getMarkets({
      series_ticker: 'KXHIGHCHI',
      limit: 20,
    });

    const eventTicker = markets[0].eventTicker;
    const eventMarkets = markets.filter(m => m.eventTicker === eventTicker);
    const brackets = parseBracketsFromMarkets(eventMarkets);

    // Get orderbook for first bracket
    const orderbook = await kalshi.getOrderbook(brackets[0].ticker);
    const snapshot = buildMarketSnapshot(brackets[0], orderbook);

    expect(snapshot.spread).toBeGreaterThanOrEqual(0);
    expect(snapshot.midpoint).toBeGreaterThanOrEqual(0);
    expect(snapshot.midpoint).toBeLessThanOrEqual(100);
    expect(snapshot.marketImpliedProb).toBeGreaterThanOrEqual(0);
    expect(snapshot.marketImpliedProb).toBeLessThanOrEqual(1);
  }, 15000);
});
