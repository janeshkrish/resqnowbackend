-- Towing Phase 2: OSM route workflow and technician earning fields
-- Date: 2026-05-29

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS technician_estimated_earning DECIMAL(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS vehicle_loaded_time DATETIME NULL,
  ADD COLUMN IF NOT EXISTS drop_arrival_time DATETIME NULL;

ALTER TABLE service_requests
  MODIFY COLUMN status VARCHAR(50) DEFAULT 'pending';

