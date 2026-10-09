// Rate-limit probe for a deployed terabox WebDAV worker.
//
// Escalates sustained request rates against PROPFIND Depth 0 (1 upstream
// Terabox API call each) and stops at the first sign of throttling
// (any status other than 207).
//
// Usage:
//   WEBDAV_USER=alice WEBDAV_PASS=secret \
//   WEBDAV_URL=https://terabox.example.workers.dev \
//   node test/live/rate-probe.mjs
//
// Results from the last campaign: see docs/live-testing.md.
const BASE = (process.env.WEBDAV_URL || 'https://terabox.taxin-404.workers.dev') + '/';
const USER = process.env.WEBDAV_USER;
const PASS = process.env.WEBDAV_PASS;
if (!USER || !PASS) {
  console.error('set WEBDAV_USER and WEBDAV_PASS');
  process.exit(2);
}
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const PHASES = [
  { rps: 2, secs: 10 },
  { rps: 4, secs: 10 },
  { rps: 8, secs: 10 },
  { rps: 16, secs: 10 },
  { rps: 32, secs: 10 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codes = new Map();
let errorSeen = false;
const throttled = [];

async function one(tag) {
  const t0 = Date.now();
  let status = 0;
  let retryAfter = null;
  try {
    const res = await fetch(BASE, {
      method: 'PROPFIND',
      headers: { Authorization: AUTH, Depth: '0' },
    });
    status = res.status;
    retryAfter = res.headers.get('retry-after');
    await res.arrayBuffer();
  } catch {
    status = -1;
  }
  const ms = Date.now() - t0;
  codes.set(status, (codes.get(status) || 0) + 1);
  if (status !== 207) {
    errorSeen = true;
    throttled.push({ tag, status, ms, retryAfter });
  }
  return { status, ms };
}

async function phase(rps, secs) {
  codes.clear();
  errorSeen = false;
  const lat = [];
  const interval = 1000 / rps;
  const end = Date.now() + secs * 1000;
  const workers = Math.max(1, Math.min(rps, 32));
  let sent = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (Date.now() < end && !errorSeen) {
        const start = Date.now();
        const { ms, status } = await one(rps);
        if (status === 207) lat.push(ms);
        sent++;
        const wait = interval - (Date.now() - start);
        if (wait > 0) await sleep(wait);
      }
    }),
  );

  lat.sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] : 0);
  const summary = [...codes.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    `${String(rps).padStart(3)} rps | sent=${String(sent).padStart(3)} | codes ${summary} | ` +
      `lat p50=${p(0.5)}ms p95=${p(0.95)}ms max=${lat.length ? lat[lat.length - 1] : 0}ms` +
      `${errorSeen ? '  <-- THROTTLED' : ''}`,
  );
  return !errorSeen;
}

console.log('phase escalation (PROPFIND depth 0 = 1 upstream API call each):');
let clean = true;
for (const ph of PHASES) {
  if (!clean) break;
  clean = await phase(ph.rps, ph.secs);
  if (clean) await sleep(5000); // cooldown between phases
}

if (throttled.length) {
  console.log('\nfirst throttled responses:');
  for (const t of throttled.slice(0, 5)) {
    console.log(`  rps=${t.tag} status=${t.status} lat=${t.ms}ms retry-after=${t.retryAfter}`);
  }
}
await sleep(3000);
console.log('\nrecovery check:');
const r = await one('recovery');
console.log(`  PROPFIND after probe -> ${r.status} (${r.ms}ms)`);
