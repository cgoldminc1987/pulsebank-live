const express = require('express');
const { z } = require('zod');
const router = express.Router();

// Barcode registration: bind an external / distributor / printed barcode to a
// PulseBank card so POS scans and balance lookups resolve without re-issuing.
const RegisterSchema = z.object({
  card_id: z.string(),
  barcode: z.string().min(4).max(64),
  merchant_id: z.string().optional(),
  note: z.string().max(200).optional()
});

router.post('/register', async (req,res) => {
  const pool = req.app.locals.pool;
  try {
    const data = RegisterSchema.parse(req.body);
    const { rows } = await pool.query('SELECT id, merchant_id, status, barcode FROM cards WHERE id=$1', [data.card_id]);
    if (!rows[0]) return res.status(404).json({ error:'card not found', card_id: data.card_id });
    const card = rows[0];
    const merchant_id = data.merchant_id || card.merchant_id;
    const { rows: dup } = await pool.query('SELECT card_id FROM barcode_aliases WHERE barcode=$1', [data.barcode]);
    if (dup[0]) {
      if (dup[0].card_id === data.card_id) {
        return res.status(200).json({ ok:true, idempotent:true, card_id:data.card_id, barcode:data.barcode, merchant_id });
      }
      return res.status(409).json({ error:'barcode already registered', barcode:data.barcode, registered_to_card:dup[0].card_id });
    }
    await pool.query(
      'INSERT INTO barcode_aliases (barcode, card_id, merchant_id, registered_by, note) VALUES ($1,$2,$3,$4,$5)',
      [data.barcode, data.card_id, merchant_id, 'terminal', data.note || null]
    );
    res.status(201).json({
      ok:true, card_id:data.card_id, barcode:data.barcode, merchant_id,
      resolves_to:{ card_id:card.id, status:card.status, card_own_barcode:card.barcode },
      balance_check_url:`${process.env.PUBLIC_BASE_URL || 'https://pulsebank-gc-api.onrender.com'}/api/v1/cards/balance/${encodeURIComponent(data.barcode)}`
    });
  } catch(e) {
    if (e.code === '23503') return res.status(404).json({ error:'card not found', detail:e.detail });
    if (e.issues) return res.status(400).json({ error:'invalid body', issues:e.issues.map(i=>i.message) });
    res.status(500).json({ error:e.message });
  }
});

// Unregister (delink) a barcode — the alias disappears, the card is untouched.
router.delete('/:barcode', async (req,res) => {
  const { rowCount } = await req.app.locals.pool.query('DELETE FROM barcode_aliases WHERE barcode=$1', [req.params.barcode]);
  if (!rowCount) return res.status(404).json({ error:'barcode not registered', barcode:req.params.barcode });
  res.json({ ok:true, unregistered:req.params.barcode });
});

module.exports = router;
