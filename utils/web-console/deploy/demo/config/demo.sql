-- Demo data, roles, and the account of the SSO user sync. Run by demo/setup.sh as the administrator; every statement
-- can run again. The roles are those that the groups of Keycloak and of the directory give: the group
-- clickhouse-<role> gives <role>. Their grants are those of the role templates of Roles & Permissions.

CREATE DATABASE IF NOT EXISTS sales;
CREATE TABLE IF NOT EXISTS sales.orders
(
    order_id UInt64,
    order_date Date,
    region LowCardinality(String),
    branch LowCardinality(String),
    product LowCardinality(String),
    quantity UInt16,
    amount Decimal(12, 2),
    customer_email String
)
ENGINE = MergeTree
ORDER BY (order_date, order_id);

INSERT INTO sales.orders
SELECT
    number + 1 AS order_id,
    toDate('2026-01-01') + (number % 320) AS order_date,
    if(branch = 'new_york', 'americas', 'europe') AS region,
    ['london', 'paris', 'berlin', 'new_york'][1 + number % 4] AS branch,
    ['laptop', 'monitor', 'keyboard', 'dock', 'headset', 'tablet'][1 + intHash32(number) % 6] AS product,
    1 + intHash32(number + 1) % 9 AS quantity,
    toDecimal64(quantity * (20 + intHash32(number + 2) % 1500) + (intHash32(number + 3) % 100) / 100, 2) AS amount,
    concat('customer', toString(intHash32(number + 4) % 5000), '@example.com') AS customer_email
FROM numbers(200000)
WHERE (SELECT count() FROM sales.orders) = 0;

CREATE DATABASE IF NOT EXISTS hr;
CREATE TABLE IF NOT EXISTS hr.staff
(
    employee_id UInt32,
    name String,
    department LowCardinality(String),
    branch LowCardinality(String),
    title String,
    salary UInt32,
    email String,
    national_id String
)
ENGINE = MergeTree
ORDER BY employee_id;

INSERT INTO hr.staff
SELECT
    number + 1 AS employee_id,
    concat(['Ada', 'Ben', 'Chloe', 'Dev', 'Ema', 'Finn', 'Gia', 'Hugo', 'Iris', 'Jon'][1 + number % 10], ' ',
           ['Smith', 'Martin', 'Müller', 'Rossi', 'Novak', 'Silva', 'Kim', 'Dubois'][1 + intHash32(number) % 8]) AS name,
    ['finance', 'engineering', 'sales', 'hr'][1 + intHash32(number + 1) % 4] AS department,
    ['london', 'paris', 'berlin', 'new_york'][1 + number % 4] AS branch,
    ['Associate', 'Specialist', 'Senior specialist', 'Manager', 'Director'][1 + intHash32(number + 2) % 5] AS title,
    40000 + intHash32(number + 3) % 90000 AS salary,
    concat('employee', toString(number + 1), '@acme.example') AS email,
    concat('NI', leftPad(toString(intHash32(number + 4) % 1000000), 6, '0')) AS national_id
FROM numbers(400)
WHERE (SELECT count() FROM hr.staff) = 0;

-- Analyst template, for the databases sales and hr. Which rows of hr.staff each analyst reads is up to the rules of
-- Data Access Policies (demo/README.md).
CREATE ROLE IF NOT EXISTS analysts;
GRANT SHOW TABLES, SHOW COLUMNS, SELECT ON sales.* TO analysts;
GRANT SHOW TABLES, SHOW COLUMNS, SELECT ON hr.* TO analysts;

-- Developer template, for the database sales.
CREATE ROLE IF NOT EXISTS engineers;
GRANT SHOW, SELECT, INSERT, ALTER TABLE, ALTER VIEW, CREATE TABLE, CREATE VIEW, DROP TABLE, DROP VIEW, TRUNCATE, OPTIMIZE ON sales.* TO engineers;
GRANT CREATE TEMPORARY TABLE ON *.* TO engineers;

-- Auditor template.
CREATE ROLE IF NOT EXISTS auditors;
GRANT SHOW USERS, SHOW ROLES, SHOW SETTINGS PROFILES, SHOW QUOTAS, SHOW ROW POLICIES ON *.* TO auditors;
GRANT SELECT ON console_admin.audit_log TO auditors;
GRANT SELECT ON console_admin.component_policy TO auditors;
GRANT SELECT ON console_admin.protected_accounts TO auditors;
GRANT SELECT ON system.query_log TO auditors;
GRANT SELECT ON system.session_log TO auditors;

-- The user sync of the token authenticator (the section sso_sync of service-accounts.sql), with the roles it may give.
CREATE USER IF NOT EXISTS sso_sync IDENTIFIED WITH sha256_password BY {sso_pw:String};
ALTER USER sso_sync IDENTIFIED WITH sha256_password BY {sso_pw:String};
GRANT CREATE USER, ALTER USER, DROP USER ON *.* TO sso_sync;
GRANT SHOW USERS, SHOW ROLES ON *.* TO sso_sync;
GRANT SELECT ON system.users TO sso_sync;
GRANT SELECT ON system.roles TO sso_sync;
GRANT SELECT ON system.role_grants TO sso_sync;
GRANT INSERT ON console_admin.audit_log TO sso_sync;
GRANT analysts, engineers, auditors, console_admin_reader TO sso_sync WITH ADMIN OPTION;

-- The helpers act as the users who request their work: the access policy worker as the author of each rule, the
-- cluster agent as the user who requests a cluster operation. In the demo, that is the administrator `default`.
GRANT IMPERSONATE ON default TO access_policy_worker;
GRANT IMPERSONATE ON default TO cluster_agent;
