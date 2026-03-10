-- Finance technician payout tracking migration
-- Date: 2026-03-10

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_to_technician_status VARCHAR(20) DEFAULT 'pending';

ALTER TABLE technicians
  ADD COLUMN IF NOT EXISTS upi_id VARCHAR(120);

UPDATE payments
SET payment_to_technician_status = 'pending'
WHERE payment_to_technician_status IS NULL
   OR TRIM(payment_to_technician_status) = '';

UPDATE payments
SET payment_to_technician_status = 'completed'
WHERE LOWER(TRIM(COALESCE(payment_to_technician_status, ''))) = 'completed';

UPDATE technicians
SET upi_id = JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_id'))
WHERE (upi_id IS NULL OR TRIM(upi_id) = '')
  AND payment_details IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_id')) IS NOT NULL
  AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_id'))) <> '';
