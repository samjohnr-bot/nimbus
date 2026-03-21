import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { TradeResult } from '../types.js';

const log = createLogger('paper:portfolio');

const DATA_FILE = './data/paper-portfolio.json';

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

// Load on startup — force reset to clear bad data from partial fill bug
// TODO: Remove this force-reset after first deploy
const FORCE_RESET_VERSION = 1;
load();
if ((state as unknown as Record<string, unknown>).resetVersion !== FORCE_RESET_VERSION) {
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
  (state as unknown as Record<string, unknown>).resetVersion = FORCE_RESET_VERSION;
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

  const settledTickers = new Map<string, 'yes' | 'no'>();

  // Check each position's market status
  const uniqueTickers = [...new Set(state.positions.map(p => p.ticker))];

  for (const ticker of uniqueTickers) {
    try {
      // Fetch the market's current status
      const markets = await kalshi.getMarkets({
        series_ticker: config.trading.seriesTicker,
        status: 'settled',
        limit: 50,
      });

      for (const m of markets) {
        if (m.result === 'yes' || m.result === 'no') {
          settledTickers.set(m.ticker, m.result as 'yes' | 'no');
        }
      }
      break; // Only need to fetch once
    } catch (error) {
      log.warn({ ticker, error: String(error) }, 'Failed to check settlement');
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
