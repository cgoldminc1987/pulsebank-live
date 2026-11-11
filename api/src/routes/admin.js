const express = require('express');
const router = express.Router();

function requireAdmin(req,res,next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.header('X-Admin-Token') !== token) {
    return res.status(401).json({ error: token ? 'admin token required' : 'ADMIN_TOKEN is not configured on the API service' });
  }
  next();
}
router.use(requireAdmin);

router.get('/summary', async (req,res,next) => {
  try {
    const p=req.app.locals.pool;
    const [cards,ledger,merchants,customers,refunds,kyc] = await Promise.all([
      p.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status IN ('issued','active'))::int active, COALESCE(SUM(balance_cad),0)::bigint balance_cents FROM cards"),
      p.query("SELECT COUNT(*)::int total, COALESCE(SUM(amount_cad) FILTER (WHERE type='ISSUE'),0)::bigint issued_cents, COALESCE(SUM(ABS(amount_cad)) FILTER (WHERE type='REDEEM'),0)::bigint redeemed_cents FROM ledger_entries"),
      p.query("SELECT COUNT(*)::int total FROM merchants"),
      p.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE kyc_status='verified')::int verified FROM customers"),
      p.query("SELECT COUNT(*)::int total FROM refunds"),
      p.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='verified')::int verified FROM kyc_verifications")
    ]);
    res.json({cards:cards.rows[0],ledger:ledger.rows[0],merchants:merchants.rows[0],customers:customers.rows[0],refunds:refunds.rows[0],kyc:kyc.rows[0],currency:'CAD'});
  } catch(e){next(e);}
});
router.get('/cards', async (req,res,next) => {
  try {
    const limit=Math.min(200,Math.max(1,Number(req.query.limit)||100));
    const {rows}=await req.app.locals.pool.query(
      "SELECT id,merchant_id,amount_cad,balance_cad,type,status,barcode,recipient_email,network,issued_at FROM cards ORDER BY issued_at DESC NULLS LAST LIMIT $1",[limit]);
    res.json({items:rows});
  } catch(e){next(e);}
});
router.get('/ledger', async (req,res,next) => {
  try {
    const limit=Math.min(200,Math.max(1,Number(req.query.limit)||100));
    const {rows}=await req.app.locals.pool.query(
      "SELECT id,card_id,merchant_id,type,amount_cad,balance_after,created_at FROM ledger_entries ORDER BY created_at DESC LIMIT $1",[limit]);
    res.json({items:rows});
  } catch(e){next(e);}
});
router.get('/merchants', async (req,res,next) => {
  try {
    const {rows}=await req.app.locals.pool.query(
      "SELECT m.id,m.name,m.city,m.fee_bps,m.created_at,COUNT(c.id)::int cards,COALESCE(SUM(c.balance_cad),0)::bigint balance_cents FROM merchants m LEFT JOIN cards c ON c.merchant_id=m.id GROUP BY m.id ORDER BY m.name");
    res.json({items:rows});
  } catch(e){next(e);}
});
router.get('/customers', async (req,res,next) => {
  try {
    const {rows}=await req.app.locals.pool.query(
      "SELECT email,kyc_status,kyc_provider,kyc_verified_name,kyc_verified_country,kyc_verified_at,created_at FROM customers ORDER BY created_at DESC LIMIT 200");
    res.json({items:rows});
  } catch(e){next(e);}
});
router.get('/providers', (req,res) => res.json({
  stripe: Boolean(process.env.STRIPE_SECRET_KEY),
  plaid: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
  paypal: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
  lithic: Boolean(process.env.LITHIC_API_KEY),
  square: Boolean(process.env.SQUARE_ACCESS_TOKEN),
  shopify: Boolean(process.env.SHOPIFY_ACCESS_TOKEN),
  admin: true
}));
module.exports=router;
