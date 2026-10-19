export const fuel_prices = `
CREATE TABLE IF NOT EXISTS fuel_prices (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  state_key VARCHAR(80) NOT NULL DEFAULT '',
  state_name VARCHAR(120) NOT NULL DEFAULT '',
  area_key VARCHAR(80) NOT NULL DEFAULT '',
  area_name VARCHAR(120) NOT NULL DEFAULT '',
  fuel_type VARCHAR(16) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  change_amount DECIMAL(10,2) NULL,
  unit VARCHAR(8) NOT NULL,
  effective_date DATE NOT NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fuel_price_day (state_key, area_key, fuel_type, effective_date),
  KEY idx_fuel_price_area (area_key, effective_date)
)
`.trim();
