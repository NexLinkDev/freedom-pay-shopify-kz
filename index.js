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
const FREEDOM_BASE_URL = process.env.FREEDOM_BASE_URL || 'https://api.freedompay.kz';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'syhtck-yp.myshopify.com';
const SERVER_URL = process.env.SERVER_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VER = '2024-01';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
    pg_currency: currency || 'KZT',
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

function gidNum(gid){ const m = String(gid||'').match(/\/(\d+)$/); return m ? m[1] : String(gid||''); }

// Validate a Shopify discount code via the Admin GraphQL API and return its value.
async function lookupDiscount(code) {
  if (!SHOPIFY_ACCESS_TOKEN) return { ok: false, error: 'Server not configured' };
  const query = `query($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    codeDiscount {
      __typename
      ... on DiscountCodeBasic {
        title
        status
        appliesOncePerCustomer
        usageLimit
        minimumRequirement {
          __typename
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
              ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
              }
        customerGets {
          value {
            __typename
            ... on DiscountPercentage { percentage }
            ... on DiscountAmount { amount { amount currencyCode } }
          }
          items {
            __typename
            ... on DiscountProducts {
              products(first: 100) { nodes { id } }
              productVariants(first: 100) { nodes { id } }
            }
            ... on AllDiscountItems { allItems }
          }
        }
      }
    }
  }
}`;
  let gql;
  try {
    gql = await axios.post(
      'https://' + SHOPIFY_STORE + '/admin/api/' + API_VER + '/graphql.json',
      { query, variables: { code: code } },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
  } catch (e) {
    console.error('Shopify request failed:', e.message);
    return { ok: false, error: 'Ошибка доступа к скидкам' };
  }
  if (gql.data && gql.data.errors) {
    console.error('Shopify GraphQL errors:', JSON.stringify(gql.data.errors));
    return { ok: false, error: 'Ошибка доступа к скидкам' };
  }
  const node = gql.data && gql.data.data && gql.data.data.codeDiscountNodeByCode;
  const disc = node && node.codeDiscount;
  if (!disc) return { ok: false, error: 'Промокод не найден' };
  if (disc.status && disc.status !== 'ACTIVE') return { ok: false, error: 'Промокод неактивен' };
  const itemsNode = disc.customerGets && disc.customerGets.items;
  const value = disc.customerGets && disc.customerGets.value;
  const minReq = disc.minimumRequirement;
  let minSubtotal = 0, minQty = 0;
  if (minReq && minReq.__typename === 'DiscountMinimumSubtotal') {
      minSubtotal = Number(minReq.greaterThanOrEqualToSubtotal && minReq.greaterThanOrEqualToSubtotal.amount) || 0;
  } else if (minReq && minReq.__typename === 'DiscountMinimumQuantity') {
      minQty = Number(minReq.greaterThanOrEqualToQuantity) || 0;
  }

  let scope = { all: true, productIds: [], variantIds: [] };
  if (itemsNode && itemsNode.__typename === 'DiscountProducts') {
    scope = {
      all: false,
      productIds: (itemsNode.products && itemsNode.products.nodes || []).map(n => n.id),
      variantIds: (itemsNode.productVariants && itemsNode.productVariants.nodes || []).map(n => n.id)
    };
  }

  const base = { ok: true, title: disc.title || '', scope,
    oncePerCustomer: !!disc.appliesOncePerCustomer, usageLimit: disc.usageLimit || null, minSubtotal, minQty };

  if (value && value.__typename === 'DiscountPercentage') {
    return Object.assign({}, base, { type: 'percentage', percentage: Number(value.percentage) || 0 });
  }
  if (value && value.__typename === 'DiscountAmount') {
    return Object.assign({}, base, { type: 'amount',
      amount: Number(value.amount && value.amount.amount) || 0,
      currency: (value.amount && value.amount.currencyCode) || 'KZT' });
  }
  return { ok: false, error: 'Тип скидки не поддерживается' };
}

app.post('/discount/validate', async (req, res) => {
  try {
    const { code, cart_total, items } = req.body;
    if (!code) return res.json({ valid: false, error: 'Код не указан' });
    const d = await lookupDiscount(String(code).trim());
    if (!d.ok) return res.json({ valid: false, error: d.error });
    const total = Number(cart_total) || 0;
    const list = Array.isArray(items) ? items : [];
        // Минимальная сумма заказа из правила скидки Shopify
        if (d.minSubtotal && total < d.minSubtotal) {
                return res.json({ valid: false, error: 'Минимальная сумма заказа для промокода — ' + Number(d.minSubtotal).toLocaleString('ru-RU') + ' тенге' });
        }
        if (d.minQty) {
                const qty = list.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
                if (qty && qty < d.minQty) {
                          return res.json({ valid: false, error: 'Минимум ' + d.minQty + ' товар(ов) для промокода' });
                }
        }
    // Сумма позиций, на которые распространяется скидка
    let eligible = total;
    if (!d.scope.all && list.length) {
      const pIds = d.scope.productIds.map(gidNum);
      const vIds = d.scope.variantIds.map(gidNum);
      eligible = list.reduce((sum, it) => {
        const pid = String(it.product_id || '');
        const vid = String(it.variant_id || '');
        const match = vIds.includes(vid) || pIds.includes(pid);
        return match ? sum + (Number(it.line_total) || 0) : sum;
      }, 0);
    }
    if (!d.scope.all && eligible <= 0) {
      return res.json({ valid: false, error: 'Промокод действует только на определённые товары' });
    }
   let newTotal = total, summary = 'Промокод применён', currency = 'KZT';
    if (d.type === 'percentage') {
      const discountAmt = Math.round(eligible * d.percentage);   // 0.1 — уже доля, без /100
      newTotal = Math.max(0, total - discountAmt);
      summary = 'Скидка ' + Math.round(d.percentage * 100) + '%'; // *100 только для текста
    } else if (d.type === 'amount') {
      currency = d.currency;
      newTotal = Math.max(0, total - Math.min(d.amount, eligible));
      summary = 'Скидка ' + d.amount + ' ' + currency;
    }
    res.json({ valid: true, summary, new_total: newTotal, currency });
  } catch (e) {
    console.error('Discount validate error:', e.message, e.stack);
    return res.status(500).json({ valid: false, error: 'Ошибка проверки промокода' });
  }
});

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
    // Apply the real Shopify discount code so Shopify recalculates the draft total.
    if (discount_code) { try { const __dd = await lookupDiscount(String(discount_code).trim()); if (__dd && __dd.ok)
    { draftBody.draft_order.applied_discount = (__dd.type === 'percentage') ? { title: __dd.title || String(discount_code).trim(), value_type: 'percentage', value: String((Number(__dd.percentage)||0)*100), description: String(discount_code).trim() } : { title: __dd.title || String(discount_code).trim(), value_type: 'fixed_amount', value: String(Number(__dd.amount)||0), description: String(discount_code).trim() }; } } catch (e) {} }

    const draftRes = await axios.post(
      'https://' + SHOPIFY_STORE + '/admin/api/' + API_VER + '/draft_orders.json',
      draftBody,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
    );
    const draft = draftRes.data.draft_order;
    const orderId = draft.id;
    let amount = draft.total_price;
    // Fallback: if the draft did not apply the code (total unchanged), recompute from the rule.
    if (discount_code) {
      try {
        const d = await lookupDiscount(String(discount_code).trim());
        if (d.ok) {
          const base = Number(draft.total_price) || 0;
          if (d.type === 'percentage') amount = amount;
          else if (d.type === 'amount') amount = amount;
        }
      } catch (e) { /* keep draft.total_price */ }
    }
    const result = await fpInitPayment({
      order_id: orderId,
      amount,
      currency: draft.currency || 'KZT',
      description: 'Order #' + orderId,
      customer_email: customer.email,
      customer_phone: customer.phone,
    });
    res.json({ redirect_url: result.redirect_url, order_ref: String(orderId) });
  } catch (err) {
  const data = err.response && err.response.data;
  console.error('Order create error:', err.message, data && JSON.stringify(data));
  const blob = data ? JSON.stringify(data).toLowerCase() : '';
  if (/discount|usage|limit|used|применен|использов/.test(blob)) {
    return res.status(422).json({ error: 'Промокод уже использован или достиг лимита применения', code: 'DISCOUNT_ERROR' });
  }
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
    console.log('Payment result - order:', pg_order_id, '| result:', pg_result, '| payment_id:', pg_payment_id);
    if (String(pg_result) === '1') {
      await confirmShopifyOrder(pg_order_id, pg_payment_id);
    }
    res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>ok</pg_status></response>');
  } catch (err) {
    console.error('Result webhook error:', err.message);
    res.type('xml').send('<?xml version="1.0" encoding="UTF-8"?><response><pg_status>error</pg_status></response>');
  }
});

async function sendOrderToTelegram(orderId) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.warn('Telegram not configured'); return; }
  try {
    const durl = 'https://' + SHOPIFY_STORE + '/admin/api/' + API_VER + '/draft_orders/' + orderId + '.json';
    const dres = await axios.get(durl, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } });
    const d = dres.data.draft_order;
    const addr = d.shipping_address || {};
    const items = (d.line_items || []).map(function(li){ return '\u2022 ' + li.title + ' \u00d7 ' + li.quantity + ' \u2014 ' + li.price + ' ' + (d.currency||''); }).join('\n');
    const msg =
      '\ud83d\uded2 \u041d\u043e\u0432\u044b\u0439 \u043e\u043f\u043b\u0430\u0447\u0435\u043d\u043d\u044b\u0439 \u0437\u0430\u043a\u0430\u0437' +
      '\n\n\u2116 (draft): ' + orderId +
      (d.name ? '\n\u0417\u0430\u043a\u0430\u0437: ' + d.name : '') +
      '\n\n\u0422\u043e\u0432\u0430\u0440\u044b:\n' + items +
      '\n\n\u0421\u0443\u043c\u043c\u0430: ' + d.total_price + ' ' + (d.currency||'') +
      (d.applied_discount ? '\n\u0421\u043a\u0438\u0434\u043a\u0430: ' + d.applied_discount.title + ' (' + d.applied_discount.value + ')' : '') +
      '\n\n\u041a\u043b\u0438\u0435\u043d\u0442: ' + (addr.name || '') +
      '\n\u0422\u0435\u043b\u0435\u0444\u043e\u043d: ' + (addr.phone || d.phone || '') +
      '\nEmail: ' + (d.email || '') +
      '\n\u0410\u0434\u0440\u0435\u0441: ' + (addr.address1 || '') +
      (d.note ? '\n\n\u041f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438\u0435: ' + d.note : '') +
      (d.tags ? '\n\u041c\u0435\u0442\u043e\u0434: ' + d.tags : '');
    await axios.post('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
      { chat_id: TELEGRAM_CHAT_ID, text: msg }, { timeout: 10000 });
    console.log('Telegram notification sent for order', orderId);
  } catch (e) {
    console.error('Telegram send error:', e.message, e.response && JSON.stringify(e.response.data));
  }
}

async function confirmShopifyOrder(orderId, paymentId) {
  if (!SHOPIFY_ACCESS_TOKEN) { console.warn('SHOPIFY_ACCESS_TOKEN not set'); return; }
  try {
    const url = 'https://' + SHOPIFY_STORE +
      '/admin/api/' + API_VER + '/draft_orders/' + orderId + '/complete.json?payment_pending=false';
    await axios.put(url, {}, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    });
    console.log('Draft order', orderId, 'completed (paid). FP payment:', paymentId);
    await sendOrderToTelegram(orderId);
  } catch (err) {
    console.error('Draft complete error:', err.message, err.response && JSON.stringify(err.response.data));
  }
}

app.get('/auth', (req, res) => {
  const shop = req.query.shop || 'syhtck-yp.myshopify.com';
  const scopes = 'read_discounts,write_draft_orders,read_draft_orders,read_orders,write_orders';
  const redirectUri = (process.env.SERVER_URL || 'https://freedom-pay-shopify-production-7853.up.railway.app') + '/auth/callback';
  const installUrl = 'https://' + shop + '/admin/oauth/authorize'
    + '?client_id=' + process.env.SHOPIFY_API_KEY
    + '&scope=' + encodeURIComponent(scopes)
    + '&redirect_uri=' + encodeURIComponent(redirectUri);
  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code) return res.status(400).send('No code provided');
  try {
    const tokenRes = await axios.post('https://' + (shop || 'syhtck-yp.myshopify.com') + '/admin/oauth/access_token', {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code
    });
    const token = tokenRes.data.access_token;
    res.send('<h2>Installation complete</h2><p>Access token:</p><textarea rows="3" style="width:100%" readonly>' + token + '</textarea><p>Copy this token into the SHOPIFY_ACCESS_TOKEN env var in Railway, then redeploy.</p>');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'Freedom Pay server running', merchant_id: FREEDOM_MERCHANT_ID }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));

// ===== Kompanion QR acquiring =====
const { Pool } = require('pg');
const KOMPANION_BASE_URL = process.env.KOMPANION_BASE_URL || 'https://test-partner-qr-backend.kompanion.kg/';
const KOMPANION_MERCHANT_ID = process.env.KOMPANION_MERCHANT_ID;
const KOMPANION_API_KEY = process.env.KOMPANION_API_KEY;
const KOMPANION_SECRET = process.env.KOMPANION_SECRET;
const pgPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function kpInitDb() {
  if (!pgPool) { console.warn('DATABASE_URL not set, Kompanion QR amount store disabled'); return; }
  try {
    await pgPool.query('CREATE TABLE IF NOT EXISTS kompanion_orders (txn_id TEXT PRIMARY KEY, amount BIGINT NOT NULL, status TEXT DEFAULT \'PENDING\', created_at TIMESTAMPTZ DEFAULT now())');
  } catch (e) { console.error('kpInitDb error:', e.message); }
}
kpInitDb();

function kompanionSign(txnId, amountTyiyn) {
  const base = String(KOMPANION_MERCHANT_ID) + String(txnId) + String(amountTyiyn) + String(KOMPANION_SECRET);
  return crypto.createHash('sha256').update(base).digest('hex');
}

async function kompanionCreateOrder({ order_id, amountSom, purpose, description, return_url }) {
  const txnId = String(order_id);
  const amount = Math.round(Number(amountSom) * 100);
  const body = { externalId: txnId, amount: amount, purpose: purpose || ('Oplata zakaza #' + order_id), returnUrl: return_url, sign: kompanionSign(txnId, amount) };
  if (description) body.description = description;
  if (pgPool) { try { await pgPool.query('INSERT INTO kompanion_orders (txn_id, amount) VALUES ($1,$2) ON CONFLICT (txn_id) DO UPDATE SET amount = EXCLUDED.amount', [txnId, amount]); } catch (e) { console.error('kompanion store error:', e.message); } }
  const resp = await axios.post(KOMPANION_BASE_URL + '/merchant/order', body, { headers: { 'X-Merchant-Id': KOMPANION_MERCHANT_ID, 'X-Api-Key': KOMPANION_API_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 10000 });
  return { redirect_url: resp.data.paymentUrl, txn_id: resp.data.txnId };
}

app.post('/order/create-qr', async (req, res) => {
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
        shipping_address: { name: customer.name, phone: customer.phone, address1: address || '' },
        tags: 'kompanion-qr',
      }
    };
    if (discount_code) { try { const __dd = await lookupDiscount(String(discount_code).trim()); if (__dd && __dd.ok) { draftBody.draft_order.applied_discount = (__dd.type === 'percentage') ? { title: __dd.title || String(discount_code), value_type: 'percentage', value: String((Number(__dd.percentage)||0)*100) } : { title: __dd.title || String(discount_code), value_type: 'fixed_amount', value: String(__dd.amount) }; } } catch (e) {} }
    const draftRes = await axios.post(
      'https://' + SHOPIFY_STORE + '/admin/api/' + API_VER + '/draft_orders.json',
      draftBody,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
      );
    const draft = draftRes.data.draft_order;
    const orderId = draft.id;
    const amount = draft.total_price;
    const result = await kompanionCreateOrder({
      order_id: orderId,
      amountSom: amount,
      purpose: 'Oplata zakaza #' + orderId,
      description: 'NFO order',
      return_url: 'https://' + SHOPIFY_STORE + '/pages/payment-success',
    });
    res.json({ redirect_url: result.redirect_url, order_ref: String(orderId) });
  } catch (err) {
    const data = err.response && err.response.data;
    console.error('QR order create error:', err.message, data && JSON.stringify(data));
    res.status(500).json({ error: 'Order creation failed' });
  }
});

app.post('/payment/callback', async (req, res) => {
  try {
    const { txnId, status, sign } = req.body || {};
    if (!txnId || !status) return res.status(200).json({ ok: true });
    let amountTyiyn = null;
    if (pgPool) { try { const r = await pgPool.query('SELECT amount FROM kompanion_orders WHERE txn_id = $1', [String(txnId)]); if (r.rows && r.rows[0]) amountTyiyn = r.rows[0].amount; } catch (e) { console.error('kompanion lookup error:', e.message); } }
    if (amountTyiyn === null) { console.error('Kompanion callback: unknown txnId', txnId); return res.status(200).json({ ok: true }); }
   const expected = kompanionSign(txnId, amountTyiyn);
if (String(sign) !== expected) {
  console.error('Kompanion callback: invalid signature for', txnId);
  return res.status(403).json({ error: 'invalid signature' });
}
    if (pgPool) { try { await pgPool.query('UPDATE kompanion_orders SET status = $2 WHERE txn_id = $1', [String(txnId), String(status)]); } catch (e) {} }
    if (status === 'SUCCESS') { await confirmShopifyOrder(txnId, txnId); }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Kompanion callback error:', e.message);
    return res.status(200).json({ ok: true });
  }
});
