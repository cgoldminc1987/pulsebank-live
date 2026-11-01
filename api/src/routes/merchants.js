
const express = require('express');
const router = express.Router();

router.get('/:id/settlement', async (req,res) => {
  const { id } = req.params;
  const { period } = req.query; // YYYY-MM-DD
  const pool = req.app.locals.pool;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type='REDEEM' THEN -amount_cad ELSE 0 END),0) as gross_redeemed,
            COUNT(*) as tx_count
     FROM ledger_entries WHERE merchant_id=$1 AND created_at::date = COALESCE($2::date, CURRENT_DATE - INTERVAL '1 day')`,
    [id, period || null]
  );
  // amount_cad is stored in cents, the report is in dollars
  const grossCents = rows[0].gross_redeemed || 0;
  const { rows: m } = await pool.query('SELECT fee_bps FROM merchants WHERE id=$1', [id]);
  const feeBps = m[0]?.fee_bps || 700;
  const feesCents = Math.floor(grossCents * feeBps / 10000);
  const netCents = grossCents - feesCents;
  res.json({ merchant_id: id, period: period || 'yesterday',
    gross_redeemed_cad: grossCents / 100, fee_bps: feeBps,
    fees_cad: feesCents / 100, net_payout_cad: netCents / 100,
    payout_status: 'pending_daily_eft', trust_reconciliation: 'required' });
});

module.exports = router;
