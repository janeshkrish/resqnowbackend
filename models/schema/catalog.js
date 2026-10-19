export const technician_services = `
CREATE TABLE IF NOT EXISTS technician_services (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_domain VARCHAR(100) NOT NULL,
  vehicle_type VARCHAR(32) NOT NULL DEFAULT '',
  visit_charge DECIMAL(10, 2) NULL,
  service_charge DECIMAL(10, 2) NULL,
  extra_km_charge DECIMAL(10, 2) NULL,
  labour_min DECIMAL(10, 2) NULL,
  labour_max DECIMAL(10, 2) NULL,
  delivery_charge DECIMAL(10, 2) NULL,
  price_2w_min DECIMAL(10, 2) NULL,
  price_2w_max DECIMAL(10, 2) NULL,
  price_4w_min DECIMAL(10, 2) NULL,
  price_4w_max DECIMAL(10, 2) NULL,
  base_price DECIMAL(10, 2) NULL,
  free_km DECIMAL(10, 2) NULL,
  per_km_price DECIMAL(10, 2) NULL,
  night_charge DECIMAL(10, 2) NULL,
  night_type VARCHAR(16) NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_technician_services (technician_id, service_domain, vehicle_type),
  INDEX idx_technician_services_lookup (technician_id, service_domain),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export const service_master = `
CREATE TABLE IF NOT EXISTS service_master (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    service_name VARCHAR(255) NOT NULL,
    service_slug VARCHAR(255) UNIQUE,
    description TEXT,
    icon VARCHAR(255),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
`.trim();

export const vehicle_category_master = `
CREATE TABLE IF NOT EXISTS vehicle_category_master (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    category_name VARCHAR(100),
    description TEXT,
    active BOOLEAN DEFAULT TRUE
)
`.trim();

export const vehicle_subcategory_master = `
CREATE TABLE IF NOT EXISTS vehicle_subcategory_master (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    vehicle_category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    subcategory_name VARCHAR(255),
    active BOOLEAN DEFAULT TRUE
)
`.trim();

export const service_vehicle_mapping = `
CREATE TABLE IF NOT EXISTS service_vehicle_mapping (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    service_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    vehicle_category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
)
`.trim();

export const service_pricing_field_master = `
CREATE TABLE IF NOT EXISTS service_pricing_field_master (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    service_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    field_key VARCHAR(255),
    field_label VARCHAR(255),
    field_type VARCHAR(50),
    required BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0
)
`.trim();

export const towing_fleet_master = `
CREATE TABLE IF NOT EXISTS towing_fleet_master (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    fleet_name VARCHAR(255),
    description TEXT,
    active BOOLEAN DEFAULT TRUE
)
`.trim();

export const technician_service_pricing = `
CREATE TABLE IF NOT EXISTS technician_service_pricing (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    service_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    vehicle_category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    vehicle_subcategory_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    fleet_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    pricing_json JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();
