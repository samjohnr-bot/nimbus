import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getState as getPortfolioState } from '../trading/portfolio.js';
import { getRiskState } from '../strategy/risk.js';
import { getAuthDiagnostics } from '../kalshi/auth.js';
import { getPaperState } from '../paper/portfolio.js';
import type { TradeSignal, BracketProbability } from '../types.js';

// In-memory state set by the scheduler after each cycle
let latestSignals: TradeSignal[] = [];
let latestDistribution: BracketProbability[] = [];
let latestRawSignals: { bracket: string; range: string; side: string; edge: number; modelProb: number; marketProb: number; spread: number; price: number }[] = [];
let lastCycleTime: string | null = null;
let lastCycleId: string | null = null;

const startedAt = new Date().toISOString();

export function setLatestCycleData(
  signals: TradeSignal[],
  distribution: BracketProbability[],
  cycleId: string,
  rawSignals?: { bracket: string; range: string; side: string; edge: number; modelProb: number; marketProb: number; spread: number; price: number }[],
) {
  latestSignals = signals;
  latestDistribution = distribution;
  lastCycleTime = new Date().toISOString();
  lastCycleId = cycleId;
  if (rawSignals) latestRawSignals = rawSignals;
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function readJsonlFile(category: string, limit: number): Record<string, unknown>[] {
  const dir = config.logging.directory;
  if (!fs.existsSync(dir)) return [];

  // Find files for this category, sorted newest first
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(`${category}-`) && f.endsWith('.jsonl'))
    .sort()
    .reverse();

  const results: Record<string, unknown>[] = [];

  for (const file of files) {
    if (results.length >= limit) break;
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      if (results.length >= limit) break;
      try {
        results.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }

  return results;
}

export function handleApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url || '/';

  if (url === '/api/status') {
    const portfolio = getPortfolioState();
    const risk = getRiskState();
    const paper = config.paperTrade ? getPaperState() : null;
    json(res, {
      env: config.env,
      dryRun: config.dryRun,
      paperTrade: config.paperTrade,
      startedAt,
      uptime: process.uptime(),
      balance: paper ? paper.balance : portfolio.balance,
      portfolioValue: paper ? paper.totalPnl : portfolio.portfolioValue,
      positions: paper ? paper.positions : portfolio.positions.size,
      totalExposure: paper ? 0 : portfolio.totalExposure,
      dailyPnl: paper ? paper.dailyPnl : risk.dailyPnl,
      paperWins: paper?.wins,
      paperLosses: paper?.losses,
      paperTrades: paper?.trades,
      lastCycleTime,
      lastCycleId,
      city: config.trading.city,
      series: config.trading.seriesTicker,
      edgeThreshold: config.trading.edgeThreshold,
      pollInterval: config.scheduler.pollIntervalMinutes,
    });
    return true;
  }

  if (url === '/api/signals') {
    json(res, {
      cycleId: lastCycleId,
      cycleTime: lastCycleTime,
      signals: latestSignals.map(s => ({
        ticker: s.bracket.ticker,
        range: s.bracket.rangeLabel,
        side: s.side,
        edge: s.edge,
        modelProb: s.modelProb,
        marketImpliedProb: s.marketImpliedProb,
        spread: s.spread,
        price: s.price,
        contracts: s.contracts,
        maxCost: s.maxCost,
        fee: s.fee,
      })),
      distribution: latestDistribution.map(d => ({
        ticker: d.bracket.ticker,
        range: d.bracket.rangeLabel,
        modelProb: d.modelProb,
      })),
      rawSignals: latestRawSignals,
    });
    return true;
  }

  if (url === '/api/cycles') {
    json(res, readJsonlFile('cycles', 50));
    return true;
  }

  if (url === '/api/trades') {
    json(res, readJsonlFile('trades', 50));
    return true;
  }

  if (url === '/api/diagnostics') {
    const authDiag = getAuthDiagnostics();
    json(res, {
      auth: authDiag,
      env: config.env,
      dryRun: config.dryRun,
      baseUrl: config.kalshi.baseUrl,
      apiKeySet: !!config.kalshi.apiKey,
      apiKeyPrefix: config.kalshi.apiKey ? config.kalshi.apiKey.substring(0, 8) + '...' : '(none)',
    });
    return true;
  }

  if (url === '/api/pnl') {
    const cycles = readJsonlFile('cycles', 200);
    // Group by date, take latest balance per day
    const byDate = new Map<string, { balance: number; dailyPnl: number; trades: number }>();
    for (const c of cycles) {
      const date = c.date as string;
      if (!byDate.has(date)) {
        byDate.set(date, {
          balance: c.balance as number,
          dailyPnl: c.dailyPnl as number,
          trades: c.tradesFilled as number,
        });
      }
    }
    const series = Array.from(byDate.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));
    json(res, series);
    return true;
  }

  return false;
}
