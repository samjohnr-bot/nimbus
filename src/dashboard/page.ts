export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nimbus — Weather Trading Bot</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e0e0e8; font-size: 14px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; font-weight: 600; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #9090a0; text-transform: uppercase; letter-spacing: 1px; }

  /* Top bar */
  .topbar { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid #1a1a2e; margin-bottom: 20px; flex-wrap: wrap; }
  .topbar h1 { color: #fff; }
  .badge { padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge-demo { background: #1a3a5c; color: #4da6ff; }
  .badge-dry { background: #3a2a1a; color: #ffaa33; }
  .badge-live { background: #1a3a1a; color: #33ff66; }
  .stat { text-align: center; padding: 0 12px; }
  .stat-value { font-size: 20px; font-weight: 700; color: #fff; }
  .stat-label { font-size: 11px; color: #6060a0; margin-top: 2px; }
  .stat-pos { color: #22c55e; }
  .stat-neg { color: #ef4444; }
  .spacer { flex: 1; }
  .refresh-info { font-size: 11px; color: #404060; }

  /* Grid */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  /* Cards */
  .card { background: #12121e; border: 1px solid #1a1a2e; border-radius: 10px; padding: 16px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 6px 8px; color: #6060a0; font-weight: 500; border-bottom: 1px solid #1a1a2e; }
  td { padding: 6px 8px; border-bottom: 1px solid #0f0f1a; }
  tr:hover { background: #16162a; }
  .yes { color: #22c55e; }
  .no { color: #ef4444; }
  .edge { font-weight: 600; }

  /* Bar chart */
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .bar-label { width: 80px; font-size: 12px; color: #9090a0; text-align: right; flex-shrink: 0; }
  .bar-track { flex: 1; height: 22px; background: #1a1a2e; border-radius: 4px; position: relative; overflow: hidden; }
  .bar-fill-model { height: 100%; background: #3b82f6; border-radius: 4px; position: absolute; top: 0; left: 0; opacity: 0.8; }
  .bar-fill-market { height: 100%; background: #f59e0b; border-radius: 4px 0 0 4px; position: absolute; top: 0; left: 0; opacity: 0.5; }
  .bar-value { width: 45px; font-size: 12px; color: #8080a0; flex-shrink: 0; }
  .legend { display: flex; gap: 16px; margin-bottom: 10px; font-size: 11px; color: #6060a0; }
  .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }

  /* P&L chart */
  .pnl-chart { height: 120px; display: flex; align-items: flex-end; gap: 2px; padding-top: 10px; }
  .pnl-bar { flex: 1; min-width: 8px; border-radius: 2px 2px 0 0; transition: height 0.3s; }
  .pnl-pos { background: #22c55e; }
  .pnl-neg { background: #ef4444; }
  .pnl-zero { background: #2a2a3e; min-height: 2px; }

  /* Empty state */
  .empty { color: #404060; text-align: center; padding: 30px; font-style: italic; }
</style>
</head>
<body>
<div class="container">
  <div class="topbar">
    <h1>Nimbus</h1>
    <span id="badge-env" class="badge badge-demo">DEMO</span>
    <span id="badge-mode" class="badge badge-dry">DRY RUN</span>
    <div class="spacer"></div>
    <div class="stat">
      <div class="stat-value" id="balance">—</div>
      <div class="stat-label">Balance</div>
    </div>
    <div class="stat">
      <div class="stat-value" id="daily-pnl">—</div>
      <div class="stat-label">Daily P&L</div>
    </div>
    <div class="stat">
      <div class="stat-value" id="positions">—</div>
      <div class="stat-label">Positions</div>
    </div>
    <div class="stat">
      <div class="stat-value" id="last-cycle">—</div>
      <div class="stat-label">Last Cycle</div>
    </div>
    <div class="refresh-info" id="refresh-info"></div>
  </div>

  <div class="grid">
    <div>
      <div class="card" style="margin-bottom: 20px;">
        <h2>Probability Distribution</h2>
        <div class="legend">
          <span><span class="legend-dot" style="background:#3b82f6"></span> Model</span>
          <span><span class="legend-dot" style="background:#f59e0b"></span> Market</span>
        </div>
        <div id="distribution"></div>
      </div>
      <div class="card">
        <h2>Edge Scanner</h2>
        <div id="signals"></div>
      </div>
    </div>
    <div>
      <div class="card" style="margin-bottom: 20px;">
        <h2>Daily P&L</h2>
        <div id="pnl-chart" class="pnl-chart"></div>
      </div>
      <div class="card">
        <h2>Trade History</h2>
        <div id="trades"></div>
      </div>
    </div>
  </div>
</div>

<script>
function fmt$(cents) {
  if (cents == null) return '—';
  return (cents >= 0 ? '' : '-') + '$' + (Math.abs(cents) / 100).toFixed(2);
}
function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }
function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}

async function fetchJson(url) {
  try { return await (await fetch(url)).json(); } catch { return null; }
}

async function refresh() {
  const [status, signals, trades, pnl] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/signals'),
    fetchJson('/api/trades'),
    fetchJson('/api/pnl'),
  ]);

  // Status bar
  if (status) {
    document.getElementById('badge-env').textContent = status.env.toUpperCase();
    const modeEl = document.getElementById('badge-mode');
    if (status.dryRun) { modeEl.textContent = 'DRY RUN'; modeEl.className = 'badge badge-dry'; }
    else { modeEl.textContent = 'LIVE'; modeEl.className = 'badge badge-live'; }

    document.getElementById('balance').textContent = fmt$(status.balance);
    const pnlEl = document.getElementById('daily-pnl');
    pnlEl.textContent = fmt$(status.dailyPnl);
    pnlEl.className = 'stat-value ' + (status.dailyPnl >= 0 ? 'stat-pos' : 'stat-neg');
    document.getElementById('positions').textContent = status.positions;
    document.getElementById('last-cycle').textContent = timeAgo(status.lastCycleTime);
  }

  // Distribution
  if (signals && signals.distribution && signals.distribution.length > 0) {
    const maxProb = Math.max(...signals.distribution.map(d => d.modelProb), 0.01);
    // Build market prob map from raw signals (yes side gives direct market implied prob)
    const marketMap = {};
    (signals.rawSignals || []).forEach(s => {
      if (s.side === 'yes') marketMap[s.bracket] = s.marketProb;
    });

    let html = '';
    signals.distribution.forEach(d => {
      const modelW = (d.modelProb / maxProb * 100).toFixed(0);
      const marketProb = marketMap[d.ticker] || 0;
      const adjMax = Math.max(maxProb, marketProb);
      const modelW2 = (d.modelProb / adjMax * 100).toFixed(0);
      const marketW = (marketProb / adjMax * 100).toFixed(0);
      html += '<div class="bar-row">' +
        '<div class="bar-label">' + d.range + '</div>' +
        '<div class="bar-track">' +
          '<div class="bar-fill-market" style="width:' + marketW + '%"></div>' +
          '<div class="bar-fill-model" style="width:' + modelW2 + '%"></div>' +
        '</div>' +
        '<div class="bar-value">' + fmtPct(d.modelProb) + (marketProb > 0 ? ' / ' + fmtPct(marketProb) : '') + '</div>' +
      '</div>';
    });
    document.getElementById('distribution').innerHTML = html;
  } else {
    document.getElementById('distribution').innerHTML = '<div class="empty">Waiting for first cycle...</div>';
  }

  // Signals table — show ALL raw signals (every edge the bot sees)
  const rawSigs = signals && signals.rawSignals ? signals.rawSignals : [];
  const tradeSigs = signals && signals.signals ? signals.signals : [];
  if (rawSigs.length > 0) {
    let html = '<table><tr><th>Side</th><th>Bracket</th><th>Edge</th><th>Model</th><th>Market</th><th>Spread</th><th>Status</th></tr>';
    rawSigs.forEach(s => {
      const isTraded = tradeSigs.some(t => t.ticker === s.bracket && t.side === s.side);
      const edgeOk = s.edge >= 0.08;
      const spreadOk = s.spread <= 8;
      let status = isTraded ? '<span class="yes">TRADE</span>' : '';
      if (!edgeOk) status = '<span style="color:#666">low edge</span>';
      else if (!spreadOk) status = '<span style="color:#666">wide spread</span>';
      else if (!isTraded) status = '<span style="color:#f59e0b">sized out</span>';
      html += '<tr>' +
        '<td class="' + s.side + '">' + s.side.toUpperCase() + '</td>' +
        '<td>' + s.range + '</td>' +
        '<td class="edge" style="color:' + (edgeOk ? '#22c55e' : '#666') + '">' + fmtPct(s.edge) + '</td>' +
        '<td>' + fmtPct(s.modelProb) + '</td>' +
        '<td>' + fmtPct(s.marketProb) + '</td>' +
        '<td style="color:' + (spreadOk ? '#e0e0e8' : '#ef4444') + '">' + s.spread + 'c</td>' +
        '<td>' + status + '</td>' +
      '</tr>';
    });
    html += '</table>';
    document.getElementById('signals').innerHTML = html;
  } else {
    document.getElementById('signals').innerHTML = '<div class="empty">No signals yet</div>';
  }

  // Trades table
  if (trades && trades.length > 0) {
    let html = '<table><tr><th>Time</th><th>Side</th><th>Bracket</th><th>Edge</th><th>Price</th><th>Qty</th><th>Status</th></tr>';
    trades.slice(0, 20).forEach(t => {
      const time = t.ts ? new Date(t.ts).toLocaleTimeString() : '—';
      html += '<tr>' +
        '<td>' + time + '</td>' +
        '<td class="' + t.side + '">' + (t.side || '').toUpperCase() + '</td>' +
        '<td>' + (t.ticker || '').split('-').pop() + '</td>' +
        '<td class="edge">' + (t.edge != null ? fmtPct(t.edge) : '—') + '</td>' +
        '<td>' + (t.price || '—') + 'c</td>' +
        '<td>' + (t.contracts || '—') + '</td>' +
        '<td title="' + (t.error || '') + '">' + (t.dryRun ? 'dry' : (t.status || '—')) + '</td>' +
      '</tr>';
    });
    html += '</table>';
    document.getElementById('trades').innerHTML = html;
  } else {
    document.getElementById('trades').innerHTML = '<div class="empty">No trades yet</div>';
  }

  // P&L chart
  if (pnl && pnl.length > 0) {
    const maxVal = Math.max(...pnl.map(p => Math.abs(p.dailyPnl || 0)), 1);
    let html = '';
    pnl.forEach(p => {
      const v = p.dailyPnl || 0;
      const h = Math.max(2, Math.abs(v) / maxVal * 100);
      const cls = v > 0 ? 'pnl-pos' : v < 0 ? 'pnl-neg' : 'pnl-zero';
      html += '<div class="pnl-bar ' + cls + '" style="height:' + h + '%" title="' + p.date + ': ' + fmt$(v) + '"></div>';
    });
    document.getElementById('pnl-chart').innerHTML = html;
  } else {
    document.getElementById('pnl-chart').innerHTML = '<div class="empty" style="height:100%;display:flex;align-items:center;justify-content:center">No P&L data yet</div>';
  }

  document.getElementById('refresh-info').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

refresh();
setInterval(refresh, 60000);
</script>
</body>
</html>`;
}
