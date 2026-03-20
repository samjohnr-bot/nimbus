import { config } from '../src/config.js';
import * as kalshi from '../src/kalshi/client.js';

async function main() {
  console.log('Environment:', config.env);
  console.log('API Key:', config.kalshi.apiKey.slice(0, 8) + '...');
  console.log('Base URL:', config.kalshi.baseUrl);
  console.log();

  try {
    const balance = await kalshi.getBalance();
    console.log('Auth successful!');
    console.log('Balance: $' + (balance.balance / 100).toFixed(2));
    console.log('Portfolio value: $' + (balance.portfolio_value / 100).toFixed(2));
  } catch (err: unknown) {
    console.error('Auth failed:', (err as Error).message);
  }
}

main();
