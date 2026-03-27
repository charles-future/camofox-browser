// Prometheus metrics for camofox-browser.
// Isolated in lib/ to keep process.env out of server.js (OpenClaw scanner rule).
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// --- Counters ---

export const requestsTotal = new client.Counter({
  name: 'jo_browser_requests_total',
  help: 'Total HTTP requests by action and status',
  labelNames: ['action', 'status'],
  registers: [register],
});

export const tabLockTimeoutsTotal = new client.Counter({
  name: 'jo_browser_tab_lock_timeouts_total',
  help: 'Tab lock queue timeouts resulting in 503',
  registers: [register],
});

// --- Histograms ---

export const requestDuration = new client.Histogram({
  name: 'jo_browser_request_duration_seconds',
  help: 'Request duration in seconds by action',
  labelNames: ['action'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const pageLoadDuration = new client.Histogram({
  name: 'jo_browser_page_load_duration_seconds',
  help: 'Page load duration in seconds',
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [register],
});

// --- Gauges ---

export const activeTabsGauge = new client.Gauge({
  name: 'jo_browser_active_tabs',
  help: 'Current number of open browser tabs',
  registers: [register],
});

export const tabLockQueueDepth = new client.Gauge({
  name: 'jo_browser_tab_lock_queue_depth',
  help: 'Current number of requests waiting for a tab lock',
  registers: [register],
});

export const memoryUsageBytes = new client.Gauge({
  name: 'jo_browser_memory_usage_bytes',
  help: 'Process RSS memory usage in bytes',
  registers: [register],
});

// Periodic memory reporter
const MEMORY_INTERVAL_MS = 30_000;
let memoryTimer = null;

export function startMemoryReporter() {
  if (memoryTimer) return;
  const report = () => memoryUsageBytes.set(process.memoryUsage().rss);
  report();
  memoryTimer = setInterval(report, MEMORY_INTERVAL_MS);
  memoryTimer.unref(); // don't keep process alive
}

export function stopMemoryReporter() {
  if (memoryTimer) { clearInterval(memoryTimer); memoryTimer = null; }
}

// Helper: derive a short action name from Express route
export function actionFromReq(req) {
  const method = req.method;
  const path = req.route?.path || req.path;
  // POST /tabs -> create_tab, DELETE /tabs/:tabId -> delete_tab, etc.
  if (path === '/tabs' && method === 'POST') return 'create_tab';
  if (path === '/tabs/:tabId' && method === 'DELETE') return 'delete_tab';
  if (path === '/tabs/group/:listItemId' && method === 'DELETE') return 'delete_tab_group';
  if (path === '/sessions/:userId' && method === 'DELETE') return 'delete_session';
  if (path === '/sessions/:userId/cookies' && method === 'POST') return 'set_cookies';
  if (path === '/tabs/open' && method === 'POST') return 'open_url';
  if (path === '/tabs' && method === 'GET') return 'list_tabs';
  // /tabs/:tabId/<action>
  const m = path.match(/^\/tabs\/:tabId\/(\w+)$/);
  if (m) return m[1]; // navigate, snapshot, click, type, scroll, etc.
  // legacy compat routes
  if (['/start', '/stop', '/navigate', '/snapshot', '/act'].includes(path)) return path.slice(1);
  if (path === '/youtube/transcript') return 'youtube_transcript';
  if (path === '/health') return 'health';
  if (path === '/metrics') return 'metrics';
  return `${method.toLowerCase()}_${path.replace(/[/:]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
}

export { register };
