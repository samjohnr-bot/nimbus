import { config } from '../config.js';

export function isWithinActiveHours(): boolean {
  const now = new Date();
  const chicagoTime = new Date(
    now.toLocaleString('en-US', { timeZone: config.scheduler.timezone }),
  );
  const hour = chicagoTime.getHours();
  return hour >= config.scheduler.activeHoursStart && hour < config.scheduler.activeHoursEnd;
}

export function getTomorrowDateString(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

export function getChicagoTimeString(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: config.scheduler.timezone,
    hour12: false,
  });
}

export function generateCycleId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
