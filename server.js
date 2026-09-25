const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const config = require('./config');

const DEMO = !(config.razorpayKeyId && config.razorpayKeySecret);
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'orders.json');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

// ---------- storage (single JSON file, fine for one outlet) ----------
let state = { orders: {}, counter: 100, day: '', open: true, soldOut: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch (_) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), err => { if (!err) fs.rename(tmp, DATA_FILE, () => {}); });
  }, 200);
}
const istDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ACTIVE = ['paid', 'preparing', 'ready'];
const activeCount = () => Object.values(state.orders).filter(o => ACTIVE.includes(o.status) && o.status !== 'ready').length;

// ---------- live updates (SSE) ----------
const staffClients = new Set();
const customerClients = new Map(); // orderId -> Set(res)
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function publicView(o) {
  return { id: o.id, number: o.number, status: o.status, items: o.items, total: o.total, name: o.name,
           paidAt: o.paidAt, dueAt: o.dueAt, readyAt: o.readyAt, promiseSeconds: config.promiseSeconds, now: Date.now() };
}
function staffSnapshot() {
  const today = istDay();
  const all = Object.values(state.orders).filter(o => o.paidAt);
  const live = all.filter(o => ACTIVE.includes(o.status));
  const done = all.filter(o => o.status === 'collected').sort((a, b) => b.paidAt - a.paidAt);
  const todays = all.filter(o => istDay(o.paidAt) === today);
  const readied = todays.filter(o => o.readyAt);
  const onTime = readied.filter(o => o.readyAt <= o.dueAt).length;
  return {
    now: Date.now(), open: state.open, demo: DEMO,
    menu: config.menu.map(m => ({ id: m.id, name: m.name, soldOut: !!state.soldOut[m.id] })),
    live: live.sort((a, b) => a.dueAt - b.dueAt).map(o => ({ ...publicView(o), phone: o.phone })),
    recent: done.slice(0, 10).map(publicView),
    stats: {
      orders: todays.length,
      revenue: todays.reduce((s, o) => s + o.total, 0),
      avgPrepSec: readied.length ? Math.round(readied.reduce((s, o) => s + (o.readyAt - o.paidAt), 0) / readied.length / 1000) : null,
      onTimePct: readied.length ? Math.round(100 * onTime / readied.length) : null
    }
  };
}
function broadcast(order) {
  const snap = staffSnapshot();
  for (const r of staffClients) sse(r, 'snapshot', snap);
  if (order) for (const r of customerClients.get(order.id) || []) sse(r, 'order', publicView(order));
}
setInterval(() => { for (const r of staffClients) r.write(': ping\n\n'); for (const s of customerClients.values()) for (const r of s) r.write(': ping\n\n'); }, 25000);

// ---------- helpers ----------
function markPaid(order, paymentId) {
  if (order.paidAt) return order; // idempotent (verify + webhook can both arrive)
  const today = istDay();
  if (state.day !== today) { state.day = today; state.counter = 100; }
  state.counter += 1;
  order.number = state.counter;
  order.status = 'paid';
  order.paidAt = Date.now();
  order.dueAt = order.paidAt + config.promiseSeconds * 1000;
  order.paymentId = paymentId || 'demo';
  save(); broadcast(order);
  return order;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
function staffAuth(req, res, next) {
  const pin = req.get('x-staff-pin') || req.query.pin;
  if (pin && safeEq(pin, config.staffPin)) return next();
  res.status(401).json({ error: 'Wrong PIN' });
}
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path, now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests, please wait a minute.' });
    arr.push(now); hits.set(k, arr); next();
  };
}
setInterval(() => { // drop abandoned checkouts
  const cutoff = Date.now() - config.pendingExpiryMinutes * 60000;
  let changed = false;
  for (const o of Object.values(state.orders)) if (o.status === 'pending_payment' && o.createdAt < cutoff) { o.status = 'expired'; changed = true; }
  if (changed) save();
}, 60000);

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);

// Razorpay webhook needs the raw body for signature checking
app.post('/api/webhook/razorpay', express.raw({ type: '*/*' }), (req, res) => {
  if (!config.razorpayWebhookSecret) return res.status(200).end();
  const sig = req.get('x-razorpay-signature') || '';
  if (!safeEq(sig, hmac(config.razorpayWebhookSecret, req.body.toString('utf8')))) return res.status(400).end();
  try {
    const evt = JSON.parse(req.body.toString('utf8'));
    if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
      const rpOrder = evt.payload?.order?.entity?.id || evt.payload?.payment?.entity?.order_id;
      const payId = evt.payload?.payment?.entity?.id;
      const order = Object.values(state.orders).find(o => o.razorpayOrderId === rpOrder);
      if (order) markPaid(order, payId);
    }
  } catch (_) {}
  res.status(200).end();
});

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/menu', (req, res) => {
  const n = activeCount();
  res.json({
    brand: config.brand, promiseSeconds: config.promiseSeconds, demo: DEMO,
    accepting: state.open && n < config.maxActiveOrders,
    reason: !state.open ? 'closed' : n >= config.maxActiveOrders ? 'busy' : null,
    keyId: config.razorpayKeyId || null,
    items: config.menu.map(m => ({ ...m, soldOut: !!state.soldOut[m.id] }))
  });
});

app.post('/api/orders', rateLimit(10, 60000), async (req, res) => {
  try {
    if (!state.open) return res.status(409).json({ error: 'We are not taking orders right now.' });
    if (activeCount() >= config.maxActiveOrders) return res.status(409).json({ error: 'We are very busy right now. Please try again in a couple of minutes.' });
    const { items, name, phone } = req.body || {};
    const cleanName = String(name || '').trim().slice(0, 40);
    const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
    if (!cleanName) return res.status(400).json({ error: 'Please enter your name.' });
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Your cart is empty.' });

    const lines = []; let total = 0, qtyTotal = 0;
    for (const it of items) {
      const m = config.menu.find(x => x.id === it.id);
      const qty = Math.floor(Number(it.qty));
      if (!m || !(qty >= 1 && qty <= 10)) return res.status(400).json({ error: 'Invalid item in cart.' });
      if (state.soldOut[m.id]) return res.status(409).json({ error: `${m.name} just sold out.` });
      lines.push({ id: m.id, name: m.name, qty, price: m.price }); total += m.price * qty; qtyTotal += qty;
    }
    if (qtyTotal > 10) return res.status(400).json({ error: 'Maximum 10 items per order.' });

    const order = { id: crypto.randomBytes(9).toString('base64url'), status: 'pending_payment', items: lines, total,
                    name: cleanName, phone: cleanPhone, createdAt: Date.now() };
    let payment;
    if (DEMO) {
      payment = { demo: true };
    } else {
      const r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   Authorization: 'Basic ' + Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64') },
        body: JSON.stringify({ amount: total * 100, currency: 'INR', receipt: order.id, notes: { name: cleanName } })
      });
      const j = await r.json();
      if (!r.ok) { console.error('Razorpay error', j); return res.status(502).json({ error: 'Payment service unavailable. Please try again.' }); }
      order.razorpayOrderId = j.id;
      payment = { keyId: config.razorpayKeyId, razorpayOrderId: j.id, amount: j.amount };
    }
    state.orders[order.id] = order; save();
    res.json({ id: order.id, total, payment });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong.' }); }
});

app.post('/api/orders/:id/verify', (req, res) => {
  const o = state.orders[req.params.id];
  if (!o || DEMO) return res.status(404).json({ error: 'Not found' });
  const { razorpay_payment_id: pid, razorpay_order_id: oid, razorpay_signature: sig } = req.body || {};
  if (!pid || oid !== o.razorpayOrderId || !safeEq(sig || '', hmac(config.razorpayKeySecret, `${oid}|${pid}`)))
    return res.status(400).json({ error: 'Payment could not be verified.' });
  markPaid(o, pid);
  res.json(publicView(o));
});

app.post('/api/orders/:id/demo-pay', (req, res) => {
  const o = state.orders[req.params.id];
  if (!DEMO || !o) return res.status(404).json({ error: 'Not found' });
  markPaid(o, 'demo'); res.json(publicView(o));
});

app.get('/api/orders/:id', (req, res) => {
  const o = state.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(publicView(o));
});

app.get('/api/orders/:id/stream', (req, res) => {
  const o = state.orders[req.params.id];
  if (!o) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); sse(res, 'order', publicView(o));
  if (!customerClients.has(o.id)) customerClients.set(o.id, new Set());
  customerClients.get(o.id).add(res);
  req.on('close', () => { const s = customerClients.get(o.id); if (s) { s.delete(res); if (!s.size) customerClients.delete(o.id); } });
});

// ---- staff ----
app.get('/api/staff/check', staffAuth, (req, res) => res.json({ ok: true }));
app.get('/api/staff/stream', staffAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); sse(res, 'snapshot', staffSnapshot());
  staffClients.add(res); req.on('close', () => staffClients.delete(res));
});
app.post('/api/staff/orders/:id/status', staffAuth, (req, res) => {
  const o = state.orders[req.params.id]; const st = req.body?.status;
  if (!o || !o.paidAt || !['preparing', 'ready', 'collected'].includes(st)) return res.status(400).json({ error: 'Bad request' });
  o.status = st;
  if (st === 'ready' && !o.readyAt) o.readyAt = Date.now();
  if (st === 'collected') { o.collectedAt = Date.now(); if (!o.readyAt) o.readyAt = o.collectedAt; }
  save(); broadcast(o); res.json({ ok: true });
});
app.post('/api/staff/open', staffAuth, (req, res) => { state.open = !!req.body?.open; save(); broadcast(); res.json({ ok: true }); });
app.post('/api/staff/soldout', staffAuth, (req, res) => {
  const { id, soldOut } = req.body || {};
  if (!config.menu.find(m => m.id === id)) return res.status(400).json({ error: 'Bad item' });
  state.soldOut[id] = !!soldOut; save(); broadcast(); res.json({ ok: true });
});

// ---- QR code + printable poster ----
app.get('/qr.png', async (req, res) => {
  res.type('png').send(await QRCode.toBuffer(config.baseUrl, { width: 900, margin: 2, errorCorrectionLevel: 'H' }));
});
app.get('/poster', async (req, res) => {
  const svg = await QRCode.toString(config.baseUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'H' });
  res.send(`<!doctype html><meta charset="utf-8"><title>Yanoi QR poster</title><style>
  @page{size:A4;margin:0}body{margin:0;font-family:system-ui,sans-serif;background:#fff;color:#1b1030;text-align:center}
  .p{width:210mm;height:297mm;box-sizing:border-box;padding:22mm 16mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between}
  h1{font-size:64pt;margin:0;letter-spacing:2px}h2{font-size:30pt;margin:6mm 0 0}.q{width:120mm}.q svg{width:100%;height:auto}
  .b{background:#1b1030;color:#fff;border-radius:14mm;padding:6mm 10mm;font-size:24pt}p{font-size:16pt;margin:0}</style>
  <div class="p"><div><h1>${config.brand}</h1><h2>Scan. Order. Grab it in ${Math.round(config.promiseSeconds / 60)} minutes.</h2></div>
  <div class="q">${svg}</div><div class="b">Pay by UPI · Collect at the door</div><p>${config.baseUrl}</p></div>`);
});

app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));
app.listen(config.port, () => {
  console.log(`Yanoi ordering running on port ${config.port}  (${DEMO ? 'DEMO payments - set Razorpay keys for live UPI' : 'LIVE Razorpay payments'})`);
  console.log(`Customer page: ${config.baseUrl}   Staff screen: ${config.baseUrl}/staff   QR poster: ${config.baseUrl}/poster`);
});
