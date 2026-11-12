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

Checks: `sso_e2e.mjs`, run by `run_e2e.sh` with a Keycloak of its own.

## Next steps

1. **Token authenticator** (`sso_authenticator.mjs`): the HTTP service of option 1, with the provider's keys cached
   and refreshed on an unknown key ID, a clock skew of 60 seconds, the audience of the console's client, and the user
   name claim equal to the user name. Packaged in the tools image, configured in `http_authentication_servers`.
2. **Sign in with Keycloak** on the console's sign-in page: the provider settings that the page needs before anyone is
   signed in come from `/console/config.json` (`web_console.sso_*` in the server configuration), not from the table,
   which needs a signed-in user. The access token is kept in memory only, refreshed before it expires, and the sign-out
   ends the Keycloak session (`end_session_endpoint`).
3. **User and role sync** for SSO users: create `IDENTIFIED WITH http SERVER 'sso'` users and grant the roles of their
   groups, from the Keycloak admin API with a read-only service account, removing users who left (fail closed, as the
   attribute import of Data Access Policies does).
4. **Other OpenID Connect providers**: the checks and the sign-in are generic OpenID Connect; only the issuer is built
   from a Keycloak URL and realm. A provider kind `oidc` with an issuer URL covers Entra ID, Okta, and Auth0.

## Development lab

`tmp/console-dev/keycloak/keycloak.sh` (not in the repository) runs `quay.io/keycloak/keycloak:26.7` for the
development server: the realm `clickhouse` with the client `clickhouse-console`, the groups `clickhouse-developer` and
`clickhouse-dba`, and the users `kara`, `omar`, and `pia`. See `tmp/console-dev/RUNBOOK.md`, "Keycloak (SSO)".
