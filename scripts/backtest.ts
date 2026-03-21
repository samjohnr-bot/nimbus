#!/usr/bin/env npx tsx

/**
 * Nimbus Backtest CLI
 *
 * Usage:
 *   npx tsx scripts/backtest.ts --start 2025-06-01 --end 2025-12-31 --bankroll 15000
 *
 * Options:
 *   --start      Start date (YYYY-MM-DD)          default: 2025-06-01
 *   --end        End date (YYYY-MM-DD)             default: 2025-12-31
 *   --bankroll   Starting bankroll in cents         default: 15000 ($150)
 *   --rate-limit Delay between dates in ms          default: 1500
 *   --output     Output directory                   default: ./data/backtest
 */

import { runBacktest } from '../src/backtest/runner.js';

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      const key = arg.slice(2);
      parsed[key] = args[i + 1];
      i++;
    }
  }
  return parsed;
}

function printUsage(): void {
  console.log(`
Nimbus Backtest Engine
======================

Usage:
  npx tsx scripts/backtest.ts [options]

Options:
  --start       Start date (YYYY-MM-DD)         [default: 2025-06-01]
  --end         End date (YYYY-MM-DD)            [default: 2025-12-31]
  --bankroll    Starting bankroll in cents        [default: 15000]
  --rate-limit  Delay between API calls (ms)     [default: 1500]
  --output      Output directory                  [default: ./data/backtest]
  --help        Show this help message

Examples:
  npx tsx scripts/backtest.ts --start 2025-06-01 --end 2025-08-31
  npx tsx scripts/backtest.ts --start 2025-09-01 --end 2025-12-31 --bankroll 50000
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if ('help' in args || process.argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const startDate = args['start'] || '2025-06-01';
  const endDate = args['end'] || '2025-12-31';
  const bankroll = args['bankroll'] ? parseInt(args['bankroll'], 10) : 15000;
  const rateLimitMs = args['rate-limit'] ? parseInt(args['rate-limit'], 10) : 1500;
  const outputDir = args['output'] || './data/backtest';

  // Validate dates
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    console.error(`Invalid start date: ${startDate}. Use YYYY-MM-DD format.`);
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    console.error(`Invalid end date: ${endDate}. Use YYYY-MM-DD format.`);
    process.exit(1);
  }
  if (new Date(startDate) >= new Date(endDate)) {
    console.error('Start date must be before end date.');
    process.exit(1);
  }
  if (isNaN(bankroll) || bankroll <= 0) {
    console.error('Bankroll must be a positive number (in cents).');
    process.exit(1);
  }

  console.log(`\nNimbus Backtest`);
  console.log(`  Period:   ${startDate} to ${endDate}`);
  console.log(`  Bankroll: $${(bankroll / 100).toFixed(2)} (${bankroll} cents)`);
  console.log(`  Output:   ${outputDir}`);
  console.log('');

  const startTime = Date.now();

  await runBacktest({
    startDate,
    endDate,
    bankroll,
    rateLimitMs,
    outputDir,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Completed in ${elapsed}s`);
}

main().catch(error => {
  console.error('Backtest failed:', error);
  process.exit(1);
});
