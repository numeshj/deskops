-- ============================================================================
--  Desk Ops — schema  (MySQL 8 / MariaDB 10.5+)
--  Phase 1, ticket T1.
--
--  Two decisions that are cheap now and expensive later:
--    1. order_ref.number is VARCHAR, never an integer. It holds both the
--       legacy 7-digit numbers (1853706) and the current 8-digit ones
--       (11043984), and leading-zero or oversized values must survive.
--    2. activity.detail is JSON. There are deliberately NO per-type subtype
--       tables — a new work type must not need a migration. Section 6 of the
--       spec (handling work that isn't on the list) depends on this.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------- reference

CREATE TABLE IF NOT EXISTS store (
  store_id       CHAR(16)     NOT NULL,
  code           VARCHAR(12)  NOT NULL,            -- canonical: FS0030
  code_display   VARCHAR(12)  NOT NULL,            -- as she writes it: Fs030
  name           VARCHAR(160) NULL,
  group_name     VARCHAR(120) NULL,                -- Morrisons Daily, MFG, ...
  status         ENUM('active','dormant','closed') NOT NULL DEFAULT 'active',
  address_line   VARCHAR(200) NULL,
  postcode       VARCHAR(16)  NULL,
  delivery_note  TEXT         NULL,                -- "goes to the main Morrisons"
  mention_count  INT          NOT NULL DEFAULT 0,  -- from the migration, drives recency
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id),
  UNIQUE KEY uq_store_code (code),
  KEY ix_store_display (code_display),
  KEY ix_store_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS store_contact (
  contact_id     CHAR(16)     NOT NULL,
  store_id       CHAR(16)     NOT NULL,
  name           VARCHAR(80)  NOT NULL,
  role           VARCHAR(40)  NULL,
  phone          VARCHAR(32)  NULL,                -- inbound call matching key
  whatsapp       VARCHAR(32)  NULL,
  email          VARCHAR(160) NULL,
  is_primary     TINYINT(1)   NOT NULL DEFAULT 0,
  mention_count  INT          NOT NULL DEFAULT 0,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (contact_id),
  KEY ix_contact_store (store_id),
  KEY ix_contact_phone (phone),
  KEY ix_contact_wa (whatsapp),
  CONSTRAINT fk_contact_store FOREIGN KEY (store_id) REFERENCES store (store_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS product (
  product_id     CHAR(16)     NOT NULL,
  brand_group    VARCHAR(80)  NULL,                -- PIXL 8000, Pringles, ...
  brand          VARCHAR(120) NULL,
  description    VARCHAR(255) NOT NULL,
  flavour        VARCHAR(80)  NULL,
  strength       VARCHAR(24)  NULL,
  form           ENUM('kit','pod','device','pouch','liquid','snack','pos','other')
                 NOT NULL DEFAULT 'other',
  shopify_code   VARCHAR(40)  NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (product_id),
  UNIQUE KEY uq_product_desc (description),
  KEY ix_product_group (brand_group)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_ref (
  order_id           CHAR(16)    NOT NULL,
  number             VARCHAR(32) NOT NULL,         -- STRING. See header note.
  number_generation  ENUM('legacy7','current8','other') NOT NULL DEFAULT 'other',
  store_id           CHAR(16)    NULL,
  placed_on          DATE        NULL,
  order_type         ENUM('normal','free_stock','refit','replacement','allocation',
                          'two_p','invoice_only','credit_cover','unknown')
                     NOT NULL DEFAULT 'unknown',
  value_pence        INT         NULL,
  created_at         DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id),
  UNIQUE KEY uq_order_number (number),
  KEY ix_order_store (store_id),
  KEY ix_order_placed (placed_on),
  CONSTRAINT fk_order_store FOREIGN KEY (store_id) REFERENCES store (store_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------- controlled vocabulary

CREATE TABLE IF NOT EXISTS work_type (
  work_type_id   VARCHAR(32)  NOT NULL,            -- call, order, issue, ...
  label          VARCHAR(60)  NOT NULL,
  colour         VARCHAR(16)  NULL,
  icon           VARCHAR(32)  NULL,
  is_system      TINYINT(1)   NOT NULL DEFAULT 1,  -- the 8 seeded types
  shared_fields  JSON         NULL,                -- ["store","order","qty"]
  custom_fields  JSON         NULL,                -- user-defined, max 6
  counter_key    VARCHAR(32)  NULL,
  is_project     TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order     INT          NOT NULL DEFAULT 0,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (work_type_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reason (
  reason_id      VARCHAR(64)  NOT NULL,            -- "call:place_order"
  work_type_id   VARCHAR(32)  NOT NULL,
  label          VARCHAR(80)  NOT NULL,
  sort_order     INT          NOT NULL DEFAULT 0,
  usage_count    INT          NOT NULL DEFAULT 0,  -- chips order by this
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_by     CHAR(16)     NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (reason_id),
  KEY ix_reason_type (work_type_id, active, usage_count DESC),
  CONSTRAINT fk_reason_type FOREIGN KEY (work_type_id) REFERENCES work_type (work_type_id)
) ENGINE=InnoDB;

-- keeps old records resolving after a merge or rename
CREATE TABLE IF NOT EXISTS reason_alias (
  alias_id       BIGINT       NOT NULL AUTO_INCREMENT,
  reason_id      VARCHAR(64)  NOT NULL,
  alias_text     VARCHAR(160) NOT NULL,
  PRIMARY KEY (alias_id),
  KEY ix_alias_reason (reason_id),
  KEY ix_alias_text (alias_text),
  CONSTRAINT fk_alias_reason FOREIGN KEY (reason_id) REFERENCES reason (reason_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------ the activity spine

CREATE TABLE IF NOT EXISTS activity (
  activity_id       CHAR(16)     NOT NULL,
  work_type_id      VARCHAR(32)  NOT NULL,
  occurred_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- never typed
  store_id          CHAR(16)     NULL,
  contact_id        CHAR(16)     NULL,
  contact_freetext  VARCHAR(120) NULL,
  reason_id         VARCHAR(64)  NULL,
  reason_freetext   VARCHAR(255) NULL,             -- only when reason = Other
  order_id          CHAR(16)     NULL,
  related_order_id  CHAR(16)     NULL,             -- the 2p / replacement order
  channel           ENUM('call_3cx','call_cloudtalk','whatsapp','email_yash',
                         'email_mfg','in_person','system','')
                    NOT NULL DEFAULT '',
  direction         ENUM('in','out','') NOT NULL DEFAULT '',
  note              TEXT         NULL,
  detail            JSON         NULL,             -- type-specific. See header note.
  status            ENUM('done','waiting_crm','needs_reply','pending')
                    NOT NULL DEFAULT 'done',
  follow_up         TINYINT(1)   NOT NULL DEFAULT 0,
  follow_up_due     DATE         NULL,
  resolved_at       DATETIME     NULL,
  is_draft          TINYINT(1)   NOT NULL DEFAULT 0,
  source_ref        VARCHAR(120) NULL,             -- phone/WhatsApp message id
  source_sheet      VARCHAR(64)  NULL,             -- migration provenance
  source_row        VARCHAR(24)  NULL,
  date_flag         ENUM('','repaired','inferred','missing') NOT NULL DEFAULT '',
  capture_seconds   DECIMAL(6,2) NULL,             -- T14. Proves the ROI. Keep it.
  created_by        CHAR(16)     NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (activity_id),
  KEY ix_act_occurred (occurred_at DESC),
  KEY ix_act_store (store_id, occurred_at DESC),
  KEY ix_act_order (order_id),
  KEY ix_act_related (related_order_id),
  KEY ix_act_type (work_type_id, occurred_at DESC),
  KEY ix_act_followup (follow_up, follow_up_due),
  KEY ix_act_draft (is_draft, occurred_at DESC),
  KEY ix_act_reason (reason_id),
  CONSTRAINT fk_act_type FOREIGN KEY (work_type_id) REFERENCES work_type (work_type_id),
  CONSTRAINT fk_act_store FOREIGN KEY (store_id) REFERENCES store (store_id),
  CONSTRAINT fk_act_contact FOREIGN KEY (contact_id) REFERENCES store_contact (contact_id),
  CONSTRAINT fk_act_reason FOREIGN KEY (reason_id) REFERENCES reason (reason_id),
  CONSTRAINT fk_act_order FOREIGN KEY (order_id) REFERENCES order_ref (order_id),
  CONSTRAINT fk_act_related FOREIGN KEY (related_order_id) REFERENCES order_ref (order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS activity_line (
  line_id      CHAR(16)     NOT NULL,
  activity_id  CHAR(16)     NOT NULL,
  direction    ENUM('returned','requested') NOT NULL,
  product_id   CHAR(16)     NULL,
  description  VARCHAR(255) NOT NULL,
  qty          INT          NULL,
  form         VARCHAR(16)  NULL,
  PRIMARY KEY (line_id),
  KEY ix_line_activity (activity_id),
  CONSTRAINT fk_line_activity FOREIGN KEY (activity_id) REFERENCES activity (activity_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS activity_attachment (
  attachment_id CHAR(16)     NOT NULL,
  activity_id   CHAR(16)     NOT NULL,
  file_key      VARCHAR(255) NOT NULL,
  mime          VARCHAR(80)  NULL,
  bytes         INT          NULL,
  caption       VARCHAR(255) NULL,
  uploaded_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (attachment_id),
  KEY ix_att_activity (activity_id),
  CONSTRAINT fk_att_activity FOREIGN KEY (activity_id) REFERENCES activity (activity_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------------ stock

-- Sparse by design: a row exists only when a SKU was UNAVAILABLE that day.
CREATE TABLE IF NOT EXISTS stock_oos (
  product_id  CHAR(16) NOT NULL,
  on_date     DATE     NOT NULL,
  noted_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  noted_by    CHAR(16) NULL,
  PRIMARY KEY (product_id, on_date),
  KEY ix_oos_date (on_date),
  CONSTRAINT fk_oos_product FOREIGN KEY (product_id) REFERENCES product (product_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------- campaigns

CREATE TABLE IF NOT EXISTS campaign (
  campaign_id  CHAR(16)     NOT NULL,
  name         VARCHAR(160) NOT NULL,
  brand        VARCHAR(80)  NULL,
  opened_on    DATE         NULL,
  closed_on    DATE         NULL,
  status       ENUM('open','closed') NOT NULL DEFAULT 'open',
  PRIMARY KEY (campaign_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS campaign_line (
  line_id            CHAR(16) NOT NULL,
  campaign_id        CHAR(16) NOT NULL,
  store_id           CHAR(16) NULL,
  product_id         CHAR(16) NULL,
  qty_requested      INT      NULL,
  qty_fulfilled      INT      NULL,
  fulfilment         ENUM('fulfilled','partial','unfulfilled','pending') NOT NULL DEFAULT 'pending',
  order_id           CHAR(16) NULL,
  uploaded_to_booker TINYINT(1) NOT NULL DEFAULT 0,
  invoice_uploaded   TINYINT(1) NOT NULL DEFAULT 0,
  occurred_on        DATE     NULL,
  contact_outcome    VARCHAR(160) NULL,
  PRIMARY KEY (line_id),
  KEY ix_cl_campaign (campaign_id),
  KEY ix_cl_store (store_id),
  CONSTRAINT fk_cl_campaign FOREIGN KEY (campaign_id) REFERENCES campaign (campaign_id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_store FOREIGN KEY (store_id) REFERENCES store (store_id),
  CONSTRAINT fk_cl_order FOREIGN KEY (order_id) REFERENCES order_ref (order_id)
) ENGINE=InnoDB;

-- ------------------------------------------------- unlisted work (section 6)

CREATE TABLE IF NOT EXISTS unlisted_cluster (
  cluster_id       CHAR(16)     NOT NULL,
  suggested_label  VARCHAR(160) NOT NULL,
  norm_text        VARCHAR(160) NOT NULL,
  work_type_id     VARCHAR(32)  NULL,
  occurrences      INT          NOT NULL DEFAULT 0,
  first_seen       DATE         NULL,
  last_seen        DATE         NULL,
  status           ENUM('new','watching','promoted','dismissed') NOT NULL DEFAULT 'watching',
  promoted_to      VARCHAR(64)  NULL,
  PRIMARY KEY (cluster_id),
  KEY ix_cluster_status (status, occurrences DESC),
  KEY ix_cluster_norm (norm_text)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS unlisted_label (
  label_id     BIGINT       NOT NULL AUTO_INCREMENT,
  raw_text     VARCHAR(255) NOT NULL,
  norm_text    VARCHAR(255) NOT NULL,
  cluster_id   CHAR(16)     NULL,
  activity_id  CHAR(16)     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (label_id),
  KEY ix_label_cluster (cluster_id),
  KEY ix_label_norm (norm_text)
) ENGINE=InnoDB;

-- ------------------------------------------------------------------- users

CREATE TABLE IF NOT EXISTS app_user (
  user_id       CHAR(16)     NOT NULL,
  email         VARCHAR(160) NOT NULL,
  display_name  VARCHAR(80)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('user','admin') NOT NULL DEFAULT 'user',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_user_email (email)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;
