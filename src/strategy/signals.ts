import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import * as kalshi from '../kalshi/client.js';
import { getEnsembleForecast } from '../weather/openmeteo.js';
import { buildDistribution, parseBracketsFromMarkets } from '../weather/distribution.js';
import { buildMarketSnapshot, calculateEdge } from './edge.js';
import { sizePosition } from './sizing.js';
import { checkTradeAllowed } from './risk.js';
import type { TradeSignal, MarketSnapshot, BracketProbability } from '../types.js';

export interface SignalRequest {
  cityId: string;
  seriesTicker: string;
  latitude: number;
  longitude: number;
  variable: 'temperature_2m_max' | 'temperature_2m_min';
}

export interface RawSignalInfo {
  bracket: string;
  range: string;
  side: string;
  edge: number;
  modelProb: number;
  marketProb: number;
  spread: number;
  price: number;
}

export interface SignalResult {
  signals: TradeSignal[];
  distribution: BracketProbability[];
  rawSignals: RawSignalInfo[];
}

const log = createLogger('signals');

/**
 * Parse event date from a Kalshi event ticker like "KXHIGHCHI-26MAR25" → "2026-03-25"
 */
function parseEventDate(eventTicker: string): string | null {
  // Match pattern like 26MAR25, 26APR01, etc.
  const match = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const [, century_and_year_prefix, monthStr, day] = match;
  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };
  const month = months[monthStr];
  if (!month) return null;
  // "26MAR25" → year prefix "26" = 2026, day "25"
  return `20${century_and_year_prefix}-${month}-${day}`;
}

/**
 * Get tomorrow's date in US Central Time (CT).
 * Kalshi weather markets are based on CT event dates.
 */
function getTomorrowDateCT(): string {
  const now = new Date();
  // Convert to CT by using Intl formatter
  const ctFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // Get today in CT, then add 1 day
  const todayCT = ctFormatter.format(now); // "YYYY-MM-DD" format from en-CA locale
  const tomorrow = new Date(todayCT + 'T12:00:00'); // noon to avoid DST edge cases
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

export async function generateSignals(balance: number, request?: SignalRequest): Promise<SignalResult> {
  const targetDateCT = getTomorrowDateCT();

  // Resolve city-specific values: use request if provided, otherwise fall back to config
  const seriesTicker = request?.seriesTicker ?? config.trading.seriesTicker;
  const cityId = request?.cityId ?? config.trading.city;
  const weatherOpts = request
    ? { latitude: request.latitude, longitude: request.longitude, variable: request.variable }
    : { latitude: config.weather.latitude, longitude: config.weather.longitude, variable: 'temperature_2m_max' as const };

  // In paper/dry-run mode with $0 balance, use a simulated bankroll so sizing works
  if (balance === 0 && (config.dryRun || config.paperTrade)) {
    balance = config.paperBankroll || 15000; // simulated bankroll (in cents)
    log.info({ targetDateCT, balance, simulated: true, paper: config.paperTrade, cityId }, 'Generating signals (simulated bankroll)');
  } else {
    log.info({ targetDateCT, balance, cityId }, 'Generating signals');
  }

  // 1. Fetch bracket markets from Kalshi
  const markets = await kalshi.getMarkets({
    series_ticker: seriesTicker,
    status: 'open',
  });

  // Filter to tomorrow's markets by matching the EVENT DATE from the event_ticker
  // Event tickers like "KXHIGHCHI-26MAR25" → event date "2026-03-25"
  // CRITICAL: Do NOT use close_time (which is day AFTER event) — that caused an
  // off-by-one where we forecast Day X+1 weather but bet on Day X markets.
  const tomorrowMarkets = markets.filter(m => {
    const eventDate = parseEventDate(m.eventTicker);
    return eventDate === targetDateCT;
  });

  if (tomorrowMarkets.length === 0) {
    log.info({ targetDateCT, seriesTicker, totalMarkets: markets.length }, 'No markets found for tomorrow');
    return { signals: [], distribution: [], rawSignals: [] };
  }

  log.info({ count: tomorrowMarkets.length, targetDateCT, eventTicker: tomorrowMarkets[0].eventTicker }, 'Found bracket markets');

  // 2. Parse brackets from market data
  const brackets = parseBracketsFromMarkets(tomorrowMarkets);

  // 3. Fetch ensemble forecast — use the SAME date as the market event
  const forecast = await getEnsembleForecast(targetDateCT, weatherOpts);

  // Check data freshness
  const dataAge = (Date.now() - forecast.modelTimestamp.getTime()) / 1000;
  if (dataAge > config.trading.dataMaxAge) {
    log.warn({ dataAge, maxAge: config.trading.dataMaxAge }, 'Weather data too stale');
    return { signals: [], distribution: [], rawSignals: [] };
  }

  // 4. Build probability distribution
  const distribution = buildDistribution(forecast, brackets);

  // 5. Get orderbooks and build market snapshots
  const snapshots: MarketSnapshot[] = [];
  for (const bracket of brackets) {
    const orderbook = await kalshi.getOrderbook(bracket.ticker);
    snapshots.push(buildMarketSnapshot(bracket, orderbook));
  }

  // 6. Calculate edge for all brackets
  const rawSignals = calculateEdge(distribution, snapshots);

  // 7. Size and filter signals
  const tradeSignals: TradeSignal[] = [];

  for (const signal of rawSignals) {
    const sized = sizePosition(signal, balance);
    if (!sized) continue;

    const check = checkTradeAllowed(sized, balance);
    if (!check.allowed) {
      log.debug(
        { ticker: signal.bracket.ticker, reason: check.reason },
        'Signal rejected by risk',
      );
      continue;
    }

    tradeSignals.push({ ...sized, cityId, seriesTicker });
  }

  log.info(
    {
      raw: rawSignals.length,
      approved: tradeSignals.length,
      targetDateCT,
    },
    'Signal generation complete',
  );

  // Build raw signal info for dashboard (all edges, before filtering)
  const rawSignalInfo: RawSignalInfo[] = rawSignals.map(s => ({
    bracket: s.bracket.ticker,
    range: s.bracket.rangeLabel,
    side: s.side,
    edge: s.edge,
    modelProb: s.modelProb,
    marketProb: s.marketImpliedProb,
    spread: s.spread,
    price: s.price,
  }));

  return { signals: tradeSignals, distribution, rawSignals: rawSignalInfo };
}
