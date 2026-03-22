import { config } from '../config.js';
import * as kalshi from '../kalshi/client.js';
import { createLogger } from '../utils/logger.js';
import type { TradeSignal, TradeResult } from '../types.js';

const log = createLogger('executor');

const FILL_WAIT_MS = 60_000;
const FILL_POLL_INTERVAL_MS = 5_000;
const MAX_RETRIES = 2;

async function waitForFill(orderId: string): Promise<'executed' | 'resting' | 'canceled'> {
  const deadline = Date.now() + FILL_WAIT_MS;

  while (Date.now() < deadline) {
    const order = await kalshi.getOrder(orderId);

    if (order.status === 'executed') return 'executed';
    if (order.status === 'canceled') return 'canceled';
    if (order.remaining_count === 0) return 'executed';

    await new Promise(resolve => setTimeout(resolve, FILL_POLL_INTERVAL_MS));
  }

  return 'resting';
}

async function attemptOrder(
  signal: TradeSignal,
  price: number,
): Promise<TradeResult | null> {
  if (config.dryRun) {
    // Simulate realistic order book depth for paper trading
    // Weather markets typically have 10-30 contracts at any price level
    const maxRealisticFill = Math.min(signal.contracts, 15 + Math.floor(Math.random() * 16)); // 15-30
    const filledContracts = Math.min(signal.contracts, maxRealisticFill);

    if (filledContracts < 1) {
      return {
        signal,
        orderId: 'dry-run',
        status: 'cancelled',
        filledContracts: 0,
        filledPrice: price,
        timestamp: new Date(),
      };
    }

    log.info(
      {
        ticker: signal.bracket.ticker,
        side: signal.side,
        price,
        requestedContracts: signal.contracts,
        filledContracts,
        edge: signal.edge.toFixed(3),
        dryRun: true,
      },
      'DRY RUN — simulated partial fill',
    );
    return {
      signal,
      orderId: 'dry-run',
      status: 'filled',
      filledContracts,
      filledPrice: price,
      timestamp: new Date(),
    };
  }

  try {
    const yesPrice = signal.side === 'yes' ? price : 100 - price;
    log.info(
      {
        ticker: signal.bracket.ticker,
        side: signal.side,
        price,
        yesPrice,
        contracts: signal.contracts,
        edge: signal.edge.toFixed(3),
      },
      'Placing order',
    );

    const order = await kalshi.createOrder({
      ticker: signal.bracket.ticker,
      action: 'buy',
      side: signal.side,
      type: 'limit',
      count: signal.contracts,
      yes_price: yesPrice,
    });

    log.info(
      {
        orderId: order.order_id,
        status: order.status,
        ticker: signal.bracket.ticker,
        side: signal.side,
        price,
        contracts: signal.contracts,
      },
      'Order placed',
    );

    // If immediately executed, great
    if (order.status === 'executed' || order.remaining_count === 0) {
      const filledContracts = signal.contracts - order.remaining_count;
      log.info({ orderId: order.order_id, filledContracts }, 'Order filled immediately');
      return {
        signal,
        orderId: order.order_id,
        status: 'filled',
        filledContracts,
        filledPrice: price,
        timestamp: new Date(),
      };
    }

    const fillStatus = await waitForFill(order.order_id);

    if (fillStatus === 'executed') {
      // Re-fetch order to get actual filled count
      const finalOrder = await kalshi.getOrder(order.order_id);
      const filledContracts = signal.contracts - finalOrder.remaining_count;
      log.info({ orderId: order.order_id, filledContracts }, 'Order filled');
      return {
        signal,
        orderId: order.order_id,
        status: 'filled',
        filledContracts,
        filledPrice: price,
        timestamp: new Date(),
      };
    }

    // Not filled — cancel and report as resting (not a failure)
    try {
      await kalshi.cancelOrder(order.order_id);
    } catch (cancelErr) {
      log.warn({ orderId: order.order_id, error: String(cancelErr) }, 'Cancel failed (may already be filled)');
    }
    log.info({ orderId: order.order_id, fillStatus }, 'Order cancelled (no fill within timeout)');
    return {
      signal,
      orderId: order.order_id,
      status: 'cancelled',
      filledContracts: 0,
      filledPrice: price,
      timestamp: new Date(),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMsg, ticker: signal.bracket.ticker, side: signal.side, price }, 'Order failed');
    return {
      signal,
      orderId: '',
      status: 'failed',
      filledContracts: 0,
      filledPrice: 0,
      timestamp: new Date(),
      error: errorMsg,
    };
  }
}

export async function executeSignals(signals: TradeSignal[]): Promise<TradeResult[]> {
  const results: TradeResult[] = [];

  for (const signal of signals) {
    let result: TradeResult | null = null;

    // Try at asking price, then improve by 1 cent up to MAX_RETRIES times
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // For YES buys, increase price to be more aggressive (higher yes price).
      // For NO buys, decrease price to be more aggressive (lower no price = higher yes price).
      const priceAdjust = signal.side === 'no' ? -attempt : attempt;
      const price = signal.price + priceAdjust;
      if (price >= 99 || price <= 1) break;

      result = await attemptOrder(signal, price);
      if (result && result.status === 'filled') break;

      // If cancelled (no fill), try again at worse price
      if (result && result.status === 'cancelled') {
        log.debug(
          { ticker: signal.bracket.ticker, attempt, nextPrice: price + 1 },
          'Retrying at worse price',
        );
        continue;
      }

      // If failed (API error), don't retry
      if (result && result.status === 'failed') break;
    }

    if (result) {
      results.push(result);
    }
  }

  log.info(
    {
      attempted: signals.length,
      filled: results.filter(r => r.status === 'filled').length,
      failed: results.filter(r => r.status === 'failed').length,
    },
    'Execution complete',
  );

  return results;
}
