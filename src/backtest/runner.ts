import { createLogger } from '../utils/logger.js';
import { buildDistribution, parseBracketsFromMarkets } from '../weather/distribution.js';
import { buildMarketSnapshot, calculateEdge } from '../strategy/edge.js';
import { sizePosition } from '../strategy/sizing.js';
import { checkTradeAllowed } from '../strategy/risk.js';
import { resetDaily as resetRisk } from '../strategy/risk.js';
import { getHistoricalForecast, getHistoricalActual } from './historical-weather.js';
import { getHistoricalMarkets } from './historical-kalshi.js';
import { estimateOrderbookFromMarket, settlePosition, temperatureInBracket } from './market-simulator.js';
import {
  BacktestTracker,
  printSummary,
  writeResults,
  type DailyResult,
  type PositionResult,
} from './results.js';
import type { TradeSignal, MarketSnapshot, Bracket } from '../types.js';

const log = createLogger('backtest:runner');

export interface BacktestConfig {
  startDate: string;
  endDate: string;
  bankroll: number;         // cents
  seriesTicker: string;
  lat: number;
  lon: number;
  rateLimitMs: number;      // delay between dates to respect rate limits
  outputDir: string;
}

const DEFAULT_CONFIG: BacktestConfig = {
  startDate: '2025-06-01',
  endDate: '2025-12-31',
  bankroll: 15000,          // $150 in cents
  seriesTicker: 'KXHIGHCHI',
  lat: 41.85,
  lon: -87.65,
  rateLimitMs: 1500,
  outputDir: './data/backtest',
};

/**
 * Generate all dates in a range (inclusive).
 */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');

  while (current <= last) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run the full backtest over a date range.
 */
export async function runBacktest(
  overrides: Partial<BacktestConfig> = {},
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const dates = dateRange(cfg.startDate, cfg.endDate);

  log.info(
    {
      startDate: cfg.startDate,
      endDate: cfg.endDate,
      totalDates: dates.length,
      bankroll: cfg.bankroll,
      seriesTicker: cfg.seriesTicker,
    },
    'Starting backtest',
  );

  const tracker = new BacktestTracker(cfg.bankroll);
  let skippedDays = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const progress = `[${i + 1}/${dates.length}]`;

    try {
      const result = await processDate(date, cfg, tracker.bankroll);

      if (result) {
        tracker.addDailyResult(result);
        if (result.tradesPlaced > 0) {
          log.info(
            {
              progress,
              date,
              trades: result.tradesPlaced,
              pnl: result.dailyPnl,
              bankroll: result.bankroll,
            },
            'Day completed with trades',
          );
        } else {
          log.debug({ progress, date }, 'Day completed, no trades');
        }
      } else {
        skippedDays++;
        log.debug({ progress, date }, 'Day skipped (missing data)');
      }
    } catch (error) {
      skippedDays++;
      log.warn({ progress, date, error: String(error) }, 'Day failed, skipping');
    }

    // Rate limit between dates
    if (i < dates.length - 1) {
      await sleep(cfg.rateLimitMs);
    }
  }

  // Compute and display results
  const summary = tracker.computeSummary(cfg.startDate, cfg.endDate);
  printSummary(summary);

  // Write results to file
  const filepath = writeResults(summary, cfg.outputDir);

  log.info(
    {
      skippedDays,
      tradingDays: summary.tradingDays,
      totalPnl: summary.totalPnl,
      filepath,
    },
    'Backtest complete',
  );
}

/**
 * Process a single date in the backtest.
 */
async function processDate(
  date: string,
  cfg: BacktestConfig,
  currentBankroll: number,
): Promise<DailyResult | null> {
  // Reset risk state for each day
  resetRisk();

  // 1. Get historical forecast (what model predicted the day before)
  const forecast = await getHistoricalForecast(date, cfg.lat, cfg.lon);
  if (!forecast) {
    return null;
  }

  // 2. Get bracket markets for this date
  const markets = await getHistoricalMarkets(cfg.seriesTicker, date);
  if (markets.length === 0) {
    return null;
  }

  // 3. Parse brackets from markets (reuse existing function)
  const brackets = parseBracketsFromMarkets(markets);
  if (brackets.length === 0) {
    return null;
  }

  // 4. Build distribution from historical forecast (reuse existing function)
  const distribution = buildDistribution(forecast, brackets);

  // Find model's top bracket prediction
  const sortedByProb = [...distribution].sort((a, b) => b.modelProb - a.modelProb);
  const modelTopBracket = sortedByProb[0].bracket.rangeLabel;
  const modelTopProb = sortedByProb[0].modelProb;

  // 5. Synthesize orderbooks from historical market data
  const snapshots: MarketSnapshot[] = [];
  for (const bracket of brackets) {
    const market = markets.find(m => m.ticker === bracket.ticker);
    if (!market) continue;

    const orderbook = estimateOrderbookFromMarket(
      market.yesBid,
      market.yesAsk,
      market.lastPrice,
    );
    snapshots.push(buildMarketSnapshot(bracket, orderbook));
  }

  // 6. Calculate edge (reuse existing function)
  const rawSignals = calculateEdge(distribution, snapshots);

  // 7. Size positions and risk check (reuse existing functions)
  const trades: TradeSignal[] = [];
  for (const signal of rawSignals) {
    const sized = sizePosition(signal, currentBankroll);
    if (!sized) continue;

    const check = checkTradeAllowed(sized, currentBankroll);
    if (!check.allowed) continue;

    trades.push(sized);
  }

  // 8. Get actual temperature for settlement
  const actualTemp = await getHistoricalActual(date, cfg.lat, cfg.lon);
  if (actualTemp === null) {
    // Can't settle without actual temperature
    return null;
  }

  // 9. Find the winning bracket
  const winningBracket = brackets.find(b => temperatureInBracket(actualTemp, b));
  const winningBracketLabel = winningBracket?.rangeLabel ?? null;

  // Check if model's top prediction was correct
  const predictionCorrect = winningBracket
    ? sortedByProb[0].bracket.ticker === winningBracket.ticker
    : false;

  // 10. Settle positions and calculate P&L
  const positions: PositionResult[] = [];
  let dailyPnl = 0;

  for (const trade of trades) {
    const bracketWon = winningBracket
      ? trade.bracket.ticker === winningBracket.ticker
      : false;

    const payoutPerContract = settlePosition(trade.side, bracketWon);
    const totalPayout = payoutPerContract * trade.contracts;
    const totalCost = trade.price * trade.contracts + trade.fee;
    const pnl = totalPayout - totalCost;

    const won = pnl > 0;

    positions.push({
      ticker: trade.bracket.ticker,
      rangeLabel: trade.bracket.rangeLabel,
      side: trade.side,
      contracts: trade.contracts,
      price: trade.price,
      cost: totalCost,
      fee: trade.fee,
      payout: totalPayout,
      pnl,
      edge: trade.edge,
      modelProb: trade.modelProb,
      won,
    });

    dailyPnl += pnl;
  }

  const newBankroll = currentBankroll + dailyPnl;

  // Compute cumulative P&L
  const cumulativePnl = newBankroll - cfg.bankroll;

  return {
    date,
    actualTemp: Math.round(actualTemp),
    winningBracket: winningBracketLabel,
    tradesPlaced: trades.length,
    dailyPnl,
    cumulativePnl,
    bankroll: newBankroll,
    positions,
    modelTopBracket,
    modelTopProb,
    predictionCorrect,
  };
}
