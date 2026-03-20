// Raw API response types (dollar strings as returned by Kalshi)
export interface KalshiMarketRaw {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  status: string;
  result: string;
  strike_type: 'greater' | 'less' | 'between';
  floor_strike?: number | null;
  cap_strike?: number | null;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  volume_fp: string;
  open_interest_fp: string;
  close_time: string;
  expiration_time: string;
  open_time: string;
  rules_primary: string;
}

// Normalized types (cents as integers for internal use)
export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle: string;
  status: string;
  result: string;
  strikeType: 'greater' | 'less' | 'between';
  floorStrike: number | null;
  capStrike: number | null;
  yesBid: number;   // cents
  yesAsk: number;   // cents
  noBid: number;    // cents
  noAsk: number;    // cents
  lastPrice: number; // cents
  volume: number;
  openInterest: number;
  closeTime: string;
  expirationTime: string;
  openTime: string;
}

export interface KalshiOrderbookEntry {
  price: number; // cents
  size: number;
}

export interface KalshiOrderbook {
  yes: KalshiOrderbookEntry[];
  no: KalshiOrderbookEntry[];
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  status: 'resting' | 'canceled' | 'executed' | 'pending';
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit';
  yes_price: number;
  no_price: number;
  count: number;
  remaining_count: number;
  created_time: string;
}

export interface KalshiPosition {
  ticker: string;
  market_exposure: number;
  resting_orders_count: number;
  total_traded: number;
  realized_pnl: number;
  position: number;
}

export interface KalshiFill {
  trade_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  yes_price: number;
  no_price: number;
  created_time: string;
}

export interface KalshiBalance {
  balance: number;
  portfolio_value: number;
}

export interface CreateOrderParams {
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  type: 'limit';
  count: number;
  yes_price: number;
}

// Raw API response wrappers
export interface KalshiMarketsResponse {
  markets: KalshiMarketRaw[];
  cursor: string;
}

export interface KalshiOrderbookRawResponse {
  orderbook_fp: {
    yes_dollars: [string, string][];
    no_dollars: [string, string][];
  };
}

export interface KalshiOrderResponse {
  order: KalshiOrder;
}

export interface KalshiPositionsResponse {
  market_positions: KalshiPosition[];
  cursor: string;
}

export interface KalshiFillsResponse {
  fills: KalshiFill[];
  cursor: string;
}
