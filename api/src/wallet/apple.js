
const { PKPass } = require('passkit-generator');
const path = require('path');
const fs = require('fs');

// Public base URL advertised in pass back-fields and pass download links.
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://pulsebank-gc-api.onrender.com';

/**
 * Apple Wallet .pkpass generator for PulseBank Gift Cards
 * Generates BC-compliant pass with no expiry field, balance barcode, trust disclosure
 */

async function generateGiftCardPass({ cardId, barcode, amount_cad, balance_cad, merchantName, recipientEmail }) {
  // You need Apple Developer certs - place in ./certs
  // For Manus, store WWDR + signerCert + signerKey as env base64
  const certsPath = path.join(__dirname, '../../certs');

  try {
    const pass = await PKPass.from({
      model: path.join(__dirname, './passModels/giftCard'), // create model with pass.json + icon.png
      certificates: {
        wwdr: process.env.APPLE_WWDR_CERT || fs.readFileSync(path.join(certsPath, 'wwdr.pem')),
        signerCert: process.env.APPLE_SIGNER_CERT || fs.readFileSync(path.join(certsPath, 'signerCert.pem')),
        signerKey: process.env.APPLE_SIGNER_KEY || fs.readFileSync(path.join(certsPath, 'signerKey.pem')),
        signerKeyPassphrase: process.env.APPLE_KEY_PASSPHRASE
      }
    }, {
      serialNumber: cardId,
      description: `${merchantName} Gift Card`,
      organizationName: merchantName,
      logoText: `${merchantName} - $${(balance_cad/100).toFixed(2)}`,
      // BC Compliance: NO expirationDate field for closed-loop
      barcode: {
        message: barcode,
        format: 'PKBarcodeFormatCode128',
        messageEncoding: 'iso-8859-1',
        altText: barcode
      },
      // Store card layout
      storeCard: {
        primaryFields: [{ key:'balance', label:'BALANCE', value: `$${(balance_cad/100).toFixed(2)} CAD` }],
        secondaryFields: [{ key:'merchant', label:'MERCHANT', value: merchantName }],
        auxiliaryFields: [
          { key:'barcodeText', label:'Card #', value: barcode.slice(-4).padStart(barcode.length,'*') },
          { key:'bc', label:'BC Compliant', value:'No Expiry' }
        ],
        backFields: [
          { key:'terms', label:'Terms', value: 'No expiry date. No fees per BC Business Practices and Consumer Protection Act s.56. For mall open-loop: $1.50 activation, $2.50/mo after 15mo dormancy.' },
          { key:'trust', label:'Trust', value: 'Funds held in segregated trust account at Peoples Trust Company - Trust ID: trust_bc_001' },
          { key:'balanceCheck', label:'Check Balance', value: `${PUBLIC_BASE}/app/?card=${barcode}` }
        ]
      }
    });

    // Add icon - use generic if not present
    // pass.addBuffer('icon.png', fs.readFileSync(...))

    const buffer = pass.getAsBuffer();
    // In Manus, save to /tmp and return URL
    const outPath = `/tmp/${cardId}.pkpass`;
    fs.writeFileSync(outPath, buffer);
    return { buffer, outPath, url: `${PUBLIC_BASE}/wallet/${cardId}.pkpass` };
  } catch(e) {
    console.error('Pass generation failed - certs missing?', e.message);
    // Fallback: return JSON for manual creation
    return {
      fallback: true,
      apple_wallet_payload: {
        serialNumber: cardId,
        barcode,
        balance: balance_cad,
        description: `${merchantName} $${(balance_cad/100).toFixed(2)}`,
        backFields: 'No expiry - BC compliant',
        needs_certs: 'Add APPLE_WWDR_CERT, SIGNER_CERT, SIGNER_KEY env vars'
      }
    };
  }
}

module.exports = { generateGiftCardPass };
