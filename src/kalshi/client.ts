import { signRequest } from './auth.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type {
  KalshiMarketsResponse,
  KalshiOrderbookRawResponse,
  KalshiOrderResponse,
  KalshiPositionsResponse,
  KalshiFillsResponse,
  KalshiBalance,
  KalshiMarket,
  KalshiMarketRaw,
  KalshiOrderbook,
  KalshiOrder,
  KalshiPosition,
  KalshiFill,
  CreateOrderParams,
} from './types.js';

const log = createLogger('kalshi');

// --- Conversion helpers ---

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

function normalizeOrderbook(raw: KalshiOrderbookRawResponse): KalshiOrderbook {
  return {
    yes: raw.orderbook_fp.yes_dollars.map(([price, size]) => ({
      price: dollarsToCents(price),
      size: parseFloat(size),
    })),
    no: raw.orderbook_fp.no_dollars.map(([price, size]) => ({
      price: dollarsToCents(price),
      size: parseFloat(size),
    })),
  };
}

// --- Rate limiter ---

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(maxPerSecond: number) {
    this.maxTokens = maxPerSecond;
    this.tokens = maxPerSecond;
    this.refillRate = maxPerSecond;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

const readLimiter = new RateLimiter(18);
const writeLimiter = new RateLimiter(8);

// --- HTTP layer ---

const PUBLIC_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

async function publicRequest<T>(path: string): Promise<T> {
  await readLimiter.acquire();

  const url = `${PUBLIC_BASE_URL}${path}`;
  log.debug({ method: 'GET', path, public: true }, 'API request');

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kalshi API GET ${path} returned ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

async function authedRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const isWrite = method !== 'GET';
  await (isWrite ? writeLimiter : readLimiter).acquire();

  const url = `${config.kalshi.baseUrl}${path}`;
  const headers = signRequest(method, `/trade-api/v2${path}`);

  const options: RequestInit = {
    method,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  log.debug({ method, path }, 'API request');

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kalshi API ${method} ${path} returned ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

function withRetryWrapper<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  return withRetry(fn, label, { maxRetries: 2 });
}

// --- Market Data (public, no auth needed) ---

export async function getMarkets(params: {
  series_ticker?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}): Promise<KalshiMarket[]> {
  const query = new URLSearchParams();
  if (params.series_ticker) query.set('series_ticker', params.series_ticker);
  if (params.status) query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', params.limit.toString());

  const qs = query.toString();
  const path = `/markets${qs ? `?${qs}` : ''}`;

  const data = await withRetryWrapper(
    () => publicRequest<KalshiMarketsResponse>(path),
    `GET ${path}`,
  );
  return data.markets.map(normalizeMarket);
}

export async function getOrderbook(ticker: string): Promise<KalshiOrderbook> {
  const data = await withRetryWrapper(
    () => publicRequest<KalshiOrderbookRawResponse>(`/markets/${ticker}/orderbook`),
    `GET /markets/${ticker}/orderbook`,
  );
  return normalizeOrderbook(data);
}

// --- Portfolio (requires auth) ---

export async function getBalance(): Promise<KalshiBalance> {
  return withRetryWrapper(
    () => authedRequest<KalshiBalance>('GET', '/portfolio/balance'),
    'GET /portfolio/balance',
  );
}

export async function getPositions(): Promise<KalshiPosition[]> {
  const data = await withRetryWrapper(
    () => authedRequest<KalshiPositionsResponse>('GET', '/portfolio/positions'),
    'GET /portfolio/positions',
  );
  return data.market_positions;
}

export async function getFills(params?: {
  ticker?: string;
  cursor?: string;
  limit?: number;
}): Promise<KalshiFill[]> {
  const query = new URLSearchParams();
  if (params?.ticker) query.set('ticker', params.ticker);
  if (params?.cursor) query.set('cursor', params.cursor);
  if (params?.limit) query.set('limit', params.limit.toString());

  const qs = query.toString();
  const path = `/portfolio/fills${qs ? `?${qs}` : ''}`;
  const data = await withRetryWrapper(
    () => authedRequest<KalshiFillsResponse>('GET', path),
    `GET ${path}`,
  );
  return data.fills;
}

// --- Orders (requires auth) ---

export async function createOrder(params: CreateOrderParams): Promise<KalshiOrder> {
  const data = await withRetryWrapper(
    () => authedRequest<KalshiOrderResponse>('POST', '/portfolio/orders', {
      ticker: params.ticker,
      action: params.action,
      side: params.side,
      type: params.type,
      count: params.count,
      yes_price: params.yes_price,
    }),
    'POST /portfolio/orders',
  );
  return data.order;
}

export async function cancelOrder(orderId: string): Promise<void> {
  await withRetryWrapper(
    () => authedRequest<KalshiOrderResponse>('DELETE', `/portfolio/orders/${orderId}`),
    `DELETE /portfolio/orders/${orderId}`,
  );
}

export async function getOrder(orderId: string): Promise<KalshiOrder> {
  const data = await withRetryWrapper(
    () => authedRequest<KalshiOrderResponse>('GET', `/portfolio/orders/${orderId}`),
    `GET /portfolio/orders/${orderId}`,
  );
  return data.order;
}
