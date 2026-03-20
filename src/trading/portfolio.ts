import * as kalshi from '../kalshi/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('portfolio');

export interface PortfolioState {
  balance: number;
  portfolioValue: number;
  positions: Map<string, number>;
  totalExposure: number;
}

let currentState: PortfolioState = {
  balance: 0,
  portfolioValue: 0,
  positions: new Map(),
  totalExposure: 0,
};

export async function sync(): Promise<PortfolioState> {
  const [balanceData, positions] = await Promise.all([
    kalshi.getBalance(),
    kalshi.getPositions(),
  ]);

  const posMap = new Map<string, number>();
  let totalExposure = 0;

  for (const pos of positions) {
    if (pos.position !== 0) {
      posMap.set(pos.ticker, pos.market_exposure);
      totalExposure += Math.abs(pos.market_exposure);
    }
  }

  currentState = {
    balance: balanceData.balance,
    portfolioValue: balanceData.portfolio_value,
    positions: posMap,
    totalExposure,
  };

  log.info(
    {
      balance: currentState.balance,
      positions: posMap.size,
      totalExposure,
    },
    'Portfolio synced',
  );

  return currentState;
}

export function getState(): Readonly<PortfolioState> {
  return currentState;
}
