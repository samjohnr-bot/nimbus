import { signRequest } from './auth.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type {
  KalshiMarketsResponse,
  KalshiOrderbookResponse,
  KalshiOrderResponse,
  KalshiPositionsResponse,
  KalshiFillsResponse,
  KalshiBalance,
  KalshiMarket,
  KalshiOrderbook,
  KalshiOrder,
  KalshiPosition,
  KalshiFill,
  CreateOrderParams,
} from './types.js';

const log = createLogger('kalshi');

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

async function request<T>(
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

  const data = await response.json() as T;
  return data;
}

function authedRequest<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  return withRetry(
    () => request<T>(method, path, body),
    `${method} ${path}`,
    { maxRetries: 2 },
  );
}

// --- Market Data ---

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
  const data = await authedRequest<KalshiMarketsResponse>('GET', path);
  return data.markets;
}

export async function getOrderbook(ticker: string): Promise<KalshiOrderbook> {
  const data = await authedRequest<KalshiOrderbookResponse>('GET', `/markets/${ticker}/orderbook`);
  return data.orderbook;
}

// --- Portfolio ---

export async function getBalance(): Promise<KalshiBalance> {
  return authedRequest<KalshiBalance>('GET', '/portfolio/balance');
}

export async function getPositions(): Promise<KalshiPosition[]> {
  const data = await authedRequest<KalshiPositionsResponse>('GET', '/portfolio/positions');
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
  const data = await authedRequest<KalshiFillsResponse>('GET', path);
  return data.fills;
}

// --- Orders ---

export async function createOrder(params: CreateOrderParams): Promise<KalshiOrder> {
  const data = await authedRequest<KalshiOrderResponse>('POST', '/portfolio/orders', {
    ticker: params.ticker,
    action: params.action,
    side: params.side,
    type: params.type,
    count: params.count,
    yes_price: params.yes_price,
  });
  return data.order;
}

export async function cancelOrder(orderId: string): Promise<void> {
  await authedRequest<KalshiOrderResponse>('DELETE', `/portfolio/orders/${orderId}`);
}

export async function getOrder(orderId: string): Promise<KalshiOrder> {
  const data = await authedRequest<KalshiOrderResponse>('GET', `/portfolio/orders/${orderId}`);
  return data.order;
}
