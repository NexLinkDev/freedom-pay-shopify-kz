const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

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

const FREEDOM_MERCHANT_ID = process.env.FREEDOM_MERCHANT_ID;
const FREEDOM_SECRET_KEY = process.env.FREEDOM_SECRET_KEY;
const FREEDOM_BASE_URL = process.env.FREEDOM_BASE_URL || 'https://api.freedompay.kg';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'aikill.myshopify.com';
const SERVER_URL = process.env.SERVER_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VER = '2024-01';

function generateSig(scriptName, params, secretKey) {
  const sorted = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});
  const values = [scriptName, ...Object.values(sorted), secretKey];
  return crypto.createHash('md5').update(values.join(';')).digest('hex');
}

function randomSalt() {
  return crypto.randomBytes(16).toString('hex');
}

async function fpInitPayment({ order_id, amount, currency, description, customer_email, customer_phone }) {
  const params = {
    pg_merchant_id: FREEDOM_MERCHANT_ID,
    pg_order_id: String(order_id),
    pg_amount: String(amount),
    pg_currency: currency || 'KGS',
    pg_description: description || 'Order #' + order_id,
    pg_salt: randomSalt(),
    pg_result_url: SERVER_URL + '/freedompay/result',
    pg_success_url: 'https://' + SHOPIFY_STORE + '/pages/payment-success',
    pg_failure_url: 'https://' + SHOPIFY_STORE + '/pages/payment-failed',
    pg_language: 'ru',
    pg_testing_mode: process.env.NODE_ENV === 'production' ? '0' : '1',
  };
  if (customer_email) params.pg_user_contact_email = customer_email;
  if (customer_phone) params.pg_user_phone = String(customer_phone).replace(/\D/g, '');
  params.pg_sig = generateSig('init_payment.php', params, FREEDOM_SECRET_KEY);

  const response = await axios.post(
    FREEDOM_BASE_URL + '/init_payment.php',
    new URLSearchParams(params).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  const redirectMatch = response.data.match(/<pg_redirect_url>(.*?)<\/pg_redirect_url>/);
  const statusMatch = response.data.match(/<pg_status>(.*?)<\/pg_status>/);
  if (statusMatch && statusMatch[1] === 'ok' && redirectMatch) {
    return { redirect_url: redirectMatch[1] };
  }
  const errMatch = response.data.match(/<pg_error_description>(.*?)<\/pg_error_description>/);
  throw new Error(errMatch ? errMatch[1] : 'Payment creation error');
}

app.post('/order/create', async (req, res) => {
  try {
    const { items, customer, address, note, discount_code } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Cart is empty' });
    if (!customer || !customer.name || !customer.phone || !customer.email) {
      return res.status(400).json({ error: 'Name, phone and email required' });
    }

    const draftBody = {
      draft_order: {
        line_items: items.map(i => ({ variant_id: i.variant_id, quantity: i.quantity })),
        note: note || '',
        email: customer.email,
        shipping_address: {
          name: customer.name,
          phone: customer.phone,
          address1: address || '',
        },
        tags: 'freedom-pay',
      }
    };
    if (discount_code) draftBody.draft_order.applied_discount = { code: discount_code, value: '0', value_type: 'fixed_amount', title: discount_code };

    const draftRes = await axios.post(
      'https://' + SHOPIFY_STORE + '/admin/api/' + API_VER + '/draft_orders.json',
      draftBody,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );
    const draft = draftRes.data.draft_order;
    const orderId = draft.id;
    const amount = draft.total_price;

    const result = await fpInitPayment({
      order_id: orderId,
      amount,
      currency: draft.currency || 'KGS',
      description: 'Order #' + orderId,
      customer_email: customer.email,
      customer_phone: customer.phone,
    });
    res.json({ redirect_url: result.redirect_url, order_ref: String(orderId) });
  } catch (err) {
    console.error('Order create error:', err.message, err.response && JSON.stringify(err.response.data));
    res.status(500).json({ error: 'Order creation failed' });
  }
});

app.post('/freedompay/create', async (req, res) => {
  try {
    const { order_id, amount, currency, description, customer_email } = req.body;
    const result = await fpInitPayment({ order_id, amount, currency, description, customer_email });
    res.json({ redirect_url: result.redirect_url });
  } catch (err) {
    console.error('Create payment error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/freedompay/result', async (req, res) => {
  try {
    const params = { ...req.body };
    const receivedSig = params.pg_sig;
    delete params.pg_sig;
    const expectedSig = generateSig('result', params, FREEDOM_SECRET_KEY);
    if (receivedSig !== expectedSig) {
      console.error('Invalid signature');
      return res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>error</pg_status><pg_description>Invalid signature</pg_description></response>');
    }
    const { pg_order_id, pg_payment_id, pg_result } = params;
console.log('Payment result - order:', pg_order_id, '| result:', pg_result, ...);
if (String(pg_result) === '1') {
  await confirmShopifyOrder(pg_order_id, pg_payment_id);
}
    }
    res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>ok</pg_status></response>');
  } catch (err) {
    console.error('Result webhook error:', err.message);
    res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>error</pg_status></response>');
  }
});

async function confirmShopifyOrder(orderId, paymentId) {
  if (!SHOPIFY_ACCESS_TOKEN) { console.warn('SHOPIFY_ACCESS_TOKEN not set'); return; }
  try {
    const url = 'https://' + SHOPIFY_STORE +
      '/admin/api/' + API_VER + '/draft_orders/' + orderId + '/complete.json?payment_pending=false';
    await axios.put(url, {}, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    });
    console.log('Draft order', orderId, 'completed (paid). FP payment:', paymentId);
  } catch (err) {
    console.error('Draft complete error:', err.message, err.response && JSON.stringify(err.response.data));
  }
}

app.get('/auth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code) return res.status(400).send('No code provided');
  try {
    const tokenRes = await axios.post('https://' + (shop || 'aikill.myshopify.com') + '/admin/oauth/access_token', {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code
    });
    const token = tokenRes.data.access_token;
    res.send('<h2>Installation complete</h2><p>App authorized. Token received by server.</p>');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'Freedom Pay server running', merchant_id: FREEDOM_MERCHANT_ID }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));
