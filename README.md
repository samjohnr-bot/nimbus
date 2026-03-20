# Nimbus

Autonomous weather event-contract trading bot for [Kalshi](https://kalshi.com). Trades daily high temperature bracket markets using ensemble weather model data.

## How It Works

1. **Ingests** ensemble forecasts from Open-Meteo (GEFS 31 members + ECMWF 51 members = 82 total)
2. **Builds** a probability distribution across Kalshi's 6 temperature brackets
3. **Compares** model probabilities against market-implied probabilities
4. **Trades** when edge exceeds threshold, spread is tight, and risk budget allows
5. **Sizes** positions using fractional Kelly criterion (0.15x)
6. **Logs** every prediction, order, fill, and settlement to JSONL

## Target Market

**KXHIGHCHI** — Daily high temperature in Chicago, IL (O'Hare station)

## Setup

```bash
# Install dependencies
npm install

# Copy env template and configure
cp .env.example .env

# Generate API keys at https://demo.kalshi.co (demo) or https://kalshi.com (production)
# Save private key to keys/kalshi-demo.pem
mkdir -p keys
# Place your .pem file in keys/kalshi-demo.pem
```

## Configuration

All config via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `NIMBUS_ENV` | `demo` | `demo` or `production` |
| `KALSHI_API_KEY` | — | Your Kalshi API key ID |
| `KALSHI_PRIVATE_KEY_PATH` | `./keys/kalshi-demo.pem` | Path to RSA private key |
| `NIMBUS_DRY_RUN` | `true` | Log trades without executing |
| `NIMBUS_EDGE_THRESHOLD` | `0.08` | Minimum edge to trade (8%) |
| `NIMBUS_MAX_TRADE_SIZE` | `7500` | Max per-trade cost in cents ($75) |
| `NIMBUS_MAX_DAILY_LOSS` | `15000` | Daily loss limit in cents ($150) |
| `NIMBUS_KELLY_FRACTION` | `0.15` | Kelly criterion fraction |
| `NIMBUS_POLL_INTERVAL` | `10` | Minutes between cycles |

## Running

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start

# Dry run (default) — logs what it would trade without placing orders
NIMBUS_DRY_RUN=true npm run dev
```

## Schedule

- **Trading cycles**: Every 10 minutes, 10 AM–11 PM Chicago time
- **Settlement check**: Daily at 7 AM Chicago time
- **Daily reset**: Midnight Chicago time

## Logs

JSONL files in `data/logs/`:
- `predictions-YYYY-MM-DD.jsonl` — probability distributions
- `trades-YYYY-MM-DD.jsonl` — orders and fills
- `cycles-YYYY-MM-DD.jsonl` — cycle summaries
- `settlements-YYYY-MM-DD.jsonl` — final outcomes

## Risk Controls

- Per-trade max: $75 (configurable)
- Daily loss limit: $150 (configurable)
- Max 30% of bankroll on any single trade
- Max 60% of bankroll deployed at once
- Edge must exceed fees after sizing
- Data freshness check (2 hour max age)
- Minimum time before market close (1 hour)

## Architecture

```
Scheduler (Croner)
  → Reconciler (sync positions from Kalshi)
  → Signal Generator
      → Open-Meteo Ensemble API (82 members)
      → Kalshi Markets + Orderbooks
      → Distribution Builder (members → bracket probabilities)
      → Edge Calculator (model prob vs market prob)
      → Risk Filter (edge, spread, limits)
      → Kelly Sizer (position sizing)
  → Executor (limit orders, fill monitoring)
  → Analytics Tracker (JSONL)
```
