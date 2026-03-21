import { Cron } from 'croner';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { isWithinActiveHours, generateCycleId, getTomorrowDateString } from '../utils/time.js';
import { reconcile } from '../trading/reconciler.js';
import { generateSignals } from '../strategy/signals.js';
import { executeSignals } from '../trading/executor.js';
import { isDailyLossBreached, resetDaily, getRiskState } from '../strategy/risk.js';
import { getState as getPortfolioState } from '../trading/portfolio.js';
import { logCycle, logTrade, logPrediction } from '../analytics/tracker.js';
import { checkSettlements } from '../analytics/settlement.js';
import { setLatestCycleData } from '../dashboard/api.js';
import { recordPaperTrades, checkPaperSettlements, getPaperState } from '../paper/portfolio.js';

const log = createLogger('scheduler');

export async function runTradingCycle(): Promise<void> {
  const cycleId = generateCycleId();
  log.info({ cycleId }, 'Trading cycle started');

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

    // 3. Generate signals
    const { signals, distribution, rawSignals } = await generateSignals(portfolio.balance);

    // Store for dashboard API
    setLatestCycleData(signals, distribution, cycleId, rawSignals);

    // 4. Execute trades
    const results = await executeSignals(signals);

    // 5. Log results
    for (const result of results) {
      logTrade(cycleId, result);
    }

    // 5b. Track paper trades if in paper mode
    if (config.paperTrade) {
      recordPaperTrades(results);
    }

    const filled = results.filter(r => r.status === 'filled').length;

    // Use paper state for balance/positions if in paper mode
    const paperState = config.paperTrade ? getPaperState() : null;

    logCycle({
      cycleId,
      timestamp: new Date(),
      date: getTomorrowDateString(),
      balance: paperState ? paperState.balance : portfolio.balance,
      positions: paperState ? paperState.positions : portfolio.positions.size,
      signalsGenerated: signals.length,
      tradesAttempted: results.length,
      tradesFilled: filled,
      dailyPnl: paperState ? paperState.dailyPnl : getRiskState().dailyPnl,
    });

    log.info(
      {
        cycleId,
        signals: signals.length,
        traded: results.length,
        filled,
        balance: paperState ? paperState.balance : portfolio.balance,
        paperPnl: paperState?.totalPnl,
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

  // Settlement check: 7 AM Chicago time
  const settlementJob = new Cron('0 7 * * *', { timezone }, async () => {
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
