
const express = require('express');
const router = express.Router();
// Unified proxy for Givex, DataCandy, Tango

router.post('/issue', async (req,res) => {
  const { aggregator, amount_cad, recipient, merchant_id } = req.body;
  let externalCard = null;
  if (aggregator === 'givex') {
    // Call Givex API - BC restaurants common
    // const g = await fetch(`https://api.givex.com/cards/issue`, { method:'POST', headers:{'Authorization':process.env.GIVEX_KEY}, body:JSON.stringify({amount: amount_cad/100})})
    externalCard = { provider: 'givex', barcode: `GIVEX-${Date.now()}`, balance: amount_cad };
  } else if (aggregator === 'datacandy') {
    externalCard = { provider: 'datacandy', barcode: `DC-${Date.now()}`, balance: amount_cad };
  } else if (aggregator === 'tango') {
    // Tango Card global catalog
    externalCard = { provider: 'tango', barcode: `TANGO-${Date.now()}`, balance: amount_cad, brand: req.body.brand || 'amazon' };
  } else {
    return res.status(400).json({error:'aggregator must be givex|datacandy|tango'});
  }
  // Normalize to PulseBank card object + create local ledger
  const pool = req.app.locals.pool;
  const id = `card_dist_${Date.now()}`;
  await pool.query(
    `INSERT INTO cards (id, merchant_id, amount_cad, balance_cad, type, status, barcode, no_expiry, aggregator) 
     VALUES ($1,$2,$3,$3,'closed_loop','issued',$4,true,$5)`,
    [id, merchant_id, amount_cad, externalCard.barcode, aggregator]
  );
  res.json({ id, ...externalCard, pulsebank_normalized: true, bc_compliant: { no_expiry:true } });
});

module.exports = router;
