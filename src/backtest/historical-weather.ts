import type { EnsembleForecast } from '../weather/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('backtest:weather');

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const HISTORICAL_FORECAST_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';

// Deterministic models available in the historical forecast API
const DETERMINISTIC_MODELS = [
  'ecmwf_ifs025',
  'gem_global',
  'icon_global',
  'jma_gsm',
  'meteofrance_arpege_world',
];

/**
 * Get the actual observed high temperature for a given date and location.
 * Returns temperature in Fahrenheit.
 */
export async function getHistoricalActual(
  date: string,
  lat: number,
  lon: number,
): Promise<number | null> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    start_date: date,
    end_date: date,
    daily: 'temperature_2m_max',
    temperature_unit: 'fahrenheit',
    timezone: 'America/Chicago',
  });

  const url = `${ARCHIVE_URL}?${params}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.warn({ date, status: response.status }, 'Archive API returned error');
      return null;
    }

    const data = (await response.json()) as {
      daily: { time: string[]; temperature_2m_max: (number | null)[] };
    };

    const temp = data.daily.temperature_2m_max[0];
    if (temp === null || temp === undefined) {
      log.warn({ date }, 'No actual temperature data available');
      return null;
    }

    log.info({ date, actualTempF: Math.round(temp * 10) / 10 }, 'Historical actual fetched');
    return temp;
  } catch (error) {
    log.error({ date, error: String(error) }, 'Failed to fetch historical actual');
    return null;
  }
}

/**
 * Get what the ensemble models predicted for a target date.
 *
 * Strategy:
 * 1. Try the ensemble API first (works for ~5 recent days, gives 82 members)
 * 2. Fall back to deterministic models from historical-forecast API (works 6+ months back)
 *    - Gets 5 model forecasts, then generates synthetic ensemble members
 *      using each model's prediction + known forecast error spread
 */
export async function getHistoricalForecast(
  targetDate: string,
  lat: number,
  lon: number,
): Promise<EnsembleForecast | null> {
  const target = new Date(targetDate + 'T12:00:00Z');
  const forecastDate = new Date(target);
  forecastDate.setDate(forecastDate.getDate() - 1);
  const forecastDateStr = forecastDate.toISOString().split('T')[0];

  // Try ensemble API first (best data, but only ~5 days back)
  const ensembleMembers = await tryEnsembleApi(forecastDateStr, targetDate, lat, lon);
  if (ensembleMembers && ensembleMembers.length > 10) {
    log.info(
      { targetDate, totalMembers: ensembleMembers.length, source: 'ensemble' },
      'Historical ensemble forecast ready',
    );
    return {
      date: targetDate,
      members: ensembleMembers,
      modelTimestamp: new Date(forecastDateStr + 'T18:00:00Z'),
      models: ['gfs025', 'ecmwf_ifs025'],
      memberCount: ensembleMembers.length,
    };
  }

  // Fall back to deterministic models + synthetic ensemble
  const deterministicForecasts = await fetchDeterministicModels(forecastDateStr, targetDate, lat, lon);
  if (deterministicForecasts.length === 0) {
    log.warn({ targetDate }, 'No historical forecast data available');
    return null;
  }

  // Generate synthetic ensemble from deterministic forecasts
  const syntheticMembers = generateSyntheticEnsemble(deterministicForecasts);

  log.info(
    {
      targetDate,
      deterministicModels: deterministicForecasts.length,
      syntheticMembers: syntheticMembers.length,
      source: 'deterministic+synthetic',
    },
    'Historical ensemble forecast ready',
  );

  return {
    date: targetDate,
    members: syntheticMembers,
    modelTimestamp: new Date(forecastDateStr + 'T18:00:00Z'),
    models: DETERMINISTIC_MODELS.slice(0, deterministicForecasts.length),
    memberCount: syntheticMembers.length,
  };
}

/**
 * Try the ensemble API for recent dates.
 */
async function tryEnsembleApi(
  forecastDate: string,
  targetDate: string,
  lat: number,
  lon: number,
): Promise<number[] | null> {
  const models = ['gfs025', 'ecmwf_ifs025'];
  const allMembers: number[] = [];

  for (const model of models) {
    try {
      const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        daily: 'temperature_2m_max',
        temperature_unit: 'fahrenheit',
        models: model,
        start_date: forecastDate,
        end_date: targetDate,
        timezone: 'America/Chicago',
      });

      const response = await fetch(`${ENSEMBLE_URL}?${params}`);
      if (!response.ok) continue;

      const data = (await response.json()) as { daily: Record<string, unknown> };
      const daily = data.daily;
      const times = daily.time as string[];
      const targetIndex = times.indexOf(targetDate);
      const idx = targetIndex >= 0 ? targetIndex : times.length - 1;

      for (const [key, values] of Object.entries(daily)) {
        if (key === 'time') continue;
        if (!key.startsWith('temperature_2m_max')) continue;
        const val = (values as (number | null)[])[idx];
        if (typeof val === 'number' && !isNaN(val)) {
          allMembers.push(val);
        }
      }
    } catch {
      // Ignore errors, fall through to deterministic
    }
  }

  return allMembers.length > 0 ? allMembers : null;
}

/**
 * Fetch deterministic model forecasts from the historical forecast API.
 * Each model returns a single temperature prediction.
 */
async function fetchDeterministicModels(
  forecastDate: string,
  targetDate: string,
  lat: number,
  lon: number,
): Promise<number[]> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    start_date: forecastDate,
    end_date: targetDate,
    daily: 'temperature_2m_max',
    temperature_unit: 'fahrenheit',
    models: DETERMINISTIC_MODELS.join(','),
    timezone: 'America/Chicago',
  });

  try {
    const response = await fetch(`${HISTORICAL_FORECAST_URL}?${params}`);
    if (!response.ok) {
      log.warn({ status: response.status }, 'Historical forecast API error');
      return [];
    }

    const data = (await response.json()) as { daily: Record<string, unknown> };
    const daily = data.daily;
    const times = daily.time as string[];
    const targetIndex = times.indexOf(targetDate);
    const idx = targetIndex >= 0 ? targetIndex : times.length - 1;

    const forecasts: number[] = [];
    for (const [key, values] of Object.entries(daily)) {
      if (key === 'time') continue;
      if (!key.startsWith('temperature_2m_max')) continue;
      const val = (values as (number | null)[])[idx];
      if (typeof val === 'number' && !isNaN(val)) {
        forecasts.push(val);
      }
    }

    log.debug({ modelCount: forecasts.length, forecasts }, 'Deterministic forecasts fetched');
    return forecasts;
  } catch (error) {
    log.error({ error: String(error) }, 'Failed to fetch deterministic models');
    return [];
  }
}

/**
 * Generate a synthetic ensemble from deterministic model forecasts.
 * Uses the multi-model spread to estimate uncertainty, then generates
 * ~80 synthetic members from a normal distribution.
 *
 * Typical day-ahead forecast error for high temp is ~3°F.
 * We use the model spread + a minimum error floor to build the distribution.
 */
function generateSyntheticEnsemble(forecasts: number[]): number[] {
  const mean = forecasts.reduce((sum, v) => sum + v, 0) / forecasts.length;

  // Standard deviation of model forecasts (inter-model spread)
  const modelSpread = forecasts.length > 1
    ? Math.sqrt(forecasts.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (forecasts.length - 1))
    : 0;

  // Use model spread as one indicator, but floor it at typical forecast error (~3°F)
  // Day-ahead high temp forecasts typically have RMSE of 2.5-4°F
  const stdDev = Math.max(modelSpread, 3.0);

  // Generate ~80 synthetic members using Box-Muller transform
  const members: number[] = [];
  const TARGET_MEMBERS = 80;

  // Include the actual model forecasts as members
  members.push(...forecasts);

  // Generate remaining synthetic members
  while (members.length < TARGET_MEMBERS) {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    members.push(mean + z * stdDev);
  }

  return members;
}
