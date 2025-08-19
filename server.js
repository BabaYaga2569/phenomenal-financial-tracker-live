// server.js
// Phenomenal Financial Tracker — Express + Plaid (Production)

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
require('dotenv').config();

/* ------------------------------ App setup ------------------------------ */
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve your static frontend
app.use(express.static('public'));

/* --------------------------- Helper functions -------------------------- */
function logPlaidError(where, err) {
  const data = err?.response?.data || {};
  console.error(`[Plaid ${where}]`, JSON.stringify(data, null, 2));
}

function mapPlaidErrorToHttp(err) {
  const code = err?.response?.data?.error_code;
  if (!code) {
    return { status: 500, body: { error: 'unknown error' } };
  }
  if (code === 'PRODUCT_NOT_READY') {
    return { status: 202, body: { relink: true, reason: code } };
  }
  if (code === 'ITEM_LOGIN_REQUIRED') {
    return { status: 401, body: { relink: true, reason: code } };
  }
  if (code === 'INVALID_ACCESS_TOKEN') {
    return { status: 401, body: { error: code } };
  }
  return { status: 500, body: { error: code } };
}

/* ------------------------ Plaid client (PROD) -------------------------- */
const configuration = new Configuration({
  basePath: PlaidEnvironments.production, // ← production environment
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const client = new PlaidApi(configuration);

// Simple in-memory token store keyed by user_id
const accessTokens = new Map();

/* ------------------------------- Routes -------------------------------- */

// Root (serve index.html)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    environment: 'PRODUCTION',
    timestamp: new Date().toISOString(),
  });
});

// 1) Create Link Token
app.post('/api/create_link_token', async (req, res) => {
  try {
    const request = {
      user: { client_user_id: req.body.user_id || 'user-1' },
      client_name: 'Phenomenal Financial Tracker',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    };

    const response = await client.linkTokenCreate(request);
    res.json(response.data);
  } catch (err) {
    logPlaidError('create_link_token', err);
    const { status, body } = mapPlaidErrorToHttp(err);
    res.status(status).json(body);
  }
});

// 2) Exchange public_token for access_token
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const { public_token, user_id } = req.body;
    if (!public_token) {
      return res.status(400).json({ error: 'Missing public_token' });
    }

    const response = await client.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;

    // store per-user
    accessTokens.set(user_id || 'user-1', { accessToken });

    res.json({ success: true });
  } catch (err) {
    logPlaidError('exchange_public_token', err);
    const { status, body } = mapPlaidErrorToHttp(err);
    res.status(status).json(body);
  }
});

// 3) Get accounts
app.post('/api/accounts', async (req, res) => {
  try {
    const { user_id } = req.body;
    const tokenData = accessTokens.get(user_id || 'user-1');
    if (!tokenData) {
      return res.status(400).json({ error: 'No access token found' });
    }

    const response = await client.accountsGet({
      access_token: tokenData.accessToken,
    });

    res.json(response.data);
  } catch (err) {
    logPlaidError('accounts_get', err);
    const { status, body } = mapPlaidErrorToHttp(err);
    res.status(status).json(body);
  }
});

// 4) Get transactions
app.post('/api/transactions', async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.body;
    const tokenData = accessTokens.get(user_id || 'user-1');
    if (!tokenData) {
      return res.status(400).json({ error: 'No access token found' });
    }

    const request = {
      access_token: tokenData.accessToken,
      start_date: start_date || '2024-01-01',
      end_date: end_date || new Date().toISOString().split('T')[0],
      options: {
        count: 500,
        offset: 0,
      },
    };

    const response = await client.transactionsGet(request);
    res.json(response.data);
  } catch (err) {
    logPlaidError('transactions_get', err);
    const { status, body } = mapPlaidErrorToHttp(err);
    res.status(status).json(body);
  }
});

/* ---------------------------- Start server ----------------------------- */
app.listen(PORT, () => {
  console.log(`✅ Phenomenal Financial Tracker Backend running on port ${PORT}`);
  console.log(`➡ Health check:  http://localhost:${PORT}/health`);
  console.log(`➡ App:           http://localhost:${PORT}`);
  console.log('🌎 Environment: PRODUCTION');
});
