import { Cron } from 'croner';
import { config, CITIES } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { isWithinActiveHours, generateCycleId, getTomorrowDateString } from '../utils/time.js';
import { reconcile } from '../trading/reconciler.js';
import { generateSignals, type SignalRequest } from '../strategy/signals.js';
import { executeSignals } from '../trading/executor.js';
import { isDailyLossBreached, resetDaily, getRiskState, filterPortfolioRisk } from '../strategy/risk.js';
import { getState as getPortfolioState } from '../trading/portfolio.js';
import { logCycle, logTrade, logPrediction } from '../analytics/tracker.js';
import { checkSettlements } from '../analytics/settlement.js';
import { setLatestCycleData } from '../dashboard/api.js';
import { recordPaperTrades, checkPaperSettlements, getPaperState } from '../paper/portfolio.js';
import type { TradeSignal, BracketProbability } from '../types.js';
import type { RawSignalInfo } from '../strategy/signals.js';

const log = createLogger('scheduler');

export async function runTradingCycle(): Promise<void> {
  const cycleId = generateCycleId();
  log.info({ cycleId, cities: CITIES.length }, 'Trading cycle started');

  try {
    // Guard: active hours
    if (!isWithinActiveHours()) {
      log.info({ cycleId }, 'Outside active hours, skipping');
      return;
    }

    // 1. Reconcile portfolio (non-fatal — auth may fail but signals still work)
    try {
      await reconcile();
    } catch (error) {
      log.warn({ cycleId, error: String(error) }, 'Portfolio reconciliation failed — continuing with cached state');
    }
    const portfolio = getPortfolioState();

    // 2. Check daily loss limit
    if (isDailyLossBreached()) {
      log.warn({ cycleId }, 'Daily loss limit breached, skipping cycle');
      logCycle({
        cycleId,
        timestamp: new Date(),
        date: getTomorrowDateString(),
        balance: portfolio.balance,
        positions: portfolio.positions.size,
        signalsGenerated: 0,
        tradesAttempted: 0,
        tradesFilled: 0,
        dailyPnl: getRiskState().dailyPnl,
      });
      return;
    }

    // Use paper balance when in paper mode
    const paperState = config.paperTrade ? getPaperState() : null;
    const balance = paperState ? paperState.balance : portfolio.balance;

    // 3. Build signal requests from all cities
    const requests: SignalRequest[] = [];
    for (const city of CITIES) {
      if (city.high) {
        requests.push({
          cityId: city.id,
          seriesTicker: city.high,
          latitude: city.latitude,
          longitude: city.longitude,
          variable: 'temperature_2m_max',
        });
      }
      if (city.low) {
        requests.push({
          cityId: city.id,
          seriesTicker: city.low,
          latitude: city.latitude,
          longitude: city.longitude,
          variable: 'temperature_2m_min',
        });
      }
    }

    log.info({ cycleId, requests: requests.length }, 'Signal requests built for all cities');

    // 4. Fetch signals for all cities (batched, concurrency limit of 3)
    const allSignals: TradeSignal[] = [];
    const allDistributions: BracketProbability[] = [];
    const allRawSignals: RawSignalInfo[] = [];

    for (let i = 0; i < requests.length; i += 3) {
      const batch = requests.slice(i, i + 3);
      const results = await Promise.allSettled(
        batch.map(req => generateSignals(balance, req)),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allSignals.push(...result.value.signals);
          allDistributions.push(...result.value.distribution);
          allRawSignals.push(...result.value.rawSignals);
        } else {
          log.warn({ error: String(result.reason) }, 'Signal generation failed for city');
        }
      }
    }

    // 5. Filter out tickers we already hold in paper mode (prevent duplicate buying)
    let filteredSignals = allSignals;
    if (config.paperTrade) {
      const { hasPaperPosition } = await import('../paper/portfolio.js');
      filteredSignals = allSignals.filter(s => !hasPaperPosition(s.bracket.ticker));
      if (filteredSignals.length < allSignals.length) {
        log.info(
          { before: allSignals.length, after: filteredSignals.length },
          'Filtered out signals for tickers already held',
        );
      }
    }

    // 6. Apply portfolio-level risk filter
    const approvedSignals = filterPortfolioRisk(filteredSignals, balance);

    // Store for dashboard API (all approved signals + all distributions)
    setLatestCycleData(approvedSignals, allDistributions, cycleId, allRawSignals);

    // 7. Execute approved signals
    const results = await executeSignals(approvedSignals);

    // 7. Log results
    for (const result of results) {
      logTrade(cycleId, result);
    }

    // 7b. Track paper trades if in paper mode
    if (config.paperTrade) {
      recordPaperTrades(results);
    }

    const filled = results.filter(r => r.status === 'filled').length;

    // Re-fetch paper state after recording trades
    const updatedPaperState = config.paperTrade ? getPaperState() : null;

    logCycle({
      cycleId,
      timestamp: new Date(),
      date: getTomorrowDateString(),
      balance: updatedPaperState ? updatedPaperState.balance : portfolio.balance,
      positions: updatedPaperState ? updatedPaperState.positions : portfolio.positions.size,
      signalsGenerated: allSignals.length,
      tradesAttempted: results.length,
      tradesFilled: filled,
      dailyPnl: updatedPaperState ? updatedPaperState.dailyPnl : getRiskState().dailyPnl,
    });

    log.info(
      {
        cycleId,
        totalSignals: allSignals.length,
        approved: approvedSignals.length,
        traded: results.length,
        filled,
        balance: updatedPaperState ? updatedPaperState.balance : portfolio.balance,
        paperPnl: updatedPaperState?.totalPnl,
      },
      'Trading cycle complete',
    );
  } catch (error) {
    log.error({ cycleId, error: String(error) }, 'Trading cycle failed');
  }
}

export function startScheduler(): { stop: () => void } {
  const { pollIntervalMinutes, timezone } = config.scheduler;

  // Main trading cycle: every N minutes during active hours
  const pollCron = `*/${pollIntervalMinutes} ${config.scheduler.activeHoursStart}-${config.scheduler.activeHoursEnd - 1} * * *`;
  const pollJob = new Cron(pollCron, { timezone }, runTradingCycle);

  // Settlement check: every 2 hours during the day (settlements can be delayed)
  const settlementJob = new Cron('0 7,9,11,13,15,17 * * *', { timezone }, async () => {
    log.info('Running settlement check');
    try {
      if (config.paperTrade) {
        await checkPaperSettlements();
      } else {
        await checkSettlements();
      }
    } catch (error) {
      log.error({ error: String(error) }, 'Settlement check failed');
    }
  });

  // Daily reset: midnight Chicago time
  const resetJob = new Cron('0 0 * * *', { timezone }, () => {
    resetDaily();
    log.info('Daily counters reset');
  });

  log.info(
    {
      pollCron,
      timezone,
      dryRun: config.dryRun,
    },
    'Scheduler started',
  );

  return {
    stop: () => {
      pollJob.stop();
      settlementJob.stop();
      resetJob.stop();
      log.info('Scheduler stopped');
    },
  };
}
