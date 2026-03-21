import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { EnsembleForecast, EnsembleApiResponse } from './types.js';

const log = createLogger('weather');

const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';

function buildUrl(
  model: string,
  forecastDays: number,
  opts: { latitude: number; longitude: number; variable: string },
): string {
  const params = new URLSearchParams({
    latitude: opts.latitude.toString(),
    longitude: opts.longitude.toString(),
    daily: opts.variable,
    temperature_unit: config.weather.temperatureUnit,
    models: model,
    forecast_days: forecastDays.toString(),
  });
  return `${ENSEMBLE_URL}?${params}`;
}

async function fetchModel(
  model: string,
  forecastDays: number,
  opts: { latitude: number; longitude: number; variable: string },
): Promise<number[]> {
  const url = buildUrl(model, forecastDays, opts);
  log.debug({ model, url }, 'Fetching ensemble forecast');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo ${model} returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as EnsembleApiResponse;

  // The ensemble API returns one value per member per day.
  // Keys are like "temperature_2m_max_member01", "temperature_2m_max_member02", etc.
  // Or it may return them in a flat array under the model-specific key.
  const members: number[] = [];
  const daily = data.daily;

  for (const [key, values] of Object.entries(daily)) {
    if (key === 'time') continue;
    if (!key.startsWith(opts.variable)) continue;

    // values is an array with one entry per forecast day
    // We want tomorrow (index 1) if forecastDays >= 2
    const dayIndex = forecastDays >= 2 ? 1 : 0;
    const val = values[dayIndex];
    if (typeof val === 'number' && !isNaN(val)) {
      members.push(val);
    }
  }

  log.info({ model, memberCount: members.length }, 'Ensemble members fetched');
  return members;
}

export async function getEnsembleForecast(
  targetDate: string,
  opts: { latitude: number; longitude: number; variable?: 'temperature_2m_max' | 'temperature_2m_min' } = {
    latitude: config.weather.latitude,
    longitude: config.weather.longitude,
  },
): Promise<EnsembleForecast> {
  const variable = opts.variable ?? 'temperature_2m_max';
  const today = new Date();
  const target = new Date(targetDate + 'T00:00:00');
  const daysAhead = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const forecastDays = Math.max(2, daysAhead + 1);

  const models = config.weather.models;
  const allMembers: number[] = [];

  for (const model of models) {
    const members = await withRetry(
      () => fetchModel(model, forecastDays, { latitude: opts.latitude, longitude: opts.longitude, variable }),
      `open-meteo-${model}`,
      { maxRetries: 2 },
    );
    allMembers.push(...members);
  }

  if (allMembers.length === 0) {
    throw new Error(`No ensemble members retrieved for ${targetDate}`);
  }

  log.info(
    { date: targetDate, totalMembers: allMembers.length, models },
    'Combined ensemble forecast ready',
  );

  return {
    date: targetDate,
    members: allMembers,
    modelTimestamp: new Date(),
    models: [...models],
    memberCount: allMembers.length,
  };
}
