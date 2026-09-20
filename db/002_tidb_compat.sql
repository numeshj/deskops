-- ============================================================================
--  OPTIONAL - only run this if you deploy on TiDB Cloud.
--
--  TiDB is MySQL wire-compatible and runs 001_schema.sql as-is, but its
--  FOREIGN KEY support has been through several stages and behaves differently
--  from InnoDB's. Nothing in this application depends on database-level
--  referential enforcement:
--
--    * the importer filters out rows whose references do not exist before
--      inserting (see the `storeIds.has(...)` guards in server/src/import.js)
--    * the API resolves or creates every referenced row inside the same
--      transaction as the activity that points at it
--
--  So on TiDB the constraints are redundant, and dropping them removes a whole
--  class of surprise. On MySQL or MariaDB, do NOT run this - keep the
--  constraints, they cost nothing and catch mistakes.
--
--  Applied by the migration runner:
--      MIGRATE_INCLUDE=tidb_compat node src/db/migrate.js
--  or by load-remote.bat, which sets that for you when the host is TiDB.
--
--  ---------------------------------------------------------------------------
--  Why this file looks repetitive rather than using a stored procedure:
--
--  It used to. The procedure needed DELIMITER // to define, and DELIMITER is a
--  directive of the mysql COMMAND-LINE CLIENT, not SQL - the server has never
--  heard of it. That was fine while the only documented way to apply this file
--  was piping it through `mysql`, and it failed with a bare syntax error the
--  moment the migration runner sent the statements over the wire itself. Since
--  free hosts give you no shell, the runner is the only way this gets applied
--  in practice, so the file now speaks plain SQL and nothing else.
--
--  Each constraint takes three statements: build the ALTER only if the
--  constraint is actually there, then prepare and run it. That keeps the file
--  safe to run twice, which matters because a half-finished deploy gets
--  retried.
-- ============================================================================

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'store_contact'
            AND constraint_name = 'fk_contact_store' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `store_contact` DROP FOREIGN KEY `fk_contact_store`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'order_ref'
            AND constraint_name = 'fk_order_store' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `order_ref` DROP FOREIGN KEY `fk_order_store`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'reason'
            AND constraint_name = 'fk_reason_type' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `reason` DROP FOREIGN KEY `fk_reason_type`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'reason_alias'
            AND constraint_name = 'fk_alias_reason' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `reason_alias` DROP FOREIGN KEY `fk_alias_reason`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity'
            AND constraint_name = 'fk_act_type' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity` DROP FOREIGN KEY `fk_act_type`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity'
            AND constraint_name = 'fk_act_store' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity` DROP FOREIGN KEY `fk_act_store`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity'
            AND constraint_name = 'fk_act_contact' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity` DROP FOREIGN KEY `fk_act_contact`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity'
            AND constraint_name = 'fk_act_reason' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity` DROP FOREIGN KEY `fk_act_reason`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity'
            AND constraint_name = 'fk_act_order' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity` DROP FOREIGN KEY `fk_act_order`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity'
            AND constraint_name = 'fk_act_related' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity` DROP FOREIGN KEY `fk_act_related`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity_line'
            AND constraint_name = 'fk_line_activity' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity_line` DROP FOREIGN KEY `fk_line_activity`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'activity_attachment'
            AND constraint_name = 'fk_att_activity' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `activity_attachment` DROP FOREIGN KEY `fk_att_activity`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'stock_oos'
            AND constraint_name = 'fk_oos_product' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `stock_oos` DROP FOREIGN KEY `fk_oos_product`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'campaign_line'
            AND constraint_name = 'fk_cl_campaign' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `campaign_line` DROP FOREIGN KEY `fk_cl_campaign`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'campaign_line'
            AND constraint_name = 'fk_cl_store' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `campaign_line` DROP FOREIGN KEY `fk_cl_store`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = 'campaign_line'
            AND constraint_name = 'fk_cl_order' AND constraint_type = 'FOREIGN KEY'),
  'ALTER TABLE `campaign_line` DROP FOREIGN KEY `fk_cl_order`',
  'DO 0'));
PREPARE st FROM @s;
EXECUTE st;
DEALLOCATE PREPARE st;
