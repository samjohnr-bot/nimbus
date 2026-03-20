import type { Bracket, BracketProbability } from '../types.js';
import type { EnsembleForecast } from './types.js';
import type { KalshiMarket } from '../kalshi/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('distribution');

const LAPLACE_SMOOTHING = 0.5;

export function buildDistribution(
  forecast: EnsembleForecast,
  brackets: Bracket[],
): BracketProbability[] {
  const { members } = forecast;
  const totalMembers = members.length;

  if (totalMembers === 0) {
    throw new Error('Cannot build distribution from empty ensemble');
  }

  // Round members to nearest integer to match NWS reporting
  // (NWS Daily Climate Reports use whole-degree temperatures)
  const roundedMembers = members.map(t => Math.round(t));

  // Count members in each bracket
  const counts = brackets.map(bracket => {
    let count = 0;
    for (const temp of roundedMembers) {
      if (fitsInBracket(temp, bracket)) {
        count++;
      }
    }
    return count;
  });

  // Apply Laplace smoothing and normalize
  const smoothedTotal = totalMembers + LAPLACE_SMOOTHING * brackets.length;
  const probabilities: BracketProbability[] = brackets.map((bracket, i) => ({
    bracket,
    modelProb: (counts[i] + LAPLACE_SMOOTHING) / smoothedTotal,
  }));

  // Verify probabilities sum to ~1
  const sum = probabilities.reduce((acc, p) => acc + p.modelProb, 0);
  if (Math.abs(sum - 1) > 0.01) {
    log.warn({ sum }, 'Probability distribution does not sum to 1, renormalizing');
    for (const p of probabilities) {
      p.modelProb /= sum;
    }
  }

  log.debug(
    {
      brackets: probabilities.map(p => ({
        range: p.bracket.rangeLabel,
        prob: p.modelProb.toFixed(3),
        count: counts[brackets.indexOf(p.bracket)],
      })),
      totalMembers,
    },
    'Distribution built',
  );

  return probabilities;
}

function fitsInBracket(temp: number, bracket: Bracket): boolean {
  const { lowBound, highBound } = bracket;

  // Open-ended low bracket (strike_type: 'less'): temp < highBound
  if (lowBound === null && highBound !== null) {
    return temp < highBound;
  }

  // Open-ended high bracket (strike_type: 'greater'): temp > lowBound
  if (lowBound !== null && highBound === null) {
    return temp > lowBound;
  }

  // Bounded bracket (strike_type: 'between'): lowBound <= temp <= highBound
  // Kalshi "between" brackets are inclusive on both ends (e.g., "68-69°")
  if (lowBound !== null && highBound !== null) {
    return temp >= lowBound && temp <= highBound;
  }

  return false;
}

/**
 * Convert Kalshi market objects into Bracket objects for the distribution builder.
 *
 * Real market structure from the API:
 * - strike_type: 'less' with capStrike → "< capStrike°"
 * - strike_type: 'between' with floorStrike & capStrike → "floorStrike-capStrike°"
 * - strike_type: 'greater' with floorStrike → "> floorStrike°"
 */
export function parseBracketsFromMarkets(markets: KalshiMarket[]): Bracket[] {
  return markets
    .map(m => {
      let lowBound: number | null = null;
      let highBound: number | null = null;

      switch (m.strikeType) {
        case 'less':
          // "< capStrike°" → temp < capStrike
          highBound = m.capStrike;
          break;
        case 'greater':
          // "> floorStrike°" → temp > floorStrike
          lowBound = m.floorStrike;
          break;
        case 'between':
          // "floorStrike-capStrike°" → floorStrike <= temp <= capStrike
          lowBound = m.floorStrike;
          highBound = m.capStrike;
          break;
      }

      return {
        ticker: m.ticker,
        rangeLabel: m.subtitle || formatRange(m.strikeType, m.floorStrike, m.capStrike),
        lowBound,
        highBound,
      };
    })
    .sort((a, b) => {
      const aVal = a.lowBound ?? -Infinity;
      const bVal = b.lowBound ?? -Infinity;
      return aVal - bVal;
    });
}

function formatRange(
  strikeType: string,
  floor: number | null,
  cap: number | null,
): string {
  switch (strikeType) {
    case 'less':
      return `< ${cap}°F`;
    case 'greater':
      return `> ${floor}°F`;
    case 'between':
      return `${floor}-${cap}°F`;
    default:
      return 'unknown';
  }
}
