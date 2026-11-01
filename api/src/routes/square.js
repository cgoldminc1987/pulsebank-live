const express = require('express');
const router = express.Router();
const { squareOAuthCallback, squareRedeemHandler } = require('../adapters/square');

router.get('/oauth/callback', squareOAuthCallback);
router.post('/redeem', squareRedeemHandler);

module.exports = router;
