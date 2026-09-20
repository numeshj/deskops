-- ---------------------------------------------------------------------------
--  Phase 2 — the rest of the work.
--
--  Almost nothing is needed here, which is the point: activity.detail is JSON
--  and the child tables were built in 001. The request workflow stage lives in
--  detail.stage rather than in the status enum, so adding a stage later is a
--  deploy, not a migration.
--
--  The one real addition is attachment bytes.
-- ---------------------------------------------------------------------------

-- Photos live IN the database, not on disk.
--
-- Free hosting gives you an ephemeral filesystem: Render wipes it on every
-- redeploy and every spin-down. A stand photo written to disk would be gone by
-- the following week, and the whole point of this feature is that the dead
-- "Pictures" column finally holds something. A few hundred KB per photo, a
-- handful a week, against a 5 GiB database allowance - it fits many times over.
ALTER TABLE activity_attachment
  ADD COLUMN data LONGBLOB NULL AFTER file_key;

-- The daily stock check asks "how many days has this SKU been out?" for every
-- SKU on the screen at once. Without this it is a full scan per product.
ALTER TABLE stock_oos
  ADD KEY ix_oos_product_date (product_id, on_date DESC);

-- Campaign lines are read store-by-store during a call round.
ALTER TABLE campaign_line
  ADD KEY ix_cl_campaign_store (campaign_id, store_id);
