// Set required env vars before any module imports trigger config validation
process.env.KALSHI_API_KEY = 'test-key-for-unit-tests';
process.env.NIMBUS_DRY_RUN = 'true';
process.env.LOG_LEVEL = 'error';
