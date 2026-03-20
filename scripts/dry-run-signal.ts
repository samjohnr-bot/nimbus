import * as kalshi from '../src/kalshi/client.js';
import { getEnsembleForecast } from '../src/weather/openmeteo.js';
import { buildDistribution, parseBracketsFromMarkets } from '../src/weather/distribution.js';
import { buildMarketSnapshot, calculateEdge } from '../src/strategy/edge.js';

async function dryRunSignalCheck() {
  // Get tomorrow's date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const targetDate = tomorrow.toISOString().split('T')[0];
  console.log('Target date:', targetDate);
  console.log();

  // 1. Fetch markets (public, no auth)
  const allMarkets = await kalshi.getMarkets({ series_ticker: 'KXHIGHCHI', limit: 20 });

  // Try tomorrow first, fall back to whatever event has the most markets
  let markets = allMarkets.filter(m => {
    const close = new Date(m.closeTime).toISOString().split('T')[0];
    return close === targetDate;
  });

  if (markets.length === 0) {
    // Group by event and pick the one with the most markets
    const byEvent = new Map<string, typeof allMarkets>();
    for (const m of allMarkets) {
      const existing = byEvent.get(m.eventTicker) || [];
      existing.push(m);
      byEvent.set(m.eventTicker, existing);
    }
    let bestEvent = '';
    let bestCount = 0;
    for (const [event, mks] of byEvent) {
      if (mks.length > bestCount) {
        bestEvent = event;
        bestCount = mks.length;
      }
    }
    markets = byEvent.get(bestEvent) || [];
    console.log(`No markets for tomorrow. Using ${bestEvent} (${markets.length} brackets)`);
  } else {
    console.log(`Found ${markets.length} brackets for ${targetDate}`);
  }
  console.log();

  // Show markets
  for (const m of markets) {
    console.log(`  ${m.ticker.padEnd(30)} ${m.subtitle.padEnd(20)} yes: ${m.yesBid}/${m.yesAsk}c`);
  }
  console.log();

  // 2. Parse brackets
  const brackets = parseBracketsFromMarkets(markets);

  // 3. Fetch weather ensemble
  const eventDate = markets[0].closeTime.split('T')[0];
  console.log(`Fetching ensemble forecast for ${eventDate}...`);
  const forecast = await getEnsembleForecast(eventDate);
  console.log(`Ensemble members: ${forecast.memberCount}`);
  const temps = forecast.members;
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
  console.log(`Temp range: ${min.toFixed(1)} - ${max.toFixed(1)}°F, avg: ${avg.toFixed(1)}°F`);
  console.log();

  // 4. Build distribution
  const dist = buildDistribution(forecast, brackets);
  console.log('=== Probability Distribution ===');
  for (const d of dist) {
    const bar = '█'.repeat(Math.round(d.modelProb * 50));
    console.log(`  ${d.bracket.rangeLabel.padEnd(20)} ${(d.modelProb * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log();

  // 5. Get orderbooks and compute edge
  console.log('=== Edge Analysis ===');
  const snapshots = [];
  for (const bracket of brackets) {
    const ob = await kalshi.getOrderbook(bracket.ticker);
    snapshots.push(buildMarketSnapshot(bracket, ob));
  }

  const signals = calculateEdge(dist, snapshots);
  if (signals.length === 0) {
    console.log('  No edge found — market is efficiently priced right now.');
  } else {
    for (const s of signals.slice(0, 5)) {
      console.log(
        `  ${s.side.toUpperCase().padEnd(4)} ${s.bracket.rangeLabel.padEnd(20)} edge: ${(s.edge * 100).toFixed(1)}% | model: ${(s.modelProb * 100).toFixed(1)}% vs market: ${(s.marketImpliedProb * 100).toFixed(1)}% | spread: ${s.spread}c`,
      );
    }
  }
}

dryRunSignalCheck().catch(console.error);
