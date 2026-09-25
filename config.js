// ---- Edit this file to change menu, prices and rules ----
// Prices are in RUPEES. PLACEHOLDER PRICES: set your real prices before going live.
module.exports = {
  brand: 'Yanoi',
  promiseSeconds: 300,          // the "ready in 5 minutes" promise
  maxActiveOrders: 8,           // orders being made at once; above this the page says "busy"
  pendingExpiryMinutes: 15,     // unpaid checkouts are dropped after this long
  menu: [
    { id: 'noi-cold-coffee', name: 'Noi Cold Coffee (Classic)',       desc: 'Signature cold coffee',   price: 83, emoji: '🥤' },
    { id: 'coffee-cloud',    name: 'Coffee Cloud (Coffee + Cloud)',   desc: 'Coffee with a cloud of foam', price: 104, emoji: '🥤☁️' },
    { id: 'hazelnut-drift',  name: 'Hazelnut Drift', desc: 'Hazelnut flavoured coffee', price: 114, emoji: '🥤🌰', badge: 'Best Seller' }
  ],
  // Secrets come from environment variables, never hard-code them here.
  staffPin: process.env.STAFF_PIN || '1234',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  port: process.env.PORT || 3000
};
 
