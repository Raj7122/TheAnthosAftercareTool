-- Reverse of 0000_init_configuration.sql.
-- Drop order matters: configuration_audit FKs reference configuration(version).
DROP TABLE IF EXISTS "configuration_audit";
DROP TABLE IF EXISTS "configuration";
