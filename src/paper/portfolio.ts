import fs from 'node:fs';
import path from 'node:path';
import { config, CITIES } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { TradeResult } from '../types.js';

const log = createLogger('paper:portfolio');

// Use Railway persistent volume if available, otherwise fallback to local data dir
const PERSIST_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const DATA_FILE = path.join(PERSIST_DIR, 'paper-portfolio.json');

interface PaperPosition {
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  avgPrice: number; // cents
  totalCost: number; // cents (price * contracts + fees)
  fee: number;
  entryTime: string;
  rangeLabel: string;
}

interface PaperState {
  balance: number; // cents
  startingBalance: number;
  positions: PaperPosition[];
  settledPnl: number; // cumulative realized P&L in cents
  dailyPnl: number;
  lastResetDate: string; // YYYY-MM-DD
  trades: number;
  wins: number;
  losses: number;
}

let state: PaperState = {
  balance: config.paperBankroll || 15000,
  startingBalance: config.paperBankroll || 15000,
  positions: [],
  settledPnl: 0,
  dailyPnl: 0,
  lastResetDate: new Date().toISOString().split('T')[0],
  trades: 0,
  wins: 0,
  losses: 0,
};

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function save() {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      state = raw;
      log.info({ balance: state.balance, positions: state.positions.length }, 'Paper portfolio loaded');
    }
  } catch {
    log.warn('Failed to load paper portfolio, using defaults');
  }
}

// Load saved state on startup (persists across deploys via Railway volume)
load();

// Force reset if positions were built with the wrong-day forecast bug
// Remove this block after deploy 2026-03-26
const REQUIRED_RESET_VERSION = 3;
if ((state as unknown as Record<string, unknown>)._resetVersion !== REQUIRED_RESET_VERSION) {
  log.info('Force-resetting paper portfolio: clearing positions from wrong-day forecast bug');
  state = {
    balance: config.paperBankroll || 15000,
    startingBalance: config.paperBankroll || 15000,
    positions: [],
    settledPnl: 0,
    dailyPnl: 0,
    lastResetDate: new Date().toISOString().split('T')[0],
    trades: 0,
    wins: 0,
    losses: 0,
  };
  (state as unknown as Record<string, unknown>)._resetVersion = REQUIRED_RESET_VERSION;
  save();
}

/**
 * Reset paper portfolio to fresh state.
 */
export function resetPaperPortfolio(): void {
  state = {
    balance: config.paperBankroll || 15000,
    startingBalance: config.paperBankroll || 15000,
    positions: [],
    settledPnl: 0,
    dailyPnl: 0,
    lastResetDate: new Date().toISOString().split('T')[0],
    trades: 0,
    wins: 0,
    losses: 0,
  };
  save();
  log.info({ balance: state.balance }, 'Paper portfolio reset');
}

/**
 * Check if we already have a paper position in a ticker.
 */
export function hasPaperPosition(ticker: string): boolean {
  return state.positions.some(p => p.ticker === ticker);
}

/**
 * Record paper trades from a cycle's results.
 * Deducts costs from balance and creates positions.
 * Skips tickers we already hold positions in (no double-buying).
 */
export function recordPaperTrades(results: TradeResult[]): void {
  // Check if we need to reset daily P&L
  const today = new Date().toISOString().split('T')[0];
  if (today !== state.lastResetDate) {
    state.dailyPnl = 0;
    state.lastResetDate = today;
  }

  for (const result of results) {
    if (result.status !== 'filled') continue;

    // Skip if we already hold this ticker (don't keep buying every cycle)
    if (hasPaperPosition(result.signal.bracket.ticker)) {
      log.debug({ ticker: result.signal.bracket.ticker }, 'Already holding, skipping');
      continue;
    }

    const cost = result.filledPrice * result.filledContracts + result.signal.fee;

    // Check if we can afford it
    if (cost > state.balance) {
      log.debug(
        { ticker: result.signal.bracket.ticker, cost, balance: state.balance },
        'Insufficient paper balance, skipping',
      );
      continue;
    }

    // Deduct cost
    state.balance -= cost;

    // Check if we already have a position in this ticker/side
    const existing = state.positions.find(
      p => p.ticker === result.signal.bracket.ticker && p.side === result.signal.side,
    );

    if (existing) {
      // Add to existing position
      existing.contracts += result.filledContracts;
      existing.totalCost += cost;
      existing.fee += result.signal.fee;
      existing.avgPrice = Math.round(
        (existing.totalCost - existing.fee) / existing.contracts,
      );
    } else {
      // New position
      state.positions.push({
        ticker: result.signal.bracket.ticker,
        side: result.signal.side,
        contracts: result.filledContracts,
        avgPrice: result.filledPrice,
        totalCost: cost,
        fee: result.signal.fee,
        entryTime: result.timestamp.toISOString(),
        rangeLabel: result.signal.bracket.rangeLabel,
      });
    }

    state.trades++;
    log.info(
      {
        ticker: result.signal.bracket.ticker,
        side: result.signal.side,
        contracts: result.filledContracts,
        price: result.filledPrice,
        cost,
        balance: state.balance,
      },
      'Paper trade recorded',
    );
  }

  save();
}

/**
 * Settle paper positions against market results.
 * Call this when markets have settled for a given event date.
 */
export function settlePaperPositions(
  settledTickers: Map<string, 'yes' | 'no'>,
): void {
  const toRemove: number[] = [];

  for (let i = 0; i < state.positions.length; i++) {
    const pos = state.positions[i];
    const result = settledTickers.get(pos.ticker);
    if (!result) continue;

    // Calculate payout
    const won = (pos.side === 'yes' && result === 'yes') ||
                (pos.side === 'no' && result === 'no');

    const payout = won ? 100 * pos.contracts : 0;
    const pnl = payout - pos.totalCost;

    state.balance += payout;
    state.settledPnl += pnl;
    state.dailyPnl += pnl;

    if (pnl > 0) state.wins++;
    else state.losses++;

    log.info(
      {
        ticker: pos.ticker,
        side: pos.side,
        result,
        won,
        contracts: pos.contracts,
        cost: pos.totalCost,
        payout,
        pnl,
        balance: state.balance,
      },
      'Paper position settled',
    );

    toRemove.push(i);
  }

  // Remove settled positions (reverse order to preserve indices)
  for (const idx of toRemove.reverse()) {
    state.positions.splice(idx, 1);
  }

  if (toRemove.length > 0) {
    save();
  }
}

/**
 * Check for settled markets and settle paper positions.
 */
export async function checkPaperSettlements(): Promise<void> {
  if (state.positions.length === 0) return;

  // Dynamic import to avoid circular deps
  const kalshi = await import('../kalshi/client.js');

  // Get all unique series tickers from CITIES
  const allSeriesTickers = new Set<string>();
  for (const city of CITIES) {
    if (city.high) allSeriesTickers.add(city.high);
    if (city.low) allSeriesTickers.add(city.low);
  }

  // Build set of tickers we actually hold for efficient matching
  const heldTickers = new Set(state.positions.map(p => p.ticker));
  log.info({ heldTickers: [...heldTickers] }, 'Checking settlement for held positions');

  const settledTickers = new Map<string, 'yes' | 'no'>();

  // Only query series that we actually have positions in
  const relevantSeries = new Set<string>();
  for (const ticker of heldTickers) {
    for (const city of CITIES) {
      if (city.high && ticker.startsWith(city.high)) relevantSeries.add(city.high);
      if (city.low && ticker.startsWith(city.low)) relevantSeries.add(city.low);
    }
  }

  for (const seriesTicker of relevantSeries) {
    try {
      // Filter by close time: only look at markets from the last 7 days
      const weekAgo = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000);
      const markets = await kalshi.getMarkets({
        series_ticker: seriesTicker,
        status: 'settled',
        limit: 200,
        min_close_ts: weekAgo.toString(),
      });

      for (const m of markets) {
        // Only track markets we actually hold positions in
        if (heldTickers.has(m.ticker) && (m.result === 'yes' || m.result === 'no')) {
          settledTickers.set(m.ticker, m.result as 'yes' | 'no');
        }
      }
    } catch (error) {
      log.warn({ seriesTicker, error: String(error) }, 'Failed to check settlement for series');
    }
  }

  if (settledTickers.size > 0) {
    settlePaperPositions(settledTickers);
  }
}

/**
 * Get the current paper portfolio state for the dashboard.
 */
export function getPaperState() {
  return {
    balance: state.balance,
    startingBalance: state.startingBalance,
    positions: state.positions.length,
    positionDetails: state.positions,
    settledPnl: state.settledPnl,
    dailyPnl: state.dailyPnl,
    totalPnl: state.balance - state.startingBalance,
    trades: state.trades,
    wins: state.wins,
    losses: state.losses,
    winRate: state.trades > 0 ? state.wins / (state.wins + state.losses) : 0,
  };
}
