-- ============================================================================
-- Property Platform - Initial Schema
-- Engine: InnoDB (row-level locking + FK support, required for concurrency)
-- Charset: utf8mb4 (full unicode incl. emoji, matches modern app defaults)
-- ============================================================================

CREATE TABLE IF NOT EXISTS properties (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  wp_post_id    BIGINT UNSIGNED NULL COMMENT 'Foreign reference to WordPress post ID, if synced from CMS',
  title         VARCHAR(255) NOT NULL,
  slug          VARCHAR(255) NOT NULL,
  status        ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'published',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_properties_slug (slug),
  KEY idx_properties_wp_post_id (wp_post_id),
  KEY idx_properties_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS enquiries (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  property_id     BIGINT UNSIGNED NOT NULL,
  full_name       VARCHAR(120) NOT NULL,
  email           VARCHAR(254) NOT NULL,
  phone           VARCHAR(20) NULL,
  message         TEXT NOT NULL,
  source          ENUM('website', 'mobile_app', 'partner_portal', 'other') NOT NULL DEFAULT 'website',
  status          ENUM('new', 'contacted', 'converted', 'closed') NOT NULL DEFAULT 'new',

  -- Duplicate detection: sha256 of normalized (email + phone + property + message).
  -- A UNIQUE index here means MySQL itself rejects a duplicate INSERT
  -- atomically -- no separate SELECT-then-INSERT race condition possible,
  -- which matters under concurrent/high-volume traffic (see PERFORMANCE.md).
  fingerprint     CHAR(64) NOT NULL,

  crm_record_id   VARCHAR(100) NULL COMMENT 'Populated once CRM sync completes',
  crm_synced_at   DATETIME NULL,

  ip_address      VARCHAR(45) NULL COMMENT 'IPv4 or IPv6, for abuse investigation',
  user_agent      VARCHAR(255) NULL,

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_enquiries_property
    FOREIGN KEY (property_id) REFERENCES properties(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,

  UNIQUE KEY uq_enquiries_fingerprint (fingerprint),

  -- Supports: GET /api/enquiries?status=X ordered by newest first (very common
  -- admin-dashboard query) without a filesort.
  KEY idx_enquiries_status_created (status, created_at DESC),

  -- Supports: "all enquiries for this property" and the FK join itself.
  KEY idx_enquiries_property (property_id),

  -- Supports: cursor-based pagination (WHERE id < :cursor ORDER BY id DESC)
  -- and lookups by email for abuse review.
  KEY idx_enquiries_email (email),
  KEY idx_enquiries_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit log of every inbound CRM webhook call, independent of
-- whether it validated/applied successfully. Essential for debugging
-- third-party integration issues and proving what an external system sent
-- (see Threat Scenario 2 - malicious payload injection via webhook).
CREATE TABLE IF NOT EXISTS crm_webhook_events (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  enquiry_id      BIGINT UNSIGNED NULL,
  event_type      VARCHAR(50) NOT NULL,
  signature_valid TINYINT(1) NOT NULL,
  raw_payload     JSON NOT NULL,
  processing_status ENUM('received', 'processed', 'failed', 'rejected') NOT NULL DEFAULT 'received',
  error_message   VARCHAR(500) NULL,
  ip_address      VARCHAR(45) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_webhook_events_enquiry
    FOREIGN KEY (enquiry_id) REFERENCES enquiries(id)
    ON DELETE SET NULL ON UPDATE CASCADE,

  KEY idx_webhook_events_status (processing_status),
  KEY idx_webhook_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed a couple of properties so the API is testable immediately after migration.
INSERT INTO properties (wp_post_id, title, slug, status) VALUES
  (101, '3BHK Sea View Apartment - Bandra', '3bhk-sea-view-apartment-bandra', 'published'),
  (102, 'Modern Studio - Koramangala', 'modern-studio-koramangala', 'published')
ON DUPLICATE KEY UPDATE title = VALUES(title);
