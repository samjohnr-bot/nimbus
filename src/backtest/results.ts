import { createLogger } from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

const log = createLogger('backtest:results');

export interface DailyResult {
  date: string;
  actualTemp: number;
  winningBracket: string | null;
  tradesPlaced: number;
  dailyPnl: number;         // cents
  cumulativePnl: number;    // cents
  bankroll: number;          // cents
  positions: PositionResult[];
  modelTopBracket: string;
  modelTopProb: number;
  predictionCorrect: boolean;
}

export interface PositionResult {
  ticker: string;
  rangeLabel: string;
  side: 'yes' | 'no';
  contracts: number;
  price: number;           // cents per contract
  cost: number;            // total cost in cents
  fee: number;             // cents
  payout: number;          // cents
  pnl: number;             // cents
  edge: number;
  modelProb: number;
  won: boolean;
}

export interface CalibrationBucket {
  range: string;           // e.g., "0.0-0.1"
  predictedProb: number;   // average predicted probability
  actualFreq: number;      // actual win frequency
  count: number;           // number of predictions in bucket
}

export interface BacktestSummary {
  startDate: string;
  endDate: string;
  totalDays: number;
  tradingDays: number;
  initialBankroll: number;  // cents
  finalBankroll: number;    // cents
  totalPnl: number;         // cents
  totalReturn: number;      // percentage
  maxDrawdown: number;      // percentage
  sharpeRatio: number;
  winRate: number;          // percentage
  totalTrades: number;
  avgEdge: number;
  predictionAccuracy: number;  // percentage
  calibration: CalibrationBucket[];
  dailyResults: DailyResult[];
}

export class BacktestTracker {
  private dailyResults: DailyResult[] = [];
  private initialBankroll: number;
  private currentBankroll: number;
  private peakBankroll: number;
  private maxDrawdown: number = 0;

  // For calibration tracking
  private calibrationData: Array<{ predictedProb: number; won: boolean }> = [];

  constructor(initialBankroll: number) {
    this.initialBankroll = initialBankroll;
    this.currentBankroll = initialBankroll;
    this.peakBankroll = initialBankroll;
  }

  get bankroll(): number {
    return this.currentBankroll;
  }

  addDailyResult(result: DailyResult): void {
    this.dailyResults.push(result);
    this.currentBankroll = result.bankroll;

    // Track peak and drawdown
    if (this.currentBankroll > this.peakBankroll) {
      this.peakBankroll = this.currentBankroll;
    }
    const drawdown = (this.peakBankroll - this.currentBankroll) / this.peakBankroll;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }

    // Track calibration data for each position
    for (const pos of result.positions) {
      this.calibrationData.push({
        predictedProb: pos.modelProb,
        won: pos.won,
      });
    }
  }

  computeSummary(startDate: string, endDate: string): BacktestSummary {
    const totalDays = this.dailyResults.length;
    const tradingDays = this.dailyResults.filter(d => d.tradesPlaced > 0).length;

    const totalPnl = this.currentBankroll - this.initialBankroll;
    const totalReturn = (totalPnl / this.initialBankroll) * 100;

    // Compute Sharpe ratio from daily returns
    const dailyReturns = this.dailyResults
      .filter(d => d.tradesPlaced > 0)
      .map(d => d.dailyPnl / this.initialBankroll);

    const sharpeRatio = computeSharpe(dailyReturns);

    // Win rate
    const allPositions = this.dailyResults.flatMap(d => d.positions);
    const totalTrades = allPositions.length;
    const wins = allPositions.filter(p => p.pnl > 0).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    // Average edge
    const avgEdge = totalTrades > 0
      ? allPositions.reduce((sum, p) => sum + p.edge, 0) / totalTrades
      : 0;

    // Prediction accuracy (model's top bracket vs actual)
    const predictableDays = this.dailyResults.filter(d => d.winningBracket !== null);
    const correctPredictions = predictableDays.filter(d => d.predictionCorrect).length;
    const predictionAccuracy = predictableDays.length > 0
      ? (correctPredictions / predictableDays.length) * 100
      : 0;

    // Calibration buckets
    const calibration = computeCalibration(this.calibrationData);

    return {
      startDate,
      endDate,
      totalDays,
      tradingDays,
      initialBankroll: this.initialBankroll,
      finalBankroll: this.currentBankroll,
      totalPnl,
      totalReturn,
      maxDrawdown: this.maxDrawdown * 100,
      sharpeRatio,
      winRate,
      totalTrades,
      avgEdge,
      predictionAccuracy,
      calibration,
      dailyResults: this.dailyResults,
    };
  }
}

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize: assume ~252 trading days
  return (mean / stdDev) * Math.sqrt(252);
}

function computeCalibration(
  data: Array<{ predictedProb: number; won: boolean }>,
): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  const numBuckets = 10;

  for (let i = 0; i < numBuckets; i++) {
    const low = i / numBuckets;
    const high = (i + 1) / numBuckets;
    const range = `${low.toFixed(1)}-${high.toFixed(1)}`;

    const inBucket = data.filter(d => d.predictedProb >= low && d.predictedProb < high);
    if (inBucket.length === 0) {
      buckets.push({ range, predictedProb: (low + high) / 2, actualFreq: 0, count: 0 });
      continue;
    }

    const avgProb = inBucket.reduce((s, d) => s + d.predictedProb, 0) / inBucket.length;
    const actualFreq = inBucket.filter(d => d.won).length / inBucket.length;

    buckets.push({ range, predictedProb: avgProb, actualFreq, count: inBucket.length });
  }

  return buckets;
}

export function printSummary(summary: BacktestSummary): void {
  const divider = '═'.repeat(60);
  const line = '─'.repeat(60);

  console.log(`\n${divider}`);
  console.log('  NIMBUS BACKTEST RESULTS');
  console.log(divider);

  console.log(`\n  Period:       ${summary.startDate} to ${summary.endDate}`);
  console.log(`  Total Days:   ${summary.totalDays}`);
  console.log(`  Trading Days: ${summary.tradingDays}`);
  console.log(`  Total Trades: ${summary.totalTrades}`);

  console.log(`\n${line}`);
  console.log('  PERFORMANCE');
  console.log(line);

  const initialDollars = (summary.initialBankroll / 100).toFixed(2);
  const finalDollars = (summary.finalBankroll / 100).toFixed(2);
  const pnlDollars = (summary.totalPnl / 100).toFixed(2);
  const pnlSign = summary.totalPnl >= 0 ? '+' : '';

  console.log(`  Initial:      $${initialDollars}`);
  console.log(`  Final:        $${finalDollars}`);
  console.log(`  P&L:          ${pnlSign}$${pnlDollars} (${pnlSign}${summary.totalReturn.toFixed(1)}%)`);
  console.log(`  Max Drawdown: ${summary.maxDrawdown.toFixed(1)}%`);
  console.log(`  Sharpe Ratio: ${summary.sharpeRatio.toFixed(2)}`);
  console.log(`  Win Rate:     ${summary.winRate.toFixed(1)}%`);
  console.log(`  Avg Edge:     ${(summary.avgEdge * 100).toFixed(1)}%`);

  console.log(`\n${line}`);
  console.log('  MODEL ACCURACY');
  console.log(line);

  console.log(`  Top Bracket Correct: ${summary.predictionAccuracy.toFixed(1)}%`);

  console.log(`\n${line}`);
  console.log('  CALIBRATION');
  console.log(line);
  console.log('  Predicted   Actual    Count');

  for (const bucket of summary.calibration) {
    if (bucket.count === 0) continue;
    const pred = (bucket.predictedProb * 100).toFixed(0).padStart(5);
    const act = (bucket.actualFreq * 100).toFixed(0).padStart(5);
    const count = bucket.count.toString().padStart(6);
    console.log(`  ${pred}%     ${act}%    ${count}`);
  }

  // Daily P&L series (abbreviated)
  console.log(`\n${line}`);
  console.log('  DAILY P&L (trading days)');
  console.log(line);

  const tradingDays = summary.dailyResults.filter(d => d.tradesPlaced > 0);
  for (const day of tradingDays) {
    const pnl = (day.dailyPnl / 100).toFixed(2);
    const sign = day.dailyPnl >= 0 ? '+' : '';
    const cum = (day.cumulativePnl / 100).toFixed(2);
    const cumSign = day.cumulativePnl >= 0 ? '+' : '';
    console.log(
      `  ${day.date}  ${sign}$${pnl}  (cum: ${cumSign}$${cum})  trades: ${day.tradesPlaced}  actual: ${day.actualTemp}F`,
    );
  }

  console.log(`\n${divider}\n`);
}

/**
 * Write results to a JSONL file in data/backtest/ directory.
 */
export function writeResults(
  summary: BacktestSummary,
  outputDir: string = './data/backtest',
): string {
  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backtest-${summary.startDate}-to-${summary.endDate}-${timestamp}.jsonl`;
  const filepath = path.join(outputDir, filename);

  const lines: string[] = [];

  // Write summary line (without daily results to keep it clean)
  const { dailyResults: _, ...summaryWithoutDaily } = summary;
  lines.push(JSON.stringify({ type: 'summary', ...summaryWithoutDaily }));

  // Write each daily result as a line
  for (const day of summary.dailyResults) {
    lines.push(JSON.stringify({ type: 'daily', ...day }));
  }

  fs.writeFileSync(filepath, lines.join('\n') + '\n', 'utf-8');
  log.info({ filepath, lines: lines.length }, 'Backtest results written');

  return filepath;
}
