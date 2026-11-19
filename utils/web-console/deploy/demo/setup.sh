#!/usr/bin/env bash
# Adds the demo identity services to an installed web console (deploy/README.md, steps 1 to 10): Keycloak for single
# sign-on, an OpenLDAP directory for directory sign-in and user attributes, phpLDAPadmin to manage the directory, demo
# users, groups, roles, and data, and a disk for backups. See demo/README.md.
#
#   cd deploy && sudo demo/setup.sh --public <address>   # HTTPS on the public IP address or DNS name of the host
#   cd deploy && sudo demo/setup.sh --local              # on 127.0.0.1 of the host, through an SSH tunnel
#
# --public: Caddy serves the console on https://<address>/console, Keycloak on https://<address>:8443, and phpLDAPadmin
# on https://<address>:8444, with a Let's Encrypt certificate (ports 80, 443, 8443, and 8444 must be reachable), and the
# plain HTTP and native ports of ClickHouse move to 127.0.0.1 (CONSOLE_BIND).
# --local: the console on http://localhost:8123, Keycloak on http://localhost:8180, phpLDAPadmin on http://localhost:8380
# of the computer with the tunnel.
#
# It can run again, without an option to keep the way chosen before: the passwords, the certificates, the data, and the
# changes made in Keycloak and in the directory are kept; the demo users get their passwords again.
set -euo pipefail

cd "$(dirname "$0")/.."
DEMO=demo
STATE=$DEMO/state
BASE_DN=dc=acme,dc=example

die() { echo "setup.sh: $*" >&2; exit 1; }
[ -f .env ] || die "run it in the deploy directory of an installed console (no .env)"
previous=$(grep '^DEMO_PUBLIC_HOST=' .env | cut -d= -f2- || true)
case "${1:-}" in
    --public) [ -n "${2:-}" ] || die "--public needs the public IP address or DNS name of this host"; PUBLIC_HOST=$2 ;;
    --local) PUBLIC_HOST= ;;
    '') PUBLIC_HOST=$previous ;;
    *) die "usage: demo/setup.sh [--public <address> | --local]" ;;
esac
if [ -n "$PUBLIC_HOST" ]; then
    CONSOLE_URL=https://$PUBLIC_HOST
    KEYCLOAK_URL=https://$PUBLIC_HOST:8443
    LDAPADMIN_URL=https://$PUBLIC_HOST:8444
else
    # The port of the console on the computer with the tunnel: the redirect URI of the Keycloak client.
    CONSOLE_URL=http://localhost:${DEMO_CONSOLE_PORT:-8123}
    KEYCLOAK_URL=http://localhost:8180
    LDAPADMIN_URL=http://localhost:8380
fi
pw() { grep "^$1=" .env | cut -d= -f2-; }
set_env() {
    if grep -q "^$1=" .env; then
        local escaped
        escaped=$(printf '%s' "$2" | sed 's/[&|\\]/\\&/g')
        sed -i "s|^$1=.*|$1=$escaped|" .env
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
}

[ "$(id -u)" = 0 ] || die "run it as root: it sets the owners of the files the containers read"
command -v openssl > /dev/null || die "openssl is needed"
docker compose version > /dev/null || die "Docker Compose v2 is needed"

mkdir -p "$STATE"/keycloak "$STATE"/ldap-tls "$STATE"/ldap-ldif sso ldap
chmod 700 "$STATE"
[ -f "$STATE/env.before-demo" ] || cp -p .env "$STATE/env.before-demo"

# --- Passwords: made once, kept in demo/state/secrets.env.

if [ ! -f "$STATE/secrets.env" ]; then
    (
        umask 077
        for name in KEYCLOAK_ADMIN LDAP_ADMIN LDAP_READER SSO_SYNC_SECRET SSO_SYNC_PASSWORD; do
            echo "$name=$(openssl rand -hex 16)"
        done
        # The demo users: shorter, to type in a demo.
        for name in ALICE BOB CAROL PIA DANA ELI FAY; do
            echo "$name=Demo-$(openssl rand -hex 5)"
        done
    ) > "$STATE/secrets.env"
fi
chmod 600 "$STATE/secrets.env"
# shellcheck disable=SC1091
. "$STATE/secrets.env"

# --- The certificate authority of the directory, and the certificate of openldap.

if [ ! -f "$STATE/ldap-tls/ldap.crt" ]; then
    (
        cd "$STATE/ldap-tls"
        openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 825 -subj "/CN=Acme demo LDAP CA" 2> /dev/null
        openssl req -newkey rsa:2048 -nodes -keyout ldap.key -out ldap.csr -subj "/CN=openldap" 2> /dev/null
        printf 'subjectAltName=DNS:openldap,DNS:localhost\n' > san.ext
        openssl x509 -req -in ldap.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ldap.crt -days 825 -extfile san.ext 2> /dev/null
        rm -f ldap.csr san.ext
    )
fi
chmod 755 "$STATE/ldap-tls"
chmod 600 "$STATE/ldap-tls/ca.key"
chmod 644 "$STATE/ldap-tls/ca.crt" "$STATE/ldap-tls/ldap.crt"
# The OpenLDAP image runs as the user 1001.
chown 1001 "$STATE/ldap-tls/ldap.key" && chmod 600 "$STATE/ldap-tls/ldap.key"

# --- The tree of the directory, loaded once into an empty volume. The passwords are set after the start.
# Users: dana (finance, London) and fay (sales, Berlin) in clickhouse-analysts, eli (engineering, Paris) in
# clickhouse-engineers. groupOfNames needs a member, so each group also lists the administrator.

cat > "$STATE/ldap-ldif/tree.ldif" <<EOF
dn: $BASE_DN
objectClass: dcObject
objectClass: organization
dc: acme
o: Acme Corporation

dn: ou=users,$BASE_DN
objectClass: organizationalUnit
ou: users

dn: ou=groups,$BASE_DN
objectClass: organizationalUnit
ou: groups

dn: ou=services,$BASE_DN
objectClass: organizationalUnit
ou: services

dn: cn=attribute-reader,ou=services,$BASE_DN
objectClass: organizationalRole
objectClass: simpleSecurityObject
cn: attribute-reader
description: Read-only account of the access policy worker
userPassword: {CRYPT}x

dn: uid=dana,ou=users,$BASE_DN
objectClass: inetOrgPerson
uid: dana
cn: Dana Fischer
givenName: Dana
sn: Fischer
mail: dana@acme.example
title: Financial analyst
departmentNumber: finance
l: london

dn: uid=eli,ou=users,$BASE_DN
objectClass: inetOrgPerson
uid: eli
cn: Eli Moreau
givenName: Eli
sn: Moreau
mail: eli@acme.example
title: Data engineer
departmentNumber: engineering
l: paris

dn: uid=fay,ou=users,$BASE_DN
objectClass: inetOrgPerson
uid: fay
cn: Fay Wagner
givenName: Fay
sn: Wagner
mail: fay@acme.example
title: Sales analyst
departmentNumber: sales
l: berlin

# The people who sign in with Keycloak are in the directory as well, as in an HR system: the source of their attributes.
# They have no directory password, and are in no group of the directory.
dn: uid=alice,ou=users,$BASE_DN
objectClass: inetOrgPerson
uid: alice
cn: Alice Martin
givenName: Alice
sn: Martin
mail: alice@acme.example
title: Business analyst
departmentNumber: finance
l: london

dn: uid=bob,ou=users,$BASE_DN
objectClass: inetOrgPerson
uid: bob
cn: Bob Schmidt
givenName: Bob
sn: Schmidt
mail: bob@acme.example
title: Platform engineer
departmentNumber: engineering
l: berlin

dn: uid=carol,ou=users,$BASE_DN
objectClass: inetOrgPerson
uid: carol
cn: Carol Nguyen
givenName: Carol
sn: Nguyen
mail: carol@acme.example
title: Internal auditor
departmentNumber: hr
l: new_york

dn: cn=clickhouse-analysts,ou=groups,$BASE_DN
objectClass: groupOfNames
cn: clickhouse-analysts
description: Gives the ClickHouse role analysts
member: cn=admin,$BASE_DN
member: uid=dana,ou=users,$BASE_DN
member: uid=fay,ou=users,$BASE_DN

dn: cn=clickhouse-engineers,ou=groups,$BASE_DN
objectClass: groupOfNames
cn: clickhouse-engineers
description: Gives the ClickHouse role engineers
member: cn=admin,$BASE_DN
member: uid=eli,ou=users,$BASE_DN

dn: cn=clickhouse-auditors,ou=groups,$BASE_DN
objectClass: groupOfNames
cn: clickhouse-auditors
description: Gives the ClickHouse role auditors
member: cn=admin,$BASE_DN
EOF
chmod 755 "$STATE/ldap-ldif" && chmod 644 "$STATE/ldap-ldif/tree.ldif"

# --- The realm of Keycloak, imported once: the public client of the console (standard flow, PKCE S256), the
# confidential client of the user sync, the groups clickhouse-<role>, and the demo users.

user_json() { # username first last email password group
    local groups=''
    [ -n "$6" ] && groups=", \"groups\": [\"/$6\"]"
    printf '{"username": "%s", "enabled": true, "emailVerified": true, "firstName": "%s", "lastName": "%s", "email": "%s", "credentials": [{"type": "password", "value": "%s", "temporary": false}]%s}' \
        "$1" "$2" "$3" "$4" "$5" "$groups"
}
cat > "$STATE/keycloak/realm.json" <<EOF
{
  "realm": "acme", "displayName": "Acme Corporation", "enabled": true, "sslRequired": "external", "registrationAllowed": false,
  "bruteForceProtected": true, "accessTokenLifespan": 300,
  "groups": [{"name": "clickhouse-analysts"}, {"name": "clickhouse-engineers"}, {"name": "clickhouse-auditors"}],
  "users": [
    $(user_json alice Alice Martin alice@acme.example "$ALICE" clickhouse-analysts),
    $(user_json bob Bob Schmidt bob@acme.example "$BOB" clickhouse-engineers),
    $(user_json carol Carol Nguyen carol@acme.example "$CAROL" clickhouse-auditors),
    $(user_json pia Pia Larsen pia@acme.example "$PIA" ''),
    {"username": "service-account-clickhouse-sso-sync", "enabled": true, "serviceAccountClientId": "clickhouse-sso-sync",
     "clientRoles": {"realm-management": ["view-users", "query-groups"]}}
  ],
  "clients": [{
    "clientId": "clickhouse-console", "name": "ClickHouse web console", "enabled": true, "publicClient": true, "protocol": "openid-connect",
    "standardFlowEnabled": true, "implicitFlowEnabled": false, "directAccessGrantsEnabled": false, "serviceAccountsEnabled": false,
    "redirectUris": ["$CONSOLE_URL/console/oidc-callback"],
    "webOrigins": ["+"],
    "attributes": {"pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "$CONSOLE_URL/console/login"},
    "protocolMappers": [
      {"name": "groups", "protocol": "openid-connect", "protocolMapper": "oidc-group-membership-mapper",
       "config": {"claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true"}},
      {"name": "audience", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
       "config": {"included.client.audience": "clickhouse-console", "id.token.claim": "false", "access.token.claim": "true"}}]
  }, {
    "clientId": "clickhouse-sso-sync", "name": "ClickHouse user sync", "enabled": true, "publicClient": false, "secret": "$SSO_SYNC_SECRET",
    "serviceAccountsEnabled": true, "standardFlowEnabled": false, "implicitFlowEnabled": false, "directAccessGrantsEnabled": false,
    "protocol": "openid-connect"
  }]
}
EOF
# The Keycloak image runs as the user 1000; the file holds the passwords of the demo users.
chown 1000 "$STATE/keycloak" "$STATE/keycloak/realm.json" && chmod 700 "$STATE/keycloak" && chmod 600 "$STATE/keycloak/realm.json"

# --- Files of the helpers (user 1000): the secret of the user sync, and the account and CA of the directory.

printf '%s\n' "$SSO_SYNC_SECRET" > sso/sync-secret
printf '%s\n' "$LDAP_READER" > ldap/password
cp "$STATE/ldap-tls/ca.crt" ldap/ca.crt
chown 1000 sso sso/sync-secret ldap ldap/password ldap/ca.crt
chmod 700 sso ldap && chmod 600 sso/sync-secret ldap/password && chmod 644 ldap/ca.crt

# --- .env: single sign-on, the attributes from the directory, the demo services, and every Compose file.

files=compose.yaml
[ -n "$(pw DOCKER_GID)" ] && files=$files:compose.cluster-agent.yaml
files=$files:compose.sso.yaml:compose.ldap-attributes.yaml:$DEMO/compose.demo.yaml
if [ -n "$PUBLIC_HOST" ]; then
    files=$files:$DEMO/compose.demo-public.yaml
    # Only Caddy is public: the plain HTTP and native ports of ClickHouse are for this host (and SSH tunnels).
    set_env CONSOLE_BIND 127.0.0.1
else
    files=$files:$DEMO/compose.demo-local.yaml
fi
set_env COMPOSE_FILE "$files"
set_env DEMO_PUBLIC_HOST "$PUBLIC_HOST"
set_env DEMO_KEYCLOAK_URL "$KEYCLOAK_URL"
set_env SSO_NAME Keycloak
set_env SSO_ISSUER "$KEYCLOAK_URL/realms/acme"
set_env SSO_CLIENT_ID clickhouse-console
set_env SSO_SYNC_CLIENT_ID clickhouse-sso-sync
set_env SSO_SYNC_PASSWORD "$SSO_SYNC_PASSWORD"
set_env SSO_ROLE_PREFIX clickhouse-
set_env SSO_DEFAULT_ROLES console_admin_reader
set_env LDAP_ATTRIBUTES_URL ldaps://openldap:1636
set_env LDAP_ATTRIBUTES_STARTTLS 0
set_env LDAP_ATTRIBUTES_BIND_DN "cn=attribute-reader,ou=services,$BASE_DN"
set_env LDAP_ATTRIBUTES_BASE_DN "ou=users,$BASE_DN"
set_env LDAP_ATTRIBUTES_USER uid
set_env LDAP_ATTRIBUTES_MAP department=departmentNumber,branch=l
set_env DEMO_KEYCLOAK_ADMIN_PASSWORD "$KEYCLOAK_ADMIN"
set_env DEMO_LDAP_ADMIN_PASSWORD "$LDAP_ADMIN"

# --- Caddy (--public): HTTPS for the console, Keycloak, and phpLDAPadmin. Let's Encrypt issues certificates for IP
# addresses only with its short-lived profile (about 6 days, renewed by Caddy), and clients send no server name (SNI)
# for an IP address, hence default_sni.

if [ -n "$PUBLIC_HOST" ]; then
    if [[ "$PUBLIC_HOST" =~ ^[0-9.]+$ || "$PUBLIC_HOST" == *:* ]]; then
        global="default_sni $PUBLIC_HOST"
        tls='tls {
		issuer acme {
			profile shortlived
		}
	}'
    else
        global='' tls=''
    fi
    cat > "$STATE/Caddyfile" <<END_OF_CADDYFILE
{
	$global
}

(certificate) {
	$tls
}

# The console and the HTTP interface of ClickHouse; the address alone opens the console.
https://$PUBLIC_HOST {
	import certificate
	@home {
		method GET
		path /
		expression {query} == ""
	}
	redir @home /console 302
	reverse_proxy clickhouse:8123 {
		flush_interval -1
	}
}

https://$PUBLIC_HOST:8443 {
	import certificate
	reverse_proxy keycloak:8180
}

https://$PUBLIC_HOST:8444 {
	import certificate
	reverse_proxy phpldapadmin:80
}
END_OF_CADDYFILE
    chmod 644 "$STATE/Caddyfile"
fi

admin_sql() {
    docker compose exec -T clickhouse clickhouse-client --password "$(pw CLICKHOUSE_ADMIN_PASSWORD)" "$@"
}
docker compose up -d --wait clickhouse > /dev/null 2>&1 || die "the server does not start: see docker compose logs clickhouse"
[ "$(admin_sql -q "SELECT count() FROM system.roles WHERE name = 'console_admin_reader'" 2> /dev/null)" = 1 ] \
    || die "the server is not running, or Component Access is not set up (README.md, step 6)"


# --- Data, roles, and the account of the user sync, before the services that use them start.

echo "Creating the demo data, the roles, and the account sso_sync"
admin_sql --param_sso_pw="$SSO_SYNC_PASSWORD" --multiquery < "$DEMO/config/demo.sql"
# The role of the backup worker (README.md, step 7) backs up the demo databases too, for schedules of Backup & Restore.
if [ "$(admin_sql -q "SELECT count() FROM system.roles WHERE name = 'backup_admin'")" = 1 ]; then
    admin_sql -q "GRANT BACKUP, SELECT, SHOW ON sales.* TO backup_admin" && admin_sql -q "GRANT BACKUP, SELECT, SHOW ON hr.* TO backup_admin"
fi

echo "Starting the services (Keycloak takes about a minute)"
docker compose up -d --wait --remove-orphans

# --- The client of the console in Keycloak: the addresses of the console, also when the realm existed already.

kc() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@" --config /tmp/kcadm.config; }
kc config credentials --server http://localhost:8180 --realm master --user admin --password "$KEYCLOAK_ADMIN" > /dev/null
client=$(kc get clients -r acme -q clientId=clickhouse-console --fields id --format csv --noquotes | tr -d '\r')
printf '{"redirectUris": ["%s/console/oidc-callback"], "webOrigins": ["+"], "attributes": {"post.logout.redirect.uris": "%s/console/login"}}' \
    "$CONSOLE_URL" "$CONSOLE_URL" | kc update "clients/$client" -r acme --merge -f -

# --- Passwords of the directory: the reader account and the demo users.

ldap_admin() { docker compose exec -T openldap "$@" -x -H ldap://localhost:1389 -D "cn=admin,$BASE_DN" -w "$LDAP_ADMIN"; }
ldap_admin ldappasswd -s "$LDAP_READER" "cn=attribute-reader,ou=services,$BASE_DN"
ldap_admin ldappasswd -s "$DANA" "uid=dana,ou=users,$BASE_DN"
ldap_admin ldappasswd -s "$ELI" "uid=eli,ou=users,$BASE_DN"
ldap_admin ldappasswd -s "$FAY" "uid=fay,ou=users,$BASE_DN"
# The access policy worker started before the reader had its password: start its next cycle now.
docker compose restart access-policy-worker > /dev/null 2>&1

echo "Checking single sign-on"
docker compose run --rm --no-deps sso-authenticator sso-authenticator --check-config

if [ -n "$PUBLIC_HOST" ]; then
    access="Open the addresses below in a browser, from anywhere."
else
    access="Tunnel from your computer, then open the addresses below:
  ssh -L ${CONSOLE_URL##*:}:$(pw CONSOLE_BIND):$(pw CONSOLE_HTTP_PORT) -L 8180:127.0.0.1:8180 -L 8380:127.0.0.1:8380 <user>@<this host>"
fi
cat > "$STATE/CREDENTIALS.txt" <<EOF
Web console demo: credentials (keep this file private; demo/state/secrets.env has the same values)

$access

Web console        $CONSOLE_URL/console
  administrator    default / (CLICKHOUSE_ADMIN_PASSWORD in .env)

Keycloak           $KEYCLOAK_URL/admin/master/console/#/acme
  administrator    admin / $KEYCLOAK_ADMIN
  realm acme, single sign-on ("Sign in with Keycloak" on the console)
    alice / $ALICE    group clickhouse-analysts  -> role analysts
    bob   / $BOB    group clickhouse-engineers -> role engineers
    carol / $CAROL    group clickhouse-auditors  -> role auditors
    pia   / $PIA    no group: refused by the console

phpLDAPadmin       $LDAPADMIN_URL
  administrator    cn=admin,$BASE_DN / $LDAP_ADMIN
  directory sign-in (user name and password on the console)
    dana / $DANA    finance, london,   group clickhouse-analysts
    eli  / $ELI    engineering, paris, group clickhouse-engineers
    fay  / $FAY    sales, berlin,     group clickhouse-analysts
  attribute reader cn=attribute-reader,ou=services,$BASE_DN (access policy worker)
EOF
chmod 600 "$STATE/CREDENTIALS.txt"
echo
echo "Done. Credentials: $PWD/$STATE/CREDENTIALS.txt"
docker compose ps --format '{{.Name}}  {{.Status}}'
