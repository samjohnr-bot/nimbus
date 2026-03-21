import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { TradeSignal, TradeResult, CycleSummary, BracketProbability } from '../types.js';

const log = createLogger('tracker');

function ensureDir(): void {
  const dir = config.logging.directory;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getFilePath(category: string): string {
  const date = new Date().toISOString().split('T')[0];
  return path.join(config.logging.directory, `${category}-${date}.jsonl`);
}

function appendLine(category: string, data: Record<string, unknown>): void {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n';
  fs.appendFileSync(getFilePath(category), line);
}

export function logPrediction(
  cycleId: string,
  targetDate: string,
  distribution: BracketProbability[],
  memberCount: number,
  models: string[],
): void {
  appendLine('predictions', {
    cycleId,
    date: targetDate,
    brackets: distribution.map(d => ({
      ticker: d.bracket.ticker,
      range: d.bracket.rangeLabel,
      modelProb: Number(d.modelProb.toFixed(4)),
    })),
    memberCount,
    models,
  });
}

export function logTrade(cycleId: string, result: TradeResult): void {
  appendLine('trades', {
    cycleId,
    ticker: result.signal.bracket.ticker,
    side: result.signal.side,
    edge: Number(result.signal.edge.toFixed(4)),
    modelProb: Number(result.signal.modelProb.toFixed(4)),
    marketProb: Number(result.signal.marketImpliedProb.toFixed(4)),
    price: result.filledPrice,
    contracts: result.filledContracts,
    orderId: result.orderId,
    status: result.status,
    fee: result.signal.fee,
    dryRun: config.dryRun,
    error: result.error || undefined,
  });
}

export function logCycle(summary: CycleSummary): void {
  appendLine('cycles', {
    cycleId: summary.cycleId,
    date: summary.date,
    balance: summary.balance,
    positions: summary.positions,
    signalsGenerated: summary.signalsGenerated,
    tradesAttempted: summary.tradesAttempted,
    tradesFilled: summary.tradesFilled,
    dailyPnl: summary.dailyPnl,
  });
}

export function logSettlement(
  ticker: string,
  result: 'yes' | 'no',
  pnl: number,
): void {
  appendLine('settlements', { ticker, result, pnl });
}
