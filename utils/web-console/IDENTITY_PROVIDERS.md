# Identity providers: assessment and plan

How users of the web console and of ClickHouse sign in through an external identity provider: an LDAP directory,
Active Directory, or single sign-on with Keycloak and other OpenID Connect providers. Written 2026-11-12, for this
fork of ClickHouse 26.10.

## What the server can check

Every query reaches the server with credentials, and the server authenticates each one. The console has no session of
its own on the server: whatever identity provider is used, the server must accept what the console sends.

| Method | In this build | Notes |
|---|---|---|
| Password (SQL users, `users.xml`) | Yes | The default. |
| LDAP authenticator (`ldap_servers`, users `IDENTIFIED WITH ldap`) | Yes | The user exists in ClickHouse; the directory checks the password. |
| LDAP user directory (`user_directories.ldap`) | Yes | Users and roles come from the directory, with `role_mapping`. Works with OpenLDAP and Active Directory (`user_dn_detection`, nested groups with `LDAP_MATCHING_RULE_IN_CHAIN`). |
| Kerberos (`kerberos`, users `IDENTIFIED WITH kerberos`) | Yes | HTTP `Negotiate`. Single sign-on on domain-joined desktops; browsers need configuration. |
| X.509 certificates, SSH keys | Yes | For services and the command-line client, not for people in a browser. |
| HTTP authenticator (`http_authentication_servers`, users `IDENTIFIED WITH http`) | Yes | The server sends the user name and password (Basic) to an HTTP service, which answers yes or no. |
| JWT (`IDENTIFIED WITH jwt`) | Parsed only | The type exists, but the server does not verify tokens: token validation is a ClickHouse Cloud feature, not part of this code. |

So LDAP and Active Directory are native, and so is Kerberos. OpenID Connect (Keycloak, Microsoft Entra ID, Okta, Auth0,
Google) is not: the server cannot check its tokens.

## Ways to accept OpenID Connect sign-ins

1. **Token authenticator, through the HTTP authenticator (recommended).** A small service, like the other helpers of
   the console, that the server asks to check each sign-in. The console signs the user in with Keycloak (Authorization
   Code with PKCE), then sends the user name and the access token as the password. The service checks the token's
   signature against the provider's keys (cached), and its issuer, audience, expiry, and user name claim. Users are
   `IDENTIFIED WITH http SERVER 'sso'`.
   - Advantages: no change to the server; any OpenID Connect provider; the token is checked on every request, so a
     revoked session ends when the token expires (5 minutes by default in Keycloak).
   - Costs: the users must exist in ClickHouse, with their roles. A sync process creates them and their roles from the
     provider's groups, like `role_mapping` does for LDAP. The service is on the path of every query: run it next to
     the server, with a short timeout, and fail closed.
2. **Keycloak with LDAP federation, and the server on the same LDAP directory.** Keycloak reads its users from the
   directory that the server also uses as a user directory. The console signs in with directory passwords, not with
   SSO: one identity, but not single sign-on. Works today, without new code.
3. **Token validation in the server (C++).** The type `jwt` exists; the validation (JWKS fetching and caching, claims,
   role mapping) would have to be written and maintained against upstream. The most integrated result, and the most
   expensive one to keep.
4. **A proxy that signs users in (oauth2-proxy) and passes a header.** Not recommended: the server has no trusted-header
   authentication, so the proxy would have to hold a shared password for every user.

SAML providers (ADFS, Okta SAML) and social sign-in are reached through Keycloak, which brokers them: the console only
speaks OpenID Connect to Keycloak.

## What exists now

Identity Providers is a section of the console with two pages.

- **LDAP** (`/console/idp-ldap`): the LDAP user directories of the server (moved from the Users page), with the
  configuration of each, a sign-in test, the directory users seen since the start, and the attributes of Data Access
  Policies that the access policy worker reads from the directory.
- **SSO (Keycloak)** (`/console/idp-sso`): the settings of a Keycloak provider (URL, realm, client, scopes, the user
  name and group claims, the role prefix, default roles), kept in `idp_providers` of the console database and audited
  like the other settings. It offers:
  - **Test connection**: the discovery document, the issuer, the Authorization Code flow, PKCE with S256, the
    endpoints over HTTPS (HTTP only on localhost), the signing keys, and the roles the groups map to. A wrong realm is
    told apart from an unreachable server. The result is stored with the provider.
  - **Test sign-in**: a real sign-in in a separate window (Authorization Code, PKCE S256, `state`, `nonce`,
    `prompt=login`, the issuer of the answer per RFC 9207). The console checks the signature of the ID token and of
    the access token with the provider's keys, the issuer, the audience, the expiry, and the nonce, and shows the
    user, the groups, the roles they would get, whether a ClickHouse user of that name exists, and whether the access
    token is usable by the server (its audience). The tokens are dropped: they are not stored, shown, or recorded.

The client in Keycloak is public (no secret in the browser), with the standard flow only, PKCE S256, the redirect URI
`<console origin>/console/oidc-callback`, the console's origin as a web origin, a Group Membership mapper without the
full path, and an Audience mapper that adds the client to the access token.

Checks: `sso_e2e.mjs`, run by `run_e2e.sh` with a Keycloak and a token authenticator of its own.

## Signing in with Keycloak

Option 1 is in place:

- **Token authenticator** (`sso_authenticator.mjs`, the `sso-authenticator` command of the tools image): the HTTP
  authentication server `sso`. It checks the signature of the access token with the provider's keys (cached, fetched
  again for an unknown key ID at most every 30 seconds; RS256, PS256, ES256 only), the issuer, the type (an access
  token, not an ID token), the client it was issued to (`azp`), the audience, the expiry with 30 seconds of skew, and
  that the user name claim is the user name. Whatever it cannot check is refused.
- **User sync** (optional, in the same process): with a confidential client of the provider that can read users and
  groups, it creates `IDENTIFIED WITH http SERVER 'sso'` users for the members of the groups `clickhouse-<role>`, grants
  and revokes their roles, and drops the users who left or were disabled. It changes only the users identified with
  this server, refuses an empty result while such users exist, and records each change in the audit log.
- **Sign in with Keycloak** on the console's sign-in page, from `web_console.sso_*` in the server configuration (served
  in `/console/config.json`, which the page reads before anyone is signed in). The access token is the password of the
  session, kept in memory only and refreshed at 70% of its lifespan; the native panels receive each new token
  (`console-credentials` messages, from the console to its own frames). A refused refresh signs the console out.
  Signing out also ends the session with the provider (`end_session_endpoint`).

Remaining limits:

- The SQL Console (`/ui`), the Web Terminal, and ClickStack keep the token they started with: reload them after it
  expires. Their embedding has no way to receive new credentials.
- Revocation takes up to the lifespan of an access token (5 minutes by default), as for any bearer token.
- Users must exist in ClickHouse before they sign in: the sync creates them, or an administrator does.

## Next steps

1. **Other OpenID Connect providers**: the checks and the sign-in are generic OpenID Connect; only the issuer of the
   SSO page is built from a Keycloak URL and realm, and the sync uses Keycloak's admin API. A provider kind `oidc` with
   an issuer URL covers Entra ID, Okta, and Auth0 for sign-in; their user sync would read Microsoft Graph or SCIM.
2. **The SQL Console and the Web Terminal**: a way to pass refreshed credentials into them.
3. **Token validation in the server** (option 3), if the authenticator on the path of every query becomes a concern.

## Development lab

`tmp/console-dev/keycloak/keycloak.sh` (not in the repository) runs `quay.io/keycloak/keycloak:26.7` for the
development server: the realm `clickhouse` with the client `clickhouse-console`, the groups `clickhouse-developer` and
`clickhouse-dba`, and the users `kara`, `omar`, and `pia`. See `tmp/console-dev/RUNBOOK.md`, "Keycloak (SSO)".
