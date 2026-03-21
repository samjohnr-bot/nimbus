import type { KalshiMarket, KalshiMarketRaw, KalshiMarketsResponse } from '../kalshi/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('backtest:kalshi');

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Rate limiter: max 10 requests per second to avoid 429s
let lastRequestTime = 0;
async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  const now = Date.now();
  const minGap = 150; // 150ms between requests (~6.6 req/sec)
  const elapsed = now - lastRequestTime;
  if (elapsed < minGap) {
    await new Promise(resolve => setTimeout(resolve, minGap - elapsed));
  }
  lastRequestTime = Date.now();
  return fetch(url, options);
}

function dollarsToCents(dollars: string): number {
  return Math.round(parseFloat(dollars) * 100);
}

function normalizeMarket(raw: KalshiMarketRaw): KalshiMarket {
  return {
    ticker: raw.ticker,
    eventTicker: raw.event_ticker,
    title: raw.title,
    subtitle: raw.subtitle,
    status: raw.status,
    result: raw.result,
    strikeType: raw.strike_type,
    floorStrike: raw.floor_strike ?? null,
    capStrike: raw.cap_strike ?? null,
    yesBid: dollarsToCents(raw.yes_bid_dollars),
    yesAsk: dollarsToCents(raw.yes_ask_dollars),
    noBid: dollarsToCents(raw.no_bid_dollars),
    noAsk: dollarsToCents(raw.no_ask_dollars),
    lastPrice: dollarsToCents(raw.last_price_dollars),
    volume: parseFloat(raw.volume_fp),
    openInterest: parseFloat(raw.open_interest_fp),
    closeTime: raw.close_time,
    expirationTime: raw.expiration_time,
    openTime: raw.open_time,
  };
}

/**
 * Fetch settled KXHIGHCHI markets for a given date from Kalshi's public API.
 * Uses event_ticker date filtering to avoid paginating through all markets.
 */
export async function getHistoricalMarkets(
  seriesTicker: string,
  date: string,
): Promise<KalshiMarket[]> {
  // KXHIGHCHI event tickers follow the pattern: KXHIGHCHI-26MAR12
  // Build the event ticker prefix for this date
  const d = new Date(date + 'T12:00:00Z');
  const year = d.getFullYear().toString().slice(2); // "26"
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const month = months[d.getMonth()];
  const day = d.getDate().toString().padStart(2, '0');
  const eventPrefix = `${seriesTicker}-${year}${month}${day}`;

  // Use min/max close timestamp to narrow the search
  // Kalshi expects Unix epoch seconds (integers)
  const dayStart = new Date(date + 'T00:00:00Z');
  const searchStartTs = Math.floor(dayStart.getTime() / 1000);
  // Markets typically close/expire the day after the event date
  const searchEndTs = searchStartTs + 48 * 60 * 60;

  const query = new URLSearchParams({
    series_ticker: seriesTicker,
    status: 'settled',
    limit: '200',
    min_close_ts: searchStartTs.toString(),
    max_close_ts: searchEndTs.toString(),
  });

  const url = `${KALSHI_API_BASE}/markets?${query}`;
  log.debug({ date, eventPrefix, url }, 'Fetching historical markets');

  const response = await rateLimitedFetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    log.warn({ date, status: response.status, body: text }, 'Kalshi markets API error');
    // If rate limited, wait and retry once
    if (response.status === 429) {
      log.info({ date }, 'Rate limited, waiting 5s and retrying...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      const retry = await rateLimitedFetch(url, {
        headers: { Accept: 'application/json' },
      });
      if (!retry.ok) return [];
      const retryData = (await retry.json()) as KalshiMarketsResponse;
      const filtered = retryData.markets
        .map(normalizeMarket)
        .filter(m => {
          const closeDate = new Date(m.closeTime).toISOString().split('T')[0];
          const expDate = new Date(m.expirationTime).toISOString().split('T')[0];
          return closeDate === date || expDate === date;
        });
      log.info({ date, fetched: retryData.markets.length, matched: filtered.length }, 'Historical markets fetched (retry)');
      return filtered;
    }
    return [];
  }

  const data = (await response.json()) as KalshiMarketsResponse;
  const normalized = data.markets.map(normalizeMarket);

  // Filter to markets that match this specific date
  const dateMarkets = normalized.filter(m => {
    const closeDate = new Date(m.closeTime).toISOString().split('T')[0];
    const expDate = new Date(m.expirationTime).toISOString().split('T')[0];
    return closeDate === date || expDate === date;
  });

  log.info(
    { date, totalFetched: normalized.length, dateMatched: dateMarkets.length },
    'Historical markets fetched',
  );

  return dateMarkets;
}

export interface CandlestickData {
  timestamp: string;
  yesBid: number;  // cents
  yesAsk: number;  // cents
}

/**
 * Fetch candlestick/historical price data for a specific market ticker.
 */
export async function getHistoricalCandlestick(
  ticker: string,
  seriesTicker: string,
): Promise<CandlestickData[] | null> {
  try {
    const url = `${KALSHI_API_BASE}/series/${seriesTicker}/markets/${ticker}/candlesticks?period_interval=1440`;
    log.debug({ ticker, url }, 'Fetching candlestick data');

    const response = await rateLimitedFetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      log.debug({ ticker, status: response.status }, 'Candlestick endpoint not available');
      return null;
    }

    const data = (await response.json()) as {
      candlesticks?: Array<{
        end_period_ts: string;
        yes_bid: number;
        yes_ask: number;
        price: number;
        volume: number;
      }>;
    };

    if (!data.candlesticks || data.candlesticks.length === 0) {
      return null;
    }

    return data.candlesticks.map(c => ({
      timestamp: c.end_period_ts,
      yesBid: Math.round(c.yes_bid * 100),
      yesAsk: Math.round(c.yes_ask * 100),
    }));
  } catch (error) {
    log.debug({ ticker, error: String(error) }, 'Failed to fetch candlestick data');
    return null;
  }
}
