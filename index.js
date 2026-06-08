const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- ENV ---
const FREEDOM_MERCHANT_ID = process.env.FREEDOM_MERCHANT_ID;
const FREEDOM_SECRET_KEY = process.env.FREEDOM_SECRET_KEY;
const FREEDOM_BASE_URL = process.env.FREEDOM_BASE_URL || 'https://api.freedompay.kg';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'aikill.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SERVER_URL = process.env.SERVER_URL;          // напр. https://xxx.up.railway.app
const STORE_URL = process.env.STORE_URL || 'https://nfo.kg';
const TESTING_MODE = process.env.FP_TESTING_MODE || '1'; // '1' для теста, '0' для боя

// --- DB ---
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      order_ref   TEXT PRIMARY KEY,
      amount      NUMERIC NOT NULL,
      currency    TEXT NOT NULL,
      cart        JSONB NOT NULL,
      customer    JSONB NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      shopify_order_id TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('DB ready');
}

// --- helpers ---
function generateSig(scriptName, params, secretKey) {
  const sorted = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});
  const values = [scriptName, ...Object.values(sorted), secretKey];
  return crypto.createHash('md5').update(values.join(';')).digest('hex');
}
function randomSalt() {
  return crypto.randomBytes(8).toString('hex');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// POST к Freedom Pay с retry/timeout (лечит ETIMEDOUT)
async function fpInitPayment(params) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(
        FREEDOM_BASE_URL + '/init_payment.php',
        new URLSearchParams(params).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
      );
      return res.data;
    } catch (err) {
      lastErr = err;
      console.error(`FP attempt ${attempt} failed:`, err.message);
      if (attempt < 3) await sleep(1800);
    }
  }
  throw lastErr;
}

// --- 1) Старт оплаты: принимает корзину + данные доставки ---
app.post('/pay/start', async (req, res) => {
  try {
    const { cart, customer } = req.body;
    if (!cart || !cart.items || !cart.items.length) {
      return res.status(400).json({ error: 'Empty cart' });
    }
    // cart.total_price приходит в тиынах -> сомы
    const amountSom = (Number(cart.total_price) / 100).toFixed(2);
    const orderRef = 'NFO-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');

    await pool.query(
      `INSERT INTO payments (order_ref, amount, currency, cart, customer)
       VALUES ($1,$2,$3,$4,$5)`,
      [orderRef, amountSom, 'KGS', JSON.stringify(cart), JSON.stringify(customer || {})]
    );

    const params = {
      pg_merchant_id: FREEDOM_MERCHANT_ID,
      pg_order_id: orderRef,
      pg_amount: amountSom,
      pg_currency: 'KGS',
      pg_description: 'Order ' + orderRef,
      pg_salt: randomSalt(),
      pg_result_url: SERVER_URL + '/freedompay/result',
      pg_success_url: SERVER_URL + '/freedompay/return?ref=' + encodeURIComponent(orderRef),
      pg_failure_url: STORE_URL + '/pages/payment-failed',
      pg_language: 'ru',
      pg_testing_mode: TESTING_MODE,
    };
    if (customer && customer.email) params.pg_user_contact_email = customer.email;
    if (customer && customer.phone) params.pg_user_phone = String(customer.phone).replace(/\D/g, '');
    params.pg_sig = generateSig('init_payment.php', params, FREEDOM_SECRET_KEY);

    const data = await fpInitPayment(params);
    const redirect = (data.match(/<pg_redirect_url>(.*?)<\/pg_redirect_url>/) || [])[1];
    if (!redirect) {
      console.error('No redirect from FP:', data);
      return res.status(502).json({ error: 'Payment init failed' });
    }
    res.json({ redirect_url: redirect, order_ref: orderRef });
  } catch (err) {
    console.error('pay/start error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- 2) Серверный коллбэк от Freedom Pay (создаёт заказ как paid) ---
app.post('/freedompay/result', async (req, res) => {
  try {
    const params = { ...req.body };
    const receivedSig = params.pg_sig;
    delete params.pg_sig;
    const expected = generateSig('result', params, FREEDOM_SECRET_KEY);
    if (receivedSig !== expected) {
      console.error('Invalid signature on result');
      return res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>error</pg_status><pg_description>Invalid signature</pg_description></response>');
    }

    const orderRef = params.pg_order_id;
    const paid = params.pg_result === '1' || params.pg_status === 'ok';
    console.log('FP result for', orderRef, 'paid=', paid);

    if (paid) {
      const { rows } = await pool.query('SELECT * FROM payments WHERE order_ref=$1', [orderRef]);
      const rec = rows[0];
      if (rec && rec.status !== 'paid') {
        await createShopifyOrder(rec, params.pg_payment_id);
        await pool.query('UPDATE payments SET status=$1 WHERE order_ref=$2', ['paid', orderRef]);
      }
    }
    res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>ok</pg_status></response>');
  } catch (err) {
    console.error('result error:', err.message);
    res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>error</pg_status></response>');
  }
});

// --- 3) Возврат покупателя после оплаты ---
app.get('/freedompay/return', (req, res) => {
  res.redirect(STORE_URL + '/pages/payment-success');
});

// --- Создание заказа в Shopify как оплаченного ---
async function createShopifyOrder(rec, paymentId) {
  const cart = rec.cart;
  const c = rec.customer || {};
  const line_items = cart.items.map(i => ({
    variant_id: i.variant_id || i.id,
    quantity: i.quantity,
  }));
  const orderPayload = {
    order: {
      line_items,
      financial_status: 'paid',
      currency: 'KGS',
      email: c.email || undefined,
      phone: c.phone || undefined,
      tags: 'FreedomPay',
      note: 'FreedomPay payment_id: ' + paymentId + ' / ref: ' + rec.order_ref,
      shipping_address: c.address ? {
        first_name: c.first_name || '',
        last_name: c.last_name || '',
        address1: c.address || '',
        city: c.city || '',
        phone: c.phone || '',
        country: c.country || 'Kyrgyzstan',
      } : undefined,
      transactions: [{ kind: 'sale', status: 'success', amount: rec.amount, gateway: 'Freedom Pay' }],
    },
  };
  const r = await axios.post(
    'https://' + SHOPIFY_STORE + '/admin/api/2024-01/orders.json',
    orderPayload,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  console.log('Shopify order created:', r.data.order && r.data.order.id);
  return r.data.order;
}
// === Path A: create Draft Order from cart, then init Freedom Pay ===
app.post('/order/create', async (req, res) => {
  try {
    const { items, customer, address, note, discount_code } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // 1. Build Draft Order payload
    const draft = {
      draft_order: {
        line_items: items.map(i => ({
          variant_id: Number(i.variant_id),
          quantity: Number(i.quantity) || 1,
        })),
        note: note || '',
        tags: 'freedom_pay',
        email: (customer && customer.email) || undefined,
        shipping_address: address ? {
          first_name: (customer && customer.name) || '',
          address1: address,
          phone: (customer && customer.phone) || '',
        } : undefined,
      },
    };
    if (discount_code) {
      draft.draft_order.applied_discount = {
        description: discount_code,
        value_type: 'percentage',
        value: '0',
        title: discount_code,
      };
    }

    const draftRes = await axios.post(
      'https://' + SHOPIFY_STORE + '/admin/api/2024-01/draft_orders.json',
      draft,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );

    const draftOrder = draftRes.data.draft_order;
    const orderId = draftOrder.id;
    const amount = draftOrder.total_price; // KGS

    // 2. Init Freedom Pay payment
    const salt = randomSalt();
    const params = {
      pg_merchant_id: FREEDOM_MERCHANT_ID,
      pg_order_id: String(orderId),
      pg_amount: String(amount),
      pg_currency: 'KGS',
      pg_description: 'Заказ #' + orderId,
      pg_salt: salt,
      pg_result_url: SERVER_URL + '/freedompay/result',
      pg_success_url: 'https://' + SHOPIFY_STORE + '/pages/payment-success',
      pg_failure_url: 'https://' + SHOPIFY_STORE + '/pages/payment-failed',
      pg_language: 'ru',
      pg_testing_mode: process.env.NODE_ENV === 'production' ? '0' : '1',
    };
    if (customer && customer.email) params.pg_user_contact_email = customer.email;
    if (customer && customer.phone) params.pg_user_phone = customer.phone;
    params.pg_sig = generateSig('init_payment.php', params, FREEDOM_SECRET_KEY);

    const fpRes = await axios.post(
      FREEDOM_BASE_URL + '/init_payment.php',
      new URLSearchParams(params).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const redirectMatch = fpRes.data.match(/<pg_redirect_url>(.*?)<\/pg_redirect_url>/);
    const statusMatch = fpRes.data.match(/<pg_status>(.*?)<\/pg_status>/);
    if (statusMatch && statusMatch[1] === 'ok' && redirectMatch) {
      return res.json({ redirect_url: redirectMatch[1], order_id: orderId });
    }
    const errMatch = fpRes.data.match(/<pg_error_description>(.*?)<\/pg_error_description>/);
    console.error('Freedom Pay error:', fpRes.data);
    return res.status(400).json({ error: errMatch ? errMatch[1] : 'Payment init error' });
  } catch (err) {
    console.error('order/create error:', err.message, err.response && JSON.stringify(err.response.data));
    return res.status(500).json({ error: 'Server error' });
  }
});
app.get('/', (req, res) => res.json({ status: 'Freedom Pay server running', merchant_id: FREEDOM_MERCHANT_ID }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log('Server started on port ' + PORT)))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
