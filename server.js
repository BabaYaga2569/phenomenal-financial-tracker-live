// server.js
// Phenomenal Financial Tracker — Express + Plaid (Production)

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
require('dotenv').config();
const { Pool } = require('pg');

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

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        access_token TEXT NOT NULL,
        institution_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

initDatabase();

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
    const { public_token, user_id, institution_name } = req.body;
    if (!public_token) {
      return res.status(400).json({ error: 'Missing public_token' });
    }

    console.log('[Plaid exchange_public_token]', { public_token, user_id, institution_name });

    const response = await client.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;

    // Store in database
    await pool.query(
      'INSERT INTO user_tokens (user_id, access_token, institution_name) VALUES ($1, $2, $3)',
      [user_id || 'user-1', accessToken, institution_name || 'Bank']
    );

    console.log('✅ Access token saved to database');
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
    const user_id = req.body.user_id || 'user-1';
    const result = await pool.query(
      'SELECT access_token, institution_name FROM user_tokens WHERE user_id = $1', 
      [user_id]
    );
    
    if (result.rows.length === 0) {
      return res.json([]); // No connected accounts
    }

    let allAccounts = [];
    
    for (const row of result.rows) {
      try {
        const response = await client.accountsGet({
          access_token: row.access_token,
        });
        allAccounts = allAccounts.concat(response.data.accounts);
      } catch (err) {
        console.error('Error getting accounts for token:', err);
        // Continue with other tokens even if one fails
      }
    }

    res.json(allAccounts);
  } catch (err) {
    logPlaidError('accounts_get', err);
    const { status, body } = mapPlaidErrorToHttp(err);
    res.status(status).json(body);
  }
});

// 4) Get transactions
app.post('/api/transactions', async (req, res) => {
  try {
    const user_id = req.body.user_id || 'user-1';
    const start_date = req.body.start_date || '2024-01-01';
    const end_date = req.body.end_date || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      'SELECT access_token FROM user_tokens WHERE user_id = $1', 
      [user_id]
    );
    
    if (result.rows.length === 0) {
      return res.json([]); // No connected accounts
    }

    let allTransactions = [];

    for (const row of result.rows) {
      try {
        const request = {
          access_token: row.access_token,
          start_date: start_date,
          end_date: end_date,
          options: {
            count: 500,
            offset: 0,
          },
        };

        const response = await client.transactionsGet(request);
        allTransactions = allTransactions.concat(response.data.transactions);
      } catch (err) {
        console.error('Error getting transactions for token:', err);
        // Continue with other tokens even if one fails
      }
    }

    res.json(allTransactions);
  } catch (err) {
    logPlaidError('transactions_get', err);
    const { status, body } = mapPlaidErrorToHttp(err);
    res.status(status).json(body);
  }
});

/* ---------------------------- Start server ----------------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Phenomenal Financial Tracker Backend running on port ${PORT}`);
  console.log(`➡ Health check:  http://localhost:${PORT}/health`);
  console.log(`➡ App:           http://localhost:${PORT}`);
  console.log('🌎 Environment: PRODUCTION');
});
