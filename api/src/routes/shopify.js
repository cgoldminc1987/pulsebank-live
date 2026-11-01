const express = require('express');
const router = express.Router();
const { shopifyHealth, shopifyRedeemHandler } = require('../adapters/shopify');

router.get('/health', shopifyHealth);
router.post('/redeem', shopifyRedeemHandler);

module.exports = router;
