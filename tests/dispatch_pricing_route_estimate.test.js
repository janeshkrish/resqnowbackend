import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTowingEstimate } from '../routes/pricing.js';

test('customer towing route calculation exposes no request-specific fare before acceptance', async () => {
  const quote = { service_type: 'car-towing', vehicle_type: 'car', tow_truck_type: 'flatbed', distance_km: 12,
    estimated_duration: 25, pickup: { lat: 11, lng: 76 }, drop: { lat: 11.1, lng: 76.1 },
    route_metadata: { provider: 'simulated', polyline: [[11, 76], [11.1, 76.1]] },
    base_amount: 1200, final_estimated_price: 1322, pricing_breakdown: { base_amount: 1200, platform_fee: 120, payment_fee: 2 } };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
  await handleTowingEstimate({ body: {} }, res, { buildQuote: async () => quote });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quote.distance_km, 12);
  assert.deepEqual(res.body.routeMetadata.polyline, [[11, 76], [11.1, 76.1]]);
  assert.equal('base_amount' in res.body.quote, false);
  assert.equal('final_estimated_price' in res.body.quote, false);
  assert.equal('pricingBreakdown' in res.body, false);
  assert.equal('finalEstimatedPrice' in res.body, false);
  assert.equal(res.body.pricing_finalized, false);
});
