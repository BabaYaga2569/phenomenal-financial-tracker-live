const express = require('express');
const cors = require('cors');
const path = require('path');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
require('dotenv').config();
// --- Plaid error helpers (add right after your imports) ---
function logPlaidError(where, err) {
  const data = err?.response?.data || err;
  console.error(`[PLAID ${where}]`, JSON.stringify(data, null, 2));
}

function mapPlaidErrorToHttp(err) {
  const code = err?.response?.data?.error_code;
  if (code === 'PRODUCT_NOT_READY') return { status: 202, body: { pending: true } };
  if (code === 'ITEM_LOGIN_REQUIRED') return { status: 409, body: { relink: true, reason: code } };
  if (code === 'INVALID_ACCESS_TOKEN') return { status: 401, body: { error: code } };
  return { status: 500, body: { error: err?.response?.data || err?.message || 'unknown error' } };
}
// --- end helpers ---

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static('public'));

// Plaid Configuration - PRODUCTION
const configuration = new Configuration({
  basePath: PlaidEnvironments.development,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const client = new PlaidApi(configuration);
let accessTokens = new Map();

// Serve your app at the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    environment: 'PRODUCTION',
    timestamp: new Date().toISOString()
  });
});

// Create link token for Plaid Link
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
  } catch (error) {
    console.error('Error creating link token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Exchange public token for access token
app.post('/api/set_access_token', async (req, res) => {
  try {
    const { public_token, user_id } = req.body;
    const response = await client.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;
    accessTokens.set(user_id, { accessToken, itemId });
    res.json({ access_token: accessToken, item_id: itemId, success: true });
  } catch (error) {
    console.error('Error exchanging token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get accounts
app.post('/api/accounts', async (req, res) => {
  try {
    const { user_id } = req.body;
    const tokenData = accessTokens.get(user_id);
    if (!tokenData) return res.status(400).json({ error: 'No access token found' });
    const response = await client.accountsGet({ access_token: tokenData.accessToken });
    res.json(response.data);
  } catch (error) {
    console.error('Error getting accounts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get transactions
app.post('/api/transactions', async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.body;
    const tokenData = accessTokens.get(user_id);
    if (!tokenData) return res.status(400).json({ error: 'No access token found' });

    const request = {
      access_token: tokenData.accessToken,
      start_date: start_date || '2024-01-01',
      end_date: end_date || new Date().toISOString().split('T')[0],
      // IMPORTANT: pagination options belong under `options`
      options: {
        count: 500,
        offset: 0,
      },
    };

    const response = await client.transactionsGet(request);
    res.json(response.data);
  } catch (error) {
    console.error('Error getting transactions:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});


// Start server
app.listen(PORT, () => {
  console.log(`🚀 Phenomenal Financial Tracker Backend running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🏠 App: http://localhost:${PORT}`);
  console.log(`🏦 Environment: PRODUCTION`);

});


