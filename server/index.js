require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { migrate } = require('./migrate');
const { attachUser } = require('./auth');

const ROOT = path.join(__dirname, '..');
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(attachUser);

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/companies'));
app.use('/api', require('./routes/staff'));
app.use('/api', require('./routes/assignments'));
app.use('/api', require('./routes/activity'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/reconciliation'));
app.use('/api', require('./routes/workflow'));
app.use('/api', require('./routes/employees'));
app.use('/api', require('./routes/payroll'));
app.use('/api', require('./routes/dmInvoice'));

// Everything else is the single-page app.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(ROOT, 'index.html'));
});

const PORT = process.env.PORT || 3000;

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CREST server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to run migrations, not starting server:', err);
    process.exit(1);
  });
