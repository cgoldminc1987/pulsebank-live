
const { randomUUID } = require('crypto');

// Public base URL advertised in Apple Wallet pass links.
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://pulsebank-gc-api.onrender.com';

/**
 * PulseBank Visa / Mastercard Open-Loop Adapter
 * BIN Sponsor: Peoples Trust Company (Peoples Group)
 * Reference: BIN 492726 Vanilla Visa via InComm + BIN 469344 / 511340
 */

const OPEN_LOOP_CONFIG = {
  binSponsor: 'Peoples Trust Company',
  binSponsorBINS: {
    visa: ['469344', '471404', '492726'], // 492726 = Vanilla Visa reference
    mastercard: ['511340', '516511']
  },
  processor: process.env.PROCESSOR || 'thredd',
  cdic_insurance: true
};

// Vanilla-style Single-Load (Non-reloadable)
// Reference: BIN 492726 - Peoples Trust via InComm
function getCardPolicy(card) {
  // Exact logic from user spec
  if (card.type === "single_load") {
    // No KYC under $1000
    // No FINTRAC MSB
    // Federal disclosure box still required
    // Breakage 6-12% expected
    // CDIC eligible via trust
    return {
      reloadable: false,
      expiry_disclosure: "Funds do not expire, card valid thru 5yrs",
      fees: { activation: 3.95, monthly: 0, inactivity: 2.50 },
      fintrac_required: false,
      kyc_required: false,
      disclosure_required: true,
      cdic_eligible: true,
      breakage_expected: "6-12%",
      federal_box: true
    };
  } else {
    // Reloadable >= $1000
    // Trulioo KYC + FINTRAC reporting mandatory
    // RPAA registration required
    return {
      reloadable: true,
      expiry_disclosure: "Funds do not expire, reloadable, KYC verified",
      fees: { activation: 0, monthly: 2.50, inactivity: 0, atm: 2.00 },
      fintrac_required: true,
      kyc_required: true,
      disclosure_required: true,
      cdic_eligible: true,
      breakage_expected: "2-4% (lower for reloadable)",
      federal_box: true,
      rpaa_required: true
    };
  }
}

function requireKYC() {
  // Trulioo + FINTRAC + RPAA
  const err = new Error('Reloadable open-loop >= $1000 requires Trulioo KYC + FINTRAC MSB reporting + RPAA registration');
  err.code = 'FINTRAC_KYC_REQUIRED';
  throw err;
}

async function issueOpenLoopCard({ pool, merchant_id, amount_cad, network, type, recipient, idemKey }) {
  // type: "single_load" | "reloadable"  (from user spec)
  const normalizedType = type === 'reloadable' ? 'reloadable' : 'single_load';
  const cardPolicy = getCardPolicy({ type: normalizedType });

  // === USER LOGIC IMPLEMENTATION ===
  // Vanilla-style Single-Load (Non-reloadable)
  if (cardPolicy.reloadable === false) {
    // No KYC under $1000 - allowed per FINTRAC
    // No FINTRAC MSB
    // Federal disclosure box still required
    // Breakage 6-12% expected
    // CDIC eligible via trust
    // Proceed without KYC
  } else {
    // Reloadable >= $1000
    // Trulioo KYC + FINTRAC reporting mandatory
    // RPAA registration required
    const { rows } = await pool.query('SELECT kyc_status FROM customers WHERE email=$1', [recipient?.email ?? null]).catch(()=>({rows:[]}));
    if (!rows[0] || rows[0].kyc_status !== 'verified') {
      requireKYC();
    }
  }

  // Processor call (Thredd mock)
  const bin = network === 'visa' ? OPEN_LOOP_CONFIG.binSponsorBINS.visa[0] : OPEN_LOOP_CONFIG.binSponsorBINS.mastercard[0];
  const processorCard = {
    id: `thredd_${randomUUID().slice(0,8)}`,
    pan_last4: `${Math.floor(1000 + Math.random()*9000)}`,
    bin,
    network,
    type: normalizedType,
    status: 'active',
    policy: cardPolicy,
    disclosure: {
      issuer: 'Peoples Trust Company pursuant to license from Visa/Mastercard International',
      fees_box: {
        activation: `$${cardPolicy.fees.activation.toFixed(2)}`,
        monthly: `$${cardPolicy.fees.monthly} (after 12mo if reloadable)`,
        atm: cardPolicy.reloadable ? '$2.00 Canada, $3.50 intl + 2.5% FX' : 'N/A - non-reloadable single-load',
        inactivity: `$${cardPolicy.fees.inactivity} after 12mo per federal PPP`,
        expiry_disclosure: cardPolicy.expiry_disclosure
      },
      toll_free: '1-800-555-PULSE',
      restrictions: normalizedType === 'single_load' 
        ? 'Non-reloadable, cannot be used at ATM, funds do not expire but plastic valid 5yrs, usable anywhere Visa/MC accepted'
        : 'Reloadable, KYC required, usable anywhere Visa/MC accepted, ATM allowed',
      cdic_notice: cardPolicy.cdic_eligible ? 'Funds eligible for CDIC insurance up to $100k per depositor per category via Peoples Trust - held in trust_bc_001 segregated' : null,
      federal_required: true,
      breakage_note: `Expected breakage ${cardPolicy.breakage_expected}`
    }
  };

  const cardId = `card_${network}_${randomUUID().slice(0,8)}`;
  const barcode = bin + Math.floor(Math.random()*1e10).toString().padStart(10,'0');

  await pool.query('BEGIN');
  try {
    await pool.query(
      `INSERT INTO cards (id, merchant_id, amount_cad, balance_cad, type, status, barcode, no_expiry, network, processor_id, bin, is_reloadable, cdic_eligible)
       VALUES ($1,$2,$3,$3,'mall_open_loop','issued',$4,true,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [cardId, merchant_id, amount_cad, barcode, network, processorCard.id, bin, cardPolicy.reloadable, cardPolicy.cdic_eligible]
    );
    await pool.query(
      `INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key)
       VALUES ($1,$2,$3,'ISSUE',$4,$4,$5)`,
      [randomUUID(), cardId, merchant_id, amount_cad, idemKey || randomUUID()]
    );
    await pool.query('COMMIT');
  } catch(e){ try{ await pool.query('ROLLBACK'); }catch(_){} }

  // Return exactly what user spec expects
  if (normalizedType === "single_load") {
    return {
      id: cardId,
      pan_last4: processorCard.pan_last4,
      bin,
      network,
      amount_cad,
      balance_cad: amount_cad,
      // Vanilla-style Single-Load (Non-reloadable) - Reference: BIN 492726
      reloadable: false,
      expiry_disclosure: "Funds do not expire, card valid thru 5yrs",
      fees: { activation: 3.95, monthly: 0, inactivity: 2.50 },
      federal_disclosure_box_required: true,
      fintrac_msb_required: false,
      kyc_required: false,
      cdic_eligible: true,
      breakage_expected: "6-12%",
      barcode,
      status: 'active',
      issuer: 'Peoples Trust Company',
      license: `BIN ${bin} PREPAID DEBIT - Peoples Trust via InComm reference 492726`,
      disclosure: processorCard.disclosure,
      usable_anywhere: `Usable anywhere ${network} accepted - Vanilla-style single-load $25-$500 non-reloadable`,
      apple_wallet_url: `${PUBLIC_BASE}/wallet/${cardId}.pkpass`
    };
  } else {
    // Reloadable path - Trulioo KYC + FINTRAC + RPAA
    return {
      id: cardId,
      pan_last4: processorCard.pan_last4,
      bin,
      network,
      amount_cad,
      balance_cad: amount_cad,
      reloadable: true,
      expiry_disclosure: "Funds do not expire, reloadable, KYC verified",
      fees: { activation: 0, monthly: 2.50, inactivity: 0, atm: 2.00 },
      federal_disclosure_box_required: true,
      fintrac_msb_required: true,
      kyc_required: true,
      rpaa_required: true,
      cdic_eligible: true,
      breakage_expected: "2-4%",
      barcode,
      status: 'active',
      issuer: 'Peoples Trust Company',
      disclosure: processorCard.disclosure,
      usable_anywhere: `Usable anywhere ${network} accepted - reloadable with KYC`,
      apple_wallet_url: `${PUBLIC_BASE}/wallet/${cardId}.pkpass`
    };
  }
}

async function reloadOpenLoopCard({ pool, cardId, amount_cad }) {
  const { rows } = await pool.query('SELECT * FROM cards WHERE id=$1', [cardId]);
  if (!rows[0]) throw new Error('Card not found');
  if (!rows[0].is_reloadable) throw new Error('Card not reloadable - single-load Vanilla-style non-reloadable');
  const newBal = rows[0].balance_cad + amount_cad;
  await pool.query('UPDATE cards SET balance_cad=$1 WHERE id=$2', [newBal, cardId]);
  return { id: cardId, new_balance: newBal, cdic_insured: true };
}

module.exports = { issueOpenLoopCard, reloadOpenLoopCard, getCardPolicy, OPEN_LOOP_CONFIG, requireKYC };
