
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function migrate(){
  await pool.query(`
  CREATE TABLE IF NOT EXISTS merchants (id TEXT PRIMARY KEY, name TEXT, city TEXT, trust_account_id TEXT DEFAULT 'trust_bc_001', fee_bps INT DEFAULT 700, square_location_id TEXT, givex_location_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, merchant_id TEXT REFERENCES merchants(id), amount_cad INT, balance_cad INT, type TEXT CHECK (type IN ('closed_loop','mall_open_loop')), status TEXT, barcode TEXT UNIQUE, no_expiry BOOLEAN DEFAULT true, recipient_email TEXT, aggregator TEXT, external_reference TEXT, issued_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS ledger_entries (id UUID PRIMARY KEY, card_id TEXT REFERENCES cards(id), merchant_id TEXT, type TEXT CHECK (type IN ('ISSUE','REDEEM','VOID','SETTLEMENT','FLOAT_INTEREST','BREAKAGE')), amount_cad INT, balance_after INT, idempotency_key TEXT UNIQUE, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS settlements (id UUID PRIMARY KEY, merchant_id TEXT REFERENCES merchants(id), period_start DATE, period_end DATE, gross_redeemed_cad INT, fees_cad INT, net_payout_cad INT, payout_status TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS offline_queue (id UUID PRIMARY KEY, merchant_id TEXT, barcode TEXT, action TEXT, amount_cad INT, queued_at TIMESTAMPTZ DEFAULT NOW(), synced_at TIMESTAMPTZ);
  INSERT INTO merchants (id, name, city) VALUES ('mer_cumberland_coffee','Cumberland Village Coffee','Cumberland') ON CONFLICT DO NOTHING;
  INSERT INTO merchants (id, name, city) VALUES ('mer_comox_boutique','Comox Boutique Collective','Comox') ON CONFLICT DO NOTHING;
  INSERT INTO merchants (id, name, city) VALUES ('mer_courtenay_bikes','Courtenay Bike Co','Courtenay') ON CONFLICT DO NOTHING;
  `);
  // Open-loop (Visa / Mastercard) columns + customers table - needed on a fresh host
  await pool.query(`
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS network TEXT;
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS processor_id TEXT;
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS bin TEXT;
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS is_reloadable BOOLEAN DEFAULT false;
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS cdic_eligible BOOLEAN DEFAULT true;
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS kyc_status TEXT;
  CREATE TABLE IF NOT EXISTS customers (email TEXT PRIMARY KEY, kyc_status TEXT DEFAULT 'pending', kyc_provider TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  // Barcode registration: map external / distributor / printed barcodes onto PulseBank cards
  // so POS scans and balance lookups resolve without re-issuing.
  await pool.query(`
  CREATE TABLE IF NOT EXISTS barcode_aliases (
    barcode TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    merchant_id TEXT REFERENCES merchants(id),
    registered_by TEXT DEFAULT 'terminal',
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS barcode_aliases_card_idx ON barcode_aliases(card_id);
  `);
  // Refunds: return unredeemed store credit to the original payment method
  // (Stripe refund to the funding credit card, or Stripe Connect transfer for a bank-account payout)
  await pool.query(`
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS payment_rail TEXT;
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
  CREATE TABLE IF NOT EXISTS refunds (id UUID PRIMARY KEY, card_id TEXT REFERENCES cards(id), merchant_id TEXT, amount_cad INT, destination TEXT CHECK (destination IN ('credit_card','bank_account')), status TEXT CHECK (status IN ('pending','pending_payout','succeeded','failed','blocked')), processor_reference TEXT, stripe_payment_intent_id TEXT, idempotency_key TEXT UNIQUE, reason TEXT, error TEXT, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
  ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_type_check;
  ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check CHECK (type IN ('ISSUE','REDEEM','VOID','SETTLEMENT','FLOAT_INTEREST','BREAKAGE','REFUND'));
  `);
  console.log('Migrated - BC compliant tables ready');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
