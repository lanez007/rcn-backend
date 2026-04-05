const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

module.exports = (app, pool) => {

  app.post('/plaid/create-link-token', async (req, res) => {
    try {
      const response = await plaidClient.linkTokenCreate({
        user: { client_user_id: req.body.userId || 'rcn-user' },
        client_name: 'RCN Group',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      });
      res.json({ link_token: response.data.link_token });
    } catch (err) {
      console.error('Plaid link token error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Failed to create link token' });
    }
  });

  app.post('/plaid/exchange-token', async (req, res) => {
    try {
      const { public_token, applicant_name } = req.body;
      const response = await plaidClient.itemPublicTokenExchange({ public_token });
      const access_token = response.data.access_token;
      await pool.query(
        'INSERT INTO plaid_tokens (applicant_name, access_token, created_at) VALUES (, , NOW())',
        [applicant_name || 'unknown', access_token]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('Plaid exchange error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Failed to exchange token' });
    }
  });

  app.post('/plaid/transactions', async (req, res) => {
    try {
      const { access_token } = req.body;
      const now = new Date();
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(now.getDate() - 90);
      const response = await plaidClient.transactionsGet({
        access_token,
        start_date: ninetyDaysAgo.toISOString().split('T')[0],
        end_date: now.toISOString().split('T')[0],
      });
      res.json({ accounts: response.data.accounts, transactions: response.data.transactions });
    } catch (err) {
      console.error('Plaid transactions error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Failed to fetch transactions' });
    }
  });

};
