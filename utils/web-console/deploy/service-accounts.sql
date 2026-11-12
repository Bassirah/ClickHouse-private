-- Service accounts of the helper processes of the web console, with the privileges the documentation lists for each.
-- Run it as an administrator after selecting Set up on the pages that create the console tables (Component Access,
-- Backup & Restore, Clusters, and the Data Access Policies tabs), with the passwords of `.env`:
--
--   clickhouse-client --user default --password ... --param_backup_pw=... --param_policy_pw=... --param_agent_pw=... --param_sso_pw=... \
--       --multiquery < service-accounts.sql
--
-- Replace the placeholders in angle brackets first; lines that contain one are commented out, so that nothing is
-- granted by guess. The console tables are in `console_admin` (the `admin_database` setting).

-- Backup worker: a role made with the Backup Administrator template (Roles & Permissions → templates), for the
-- databases of the schedules. The template lists its exact privileges before it creates the role.
CREATE USER IF NOT EXISTS backup_worker IDENTIFIED WITH sha256_password BY {backup_pw:String};
-- GRANT <role made with the Backup Administrator template> TO backup_worker;
-- Server bundles (only with BUNDLE_KEY_PROVIDER): the worker stores each encrypted bundle in a table of its own, backs it
-- up, and drops it; a restore brings it back under another name of the same prefix.
GRANT CREATE TABLE, DROP TABLE, INSERT, SELECT, BACKUP ON console_admin.server_bundle* TO backup_worker;

-- Access policy worker: acts as each rule's author, so it needs no privilege to grant anything itself.
CREATE USER IF NOT EXISTS access_policy_worker IDENTIFIED WITH sha256_password BY {policy_pw:String};
GRANT SELECT ON console_admin.* TO access_policy_worker;
GRANT INSERT ON console_admin.dap_owned TO access_policy_worker;
GRANT INSERT ON console_admin.dap_deployments TO access_policy_worker;
GRANT INSERT ON console_admin.audit_log TO access_policy_worker;
GRANT INSERT ON console_admin.dap_user_attributes TO access_policy_worker;      -- only with an attribute feed
GRANT SELECT ON system.users TO access_policy_worker;
GRANT SELECT ON system.roles TO access_policy_worker;
GRANT SELECT ON system.role_grants TO access_policy_worker;
GRANT SELECT ON system.grants TO access_policy_worker;
GRANT SELECT ON system.row_policies TO access_policy_worker;
GRANT SHOW USERS, SHOW ROLES, SHOW ROW POLICIES ON *.* TO access_policy_worker;
-- GRANT IMPERSONATE ON <each rule author> TO access_policy_worker;

-- SSO token authenticator, for its user sync only (checking tokens needs no account): creates, changes, and drops the users
-- identified with it, grants the roles of their groups, and records each change in the audit log.
CREATE USER IF NOT EXISTS sso_sync IDENTIFIED WITH sha256_password BY {sso_pw:String};
GRANT CREATE USER, ALTER USER, DROP USER ON *.* TO sso_sync;
GRANT SHOW USERS, SHOW ROLES ON *.* TO sso_sync;
GRANT SELECT ON system.users TO sso_sync;
GRANT SELECT ON system.roles TO sso_sync;
GRANT SELECT ON system.role_grants TO sso_sync;
GRANT INSERT ON console_admin.audit_log TO sso_sync;
-- The roles the groups give, with the admin option, so that it can grant only those (or ROLE ADMIN for every role):
-- GRANT <role> TO sso_sync WITH ADMIN OPTION;

-- Cluster agent: checks the capabilities of each requester with EXECUTE AS <user> CHECK GRANT.
CREATE USER IF NOT EXISTS cluster_agent IDENTIFIED WITH sha256_password BY {agent_pw:String};
GRANT SELECT, INSERT ON console_admin.clusters TO cluster_agent;
GRANT SELECT, INSERT ON console_admin.cluster_revisions TO cluster_agent;
GRANT SELECT, INSERT ON console_admin.cluster_operations TO cluster_agent;
GRANT SELECT, INSERT ON console_admin.cluster_events TO cluster_agent;
GRANT SELECT, INSERT ON console_admin.cluster_observations TO cluster_agent;
GRANT SELECT, INSERT ON console_admin.cluster_resources TO cluster_agent;
GRANT SELECT ON console_admin.cluster_capabilities TO cluster_agent;
GRANT SELECT ON console_admin.backup_destinations TO cluster_agent;
GRANT INSERT ON console_admin.audit_log TO cluster_agent;
-- GRANT IMPERSONATE ON <each user who requests cluster operations> TO cluster_agent;
