const express = require('express');
const router = express.Router();
router.get('/health', async (req,res)=>{
  const pool = req.app.locals.pool;
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch(e){}
  const redisOk = req.app.locals.redis?.isReady ?? false;
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    timestamp: new Date().toISOString(),
    host: 'own-host',
    trust_account_id: 'trust_bc_001',
    bc_compliance: true,
    bins: ['469344 Visa','511340 MC','492726 Vanilla-style'],
    services: { postgres: dbOk?'up':'down', redis: redisOk?'up':'down', processor: process.env.PROCESSOR||'thredd' },
    endpoints: ['POST /api/v1/cards/issue','POST /api/v1/cards/:id/redeem','POST /api/v1/cards/:id/void','GET /api/v1/cards/:id/balance','GET /api/v1/cards/balance/:barcode','POST /api/v1/cards/:id/wallet','POST /api/v1/square/redeem','GET /api/v1/merchants/:id/settlement','POST /api/v1/distributor/issue','POST /api/v1/refunds','GET /api/v1/refunds/:id']
  });
});
module.exports = router;
