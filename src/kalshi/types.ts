export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  title: string;
  subtitle: string;
  status: 'open' | 'closed' | 'settled';
  result: 'yes' | 'no' | '' | null;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  close_time: string;
  expiration_time: string;
  floor_strike: number | null;
  cap_strike: number | null;
}

export interface KalshiOrderbook {
  yes: [number, number][];
  no: [number, number][];
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

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

export interface KalshiOrderbookResponse {
  orderbook: KalshiOrderbook;
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
