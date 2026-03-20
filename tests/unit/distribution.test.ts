import { describe, it, expect } from 'vitest';
import { buildDistribution, parseBracketsFromMarkets } from '../../src/weather/distribution.js';
import type { Bracket } from '../../src/types.js';
import type { EnsembleForecast } from '../../src/weather/types.js';

// Typical 6-bracket structure for a Chicago summer day
const brackets: Bracket[] = [
  { ticker: 'B1', rangeLabel: '< 78°F', lowBound: null, highBound: 78 },
  { ticker: 'B2', rangeLabel: '78-80°F', lowBound: 78, highBound: 80 },
  { ticker: 'B3', rangeLabel: '80-82°F', lowBound: 80, highBound: 82 },
  { ticker: 'B4', rangeLabel: '82-84°F', lowBound: 82, highBound: 84 },
  { ticker: 'B5', rangeLabel: '84-86°F', lowBound: 84, highBound: 86 },
  { ticker: 'B6', rangeLabel: '≥ 86°F', lowBound: 86, highBound: null },
];

function makeForecast(members: number[]): EnsembleForecast {
  return {
    date: '2026-03-21',
    members,
    modelTimestamp: new Date(),
    models: ['gfs025'],
    memberCount: members.length,
  };
}

describe('buildDistribution', () => {
  it('should sum to approximately 1.0', () => {
    const members = Array.from({ length: 82 }, () => 75 + Math.random() * 15);
    const dist = buildDistribution(makeForecast(members), brackets);

    const sum = dist.reduce((acc, d) => acc + d.modelProb, 0);
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it('should assign all members to the correct brackets', () => {
    // 10 members all at 81°F → should land in bracket B3 (80-82°F)
    const members = Array(10).fill(81);
    const dist = buildDistribution(makeForecast(members), brackets);

    // B3 should have the highest probability
    const b3 = dist.find(d => d.bracket.ticker === 'B3')!;
    expect(b3.modelProb).toBeGreaterThan(0.7); // smoothing prevents 100%

    // Other brackets should have only smoothing probability
    for (const d of dist) {
      if (d.bracket.ticker !== 'B3') {
        expect(d.modelProb).toBeLessThan(0.1);
      }
    }
  });

  it('should handle the lower open-ended bracket', () => {
    const members = Array(20).fill(70); // all below 78°F
    const dist = buildDistribution(makeForecast(members), brackets);

    const b1 = dist.find(d => d.bracket.ticker === 'B1')!;
    expect(b1.modelProb).toBeGreaterThan(0.8);
  });

  it('should handle the upper open-ended bracket', () => {
    const members = Array(20).fill(90); // all >= 86°F
    const dist = buildDistribution(makeForecast(members), brackets);

    const b6 = dist.find(d => d.bracket.ticker === 'B6')!;
    expect(b6.modelProb).toBeGreaterThan(0.8);
  });

  it('should spread across multiple brackets with diverse members', () => {
    // 10 per bracket
    const members = [
      ...Array(10).fill(75),  // B1
      ...Array(10).fill(79),  // B2
      ...Array(10).fill(81),  // B3
      ...Array(10).fill(83),  // B4
      ...Array(10).fill(85),  // B5
      ...Array(10).fill(87),  // B6
    ];
    const dist = buildDistribution(makeForecast(members), brackets);

    // Each bracket should be roughly 1/6
    for (const d of dist) {
      expect(d.modelProb).toBeGreaterThan(0.12);
      expect(d.modelProb).toBeLessThan(0.22);
    }
  });

  it('should handle boundary values correctly', () => {
    // 78°F exactly should be in B2 (78-80), not B1 (< 78)
    const members = [78];
    const dist = buildDistribution(makeForecast(members), brackets);

    const b1 = dist.find(d => d.bracket.ticker === 'B1')!;
    const b2 = dist.find(d => d.bracket.ticker === 'B2')!;

    expect(b2.modelProb).toBeGreaterThan(b1.modelProb);
  });

  it('should throw on empty ensemble', () => {
    expect(() => buildDistribution(makeForecast([]), brackets)).toThrow(
      'Cannot build distribution from empty ensemble',
    );
  });

  it('should apply Laplace smoothing (no zero probabilities)', () => {
    // All members in one bracket
    const members = Array(50).fill(81);
    const dist = buildDistribution(makeForecast(members), brackets);

    for (const d of dist) {
      expect(d.modelProb).toBeGreaterThan(0);
    }
  });
});

describe('parseBracketsFromMarkets', () => {
  it('should sort brackets by lowBound ascending', () => {
    const markets = [
      { ticker: 'B4', floor_strike: 82, cap_strike: 84, subtitle: '' },
      { ticker: 'B1', floor_strike: null, cap_strike: 78, subtitle: '' },
      { ticker: 'B6', floor_strike: 86, cap_strike: null, subtitle: '' },
      { ticker: 'B2', floor_strike: 78, cap_strike: 80, subtitle: '' },
    ];

    const parsed = parseBracketsFromMarkets(markets);

    expect(parsed[0].ticker).toBe('B1'); // null lowBound → -Infinity
    expect(parsed[1].ticker).toBe('B2');
    expect(parsed[2].ticker).toBe('B4');
    expect(parsed[3].ticker).toBe('B6');
  });

  it('should generate range labels when subtitle is empty', () => {
    const markets = [
      { ticker: 'B1', floor_strike: null, cap_strike: 78, subtitle: '' },
      { ticker: 'B3', floor_strike: 80, cap_strike: 82, subtitle: '' },
      { ticker: 'B6', floor_strike: 86, cap_strike: null, subtitle: '' },
    ];

    const parsed = parseBracketsFromMarkets(markets);

    expect(parsed[0].rangeLabel).toBe('< 78°F');
    expect(parsed[1].rangeLabel).toBe('80-82°F');
    expect(parsed[2].rangeLabel).toBe('≥ 86°F');
  });

  it('should use subtitle when provided', () => {
    const markets = [
      { ticker: 'B1', floor_strike: null, cap_strike: 78, subtitle: 'Below 78' },
    ];

    const parsed = parseBracketsFromMarkets(markets);
    expect(parsed[0].rangeLabel).toBe('Below 78');
  });
});
