const uuid='CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';
export const android_app_installations=`CREATE TABLE IF NOT EXISTS android_app_installations (
 id ${uuid} NOT NULL PRIMARY KEY,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 consent_revision INT UNSIGNED NOT NULL DEFAULT 0,
 consent_granted BOOLEAN NOT NULL DEFAULT FALSE,
 consent_policy_version VARCHAR(40) NULL,
 app_id VARCHAR(80) NULL, version_name VARCHAR(40) NULL, version_code INT UNSIGNED NULL,
 first_seen_at DATETIME(3) NULL, first_seen_day DATE NULL, last_seen_at DATETIME(3) NULL,
 ever_linked BOOLEAN NOT NULL DEFAULT FALSE,
 INDEX idx_android_active (consent_granted,last_seen_at), INDEX idx_android_version (version_name)
)`;
export const android_app_installation_accounts=`CREATE TABLE IF NOT EXISTS android_app_installation_accounts (
 id ${uuid} NOT NULL PRIMARY KEY, installation_id ${uuid} NOT NULL,
 account_id ${uuid} NOT NULL, account_type ENUM('user','technician') NOT NULL,
 first_authenticated_at DATETIME(3) NOT NULL, last_authenticated_at DATETIME(3) NOT NULL,
 UNIQUE KEY uq_android_install_account (installation_id,account_type,account_id),
 INDEX idx_android_account (account_type,account_id), INDEX idx_android_authenticated (last_authenticated_at)
)`;
export const android_apk_download_sessions=`CREATE TABLE IF NOT EXISTS android_apk_download_sessions (
 id ${uuid} NOT NULL PRIMARY KEY, release_key VARCHAR(255) NOT NULL,
 accepted_at DATETIME(3) NOT NULL, INDEX idx_android_download_retention (accepted_at)
)`;
export const android_app_analytics_daily=`CREATE TABLE IF NOT EXISTS android_app_analytics_daily (
 id ${uuid} NOT NULL PRIMARY KEY, day DATE NOT NULL,
 metric ENUM('first_open','download_session','unattributed_download') NOT NULL,
 total BIGINT UNSIGNED NOT NULL DEFAULT 0, UNIQUE KEY uq_android_day_metric (day,metric)
)`;
