# Yanoi – QR Order & Grab (5-minute promise)

Customer scans the QR at the door, picks a drink, pays by UPI, and a 5:00 countdown starts from the
moment payment succeeds. Staff see the order on a kitchen screen. The customer is told "Ready at the
door" and collects with their order number.

## What is in the box
- `/`        Customer order page (mobile web, no app or login)
- `/staff`   Staff screen (PIN protected): New / Preparing / Ready columns, live timers, sold-out
             toggles, pause-orders button, today's orders, revenue, average prep time, on-time %
- `/poster`  Print-ready A4 QR poster (Print, then Save as PDF).  `/qr.png` is the raw QR image.
- Menu: Noi Cold Coffee, Coffee Cloud, Hazelnut Drift  (edit in `config.js`)

## 1. Try it on your computer (demo mode, fake payments)
    npm install
    npm start

Open http://localhost:3000 (customer) and http://localhost:3000/staff (PIN 1234).
With no Razorpay keys the app runs in DEMO mode and simulates the payment.

## 2. Before going live: edit `config.js`
- Prices are PLACEHOLDERS (149 / 179 / 169). Put your real prices.
- `maxActiveOrders` (default 8): when this many orders are being made, the page says "busy". Set it
  to what your counter can really make in 5 minutes.
- `promiseSeconds` (default 300).

## 3. Real UPI payments (Razorpay)
1. Create a Razorpay account, complete KYC, and get API keys (Dashboard > Settings > API Keys).
2. Set these environment variables on the server:
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
   - `STAFF_PIN` (choose your own, do not keep 1234)
   - `BASE_URL` = your public https address, e.g. https://order.yanoi.in
3. Add a webhook in Razorpay (Settings > Webhooks): URL `https://YOUR-DOMAIN/api/webhook/razorpay`,
   events `payment.captured` and `order.paid`, plus a secret. Set the same secret as
   `RAZORPAY_WEBHOOK_SECRET`. This makes sure a paid order still reaches the kitchen even if the
   customer closes the page right after paying.
4. Test with Razorpay test-mode keys (they start with `rzp_test_`) before switching to live keys.

## 4. Put it online (https is required for payments and QR scanning)
Any small Node host works (Render, Railway, Fly.io, a VPS):
- Start command `npm start`, Node 18 or newer.
- Add the environment variables above.
- Attach a persistent disk and set `DATA_DIR` to its path, otherwise orders reset on every restart.
- Point a domain or subdomain at it, set `BASE_URL`, open `/poster`, print, and put it at the door.

## 5. Daily use
- Open `/staff` on a tablet at the counter and tap the bell button once to turn on alerts.
- New paid order: "Start making", then "Mark ready", then "Collected". The customer's phone updates live.
- A card turns amber under 90 seconds left and red when late. Late orders still go through with no
  penalty; the customer just sees "Almost there".
- Out of an item? Tap it at the top to mark it sold out. Too busy or closing? Tap "Taking orders" to pause.

## Notes and limits
- Built for one outlet. Data lives in one JSON file (`data/orders.json`), fine for a few hundred orders a day.
- Refunds are done from the Razorpay dashboard.
- Customer phone numbers are stored with orders and shown only on the staff screen.
- Prices are always calculated on the server, so customers cannot change them.
