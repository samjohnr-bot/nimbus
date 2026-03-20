import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import * as kalshi from '../kalshi/client.js';
import { getEnsembleForecast } from '../weather/openmeteo.js';
import { buildDistribution, parseBracketsFromMarkets } from '../weather/distribution.js';
import { buildMarketSnapshot, calculateEdge } from './edge.js';
import { sizePosition } from './sizing.js';
import { checkTradeAllowed } from './risk.js';
import type { TradeSignal, MarketSnapshot } from '../types.js';

const log = createLogger('signals');

function getTomorrowDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

export async function generateSignals(balance: number): Promise<TradeSignal[]> {
  const targetDate = getTomorrowDate();
  log.info({ targetDate, balance }, 'Generating signals');

  // 1. Fetch bracket markets from Kalshi
  const markets = await kalshi.getMarkets({
    series_ticker: config.trading.seriesTicker,
    status: 'open',
  });

  // Filter to tomorrow's markets by matching the event ticker date
  // Event tickers look like KXHIGHCHI-26MAR20 for March 20, 2026
  const tomorrowMarkets = markets.filter(m => {
    const closeDate = new Date(m.closeTime).toISOString().split('T')[0];
    const expDate = new Date(m.expirationTime).toISOString().split('T')[0];
    return closeDate === targetDate || expDate === targetDate;
  });

  if (tomorrowMarkets.length === 0) {
    log.info({ targetDate }, 'No markets found for tomorrow');
    return [];
  }

  log.info({ count: tomorrowMarkets.length, targetDate }, 'Found bracket markets');

  // 2. Parse brackets from market data
  const brackets = parseBracketsFromMarkets(tomorrowMarkets);

  // 3. Fetch ensemble forecast
  const forecast = await getEnsembleForecast(targetDate);

  // Check data freshness
  const dataAge = (Date.now() - forecast.modelTimestamp.getTime()) / 1000;
  if (dataAge > config.trading.dataMaxAge) {
    log.warn({ dataAge, maxAge: config.trading.dataMaxAge }, 'Weather data too stale');
    return [];
  }

  // 4. Build probability distribution
  const distribution = buildDistribution(forecast, brackets);

  // 5. Get orderbooks and build market snapshots
  const snapshots: MarketSnapshot[] = [];
  for (const bracket of brackets) {
    const orderbook = await kalshi.getOrderbook(bracket.ticker);
    snapshots.push(buildMarketSnapshot(bracket, orderbook));
  }

  // 6. Calculate edge for all brackets
  const rawSignals = calculateEdge(distribution, snapshots);

  // 7. Size and filter signals
  const tradeSignals: TradeSignal[] = [];

  for (const signal of rawSignals) {
    const sized = sizePosition(signal, balance);
    if (!sized) continue;

    const check = checkTradeAllowed(sized, balance);
    if (!check.allowed) {
      log.debug(
        { ticker: signal.bracket.ticker, reason: check.reason },
        'Signal rejected by risk',
      );
      continue;
    }

    tradeSignals.push(sized);
  }

  log.info(
    {
      raw: rawSignals.length,
      approved: tradeSignals.length,
      targetDate,
    },
    'Signal generation complete',
  );

  return tradeSignals;
}
