export interface Bracket {
  ticker: string;
  rangeLabel: string;
  lowBound: number | null;
  highBound: number | null;
}

export interface BracketProbability {
  bracket: Bracket;
  modelProb: number;
}

export interface MarketSnapshot {
  bracket: Bracket;
  bestBidYes: number;
  bestAskYes: number;
  bestBidNo: number;
  bestAskNo: number;
  spread: number;
  midpoint: number;
  marketImpliedProb: number;
}

export interface BracketSignal {
  bracket: Bracket;
  side: 'yes' | 'no';
  modelProb: number;
  marketImpliedProb: number;
  edge: number;
  spread: number;
  price: number;
}

export interface TradeSignal extends BracketSignal {
  contracts: number;
  maxCost: number;
  fee: number;
}

export interface TradeResult {
  signal: TradeSignal;
  orderId: string;
  status: 'filled' | 'partial' | 'cancelled' | 'failed';
  filledContracts: number;
  filledPrice: number;
  timestamp: Date;
  error?: string;
}

export interface CycleSummary {
  cycleId: string;
  timestamp: Date;
  date: string;
  balance: number;
  positions: number;
  signalsGenerated: number;
  tradesAttempted: number;
  tradesFilled: number;
  dailyPnl: number;
}
