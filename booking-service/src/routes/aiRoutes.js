const express = require("express");
const {
  chatWithAssistant,
  getAssistantSlotOptions,
  getAssistantSlotRecommendation,
  getDemandPrediction,
  getPaymentRisk,
  getRecommendation,
} = require("../controllers/aiController");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.get("/recommend-slot", authenticate, getRecommendation);
router.post("/assistant/chat", authenticate, chatWithAssistant);
router.get("/assistant/options", authenticate, getAssistantSlotOptions);
router.get("/assistant/recommend", authenticate, getAssistantSlotRecommendation);
router.get("/demand-prediction", authenticate, getDemandPrediction);
router.get("/payment-risk/:bookingId", authenticate, getPaymentRisk);

module.exports = router;
