-- D05/D11: persist each offered price and retain the accepted offer on the request.
-- Run against the selected ResQNow TiDB database BEFORE deploying the new backend
-- and dispatch workers. This file has not been executed against a real database.
-- TiDB's IF NOT EXISTS makes these additive statements safe to run again:
-- https://docs.pingcap.com/tidb/stable/sql-statement-add-column/
-- Existing prices and jobs are preserved; legacy pending offers are refreshed by
-- the new dispatch flow rather than being backfilled with a guessed price.

ALTER TABLE dispatch_offers
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSON DEFAULT NULL;

-- Already present in the supplied production schema; parity for older databases.
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSON DEFAULT NULL;
