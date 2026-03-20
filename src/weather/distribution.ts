import type { Bracket, BracketProbability } from '../types.js';
import type { EnsembleForecast } from './types.js';
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

  // Count members in each bracket
  const counts = brackets.map(bracket => {
    let count = 0;
    for (const temp of members) {
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

  // Open-ended low bracket: temp < highBound
  if (lowBound === null && highBound !== null) {
    return temp < highBound;
  }

  // Open-ended high bracket: temp >= lowBound
  if (lowBound !== null && highBound === null) {
    return temp >= lowBound;
  }

  // Bounded bracket: lowBound <= temp < highBound
  if (lowBound !== null && highBound !== null) {
    return temp >= lowBound && temp < highBound;
  }

  return false;
}

export function parseBracketsFromMarkets(
  markets: Array<{ ticker: string; floor_strike: number | null; cap_strike: number | null; subtitle: string }>,
): Bracket[] {
  return markets
    .map(m => ({
      ticker: m.ticker,
      rangeLabel: m.subtitle || formatRange(m.floor_strike, m.cap_strike),
      lowBound: m.floor_strike,
      highBound: m.cap_strike,
    }))
    .sort((a, b) => {
      const aVal = a.lowBound ?? -Infinity;
      const bVal = b.lowBound ?? -Infinity;
      return aVal - bVal;
    });
}

function formatRange(low: number | null, high: number | null): string {
  if (low === null && high !== null) return `< ${high}°F`;
  if (low !== null && high === null) return `≥ ${low}°F`;
  if (low !== null && high !== null) return `${low}-${high}°F`;
  return 'unknown';
}
