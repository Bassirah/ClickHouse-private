#!/usr/bin/env bash
# Manages the users and groups of the demo directory (demo/README.md), in the deploy directory:
#
#   demo/ldap-user.sh list
#   demo/ldap-user.sh add <uid> <first name> <last name> <department> <branch> [<group>...]   # prints the password
#   demo/ldap-user.sh passwd <uid> [<password>]                                               # a new one if omitted
#   demo/ldap-user.sh join <uid> <group>        demo/ldap-user.sh leave <uid> <group>
#   demo/ldap-user.sh set <uid> <LDAP attribute> <value>       # for example: set dana l paris
#   demo/ldap-user.sh delete <uid>
#   demo/ldap-user.sh group <name>               # a new group; clickhouse-<role> gives the ClickHouse role <role>
#
# Groups are named without their DN (clickhouse-analysts). The department and the branch are the LDAP attributes
# departmentNumber and l, which the access policy worker reads as the user attributes department and branch.
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_DN=dc=acme,dc=example
USERS=ou=users,$BASE_DN
GROUPS_DN=ou=groups,$BASE_DN
PASSWORD=$(grep '^DEMO_LDAP_ADMIN_PASSWORD=' .env | cut -d= -f2-)
[ -n "$PASSWORD" ] || { echo "ldap-user.sh: run demo/setup.sh first" >&2; exit 1; }

ldap() { local tool=$1; shift; docker compose exec -T openldap "$tool" -x -H ldap://localhost:1389 -D "cn=admin,$BASE_DN" -w "$PASSWORD" "$@"; }
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
need() { [ "$1" -ge "$2" ] || usage; }

command=${1:-}
shift || true
case "$command" in
    list)
        echo "Users:"
        ldap ldapsearch -LLL -b "$USERS" '(objectClass=inetOrgPerson)' uid cn departmentNumber l \
            | awk '/^uid:/{u=$2} /^cn:/{sub(/^cn: /,""); c=$0} /^departmentNumber:/{d=$2} /^l:/{l=$2} /^$/{if(u) printf "  %-12s %-22s %-14s %s\n", u, c, d, l; u=c=d=l=""}'
        echo "Groups:"
        ldap ldapsearch -LLL -b "$GROUPS_DN" '(objectClass=groupOfNames)' cn member \
            | awk '/^cn:/{g=$2} /^member: uid=/{split($2,a,/[=,]/); m=m" "a[2]} /^$/{if(g) printf "  %-24s%s\n", g, m; g=m=""}'
        ;;
    add)
        need $# 5
        uid=$1 first=$2 last=$3 department=$4 branch=$5
        shift 5
        ldap ldapadd > /dev/null <<EOF
dn: uid=$uid,$USERS
objectClass: inetOrgPerson
uid: $uid
cn: $first $last
givenName: $first
sn: $last
mail: $uid@acme.example
departmentNumber: $department
l: $branch
EOF
        secret="Demo-$(openssl rand -hex 5)"
        ldap ldappasswd -s "$secret" "uid=$uid,$USERS"
        for group in "$@"; do
            printf 'dn: cn=%s,%s\nchangetype: modify\nadd: member\nmember: uid=%s,%s\n' "$group" "$GROUPS_DN" "$uid" "$USERS" | ldap ldapmodify > /dev/null
        done
        echo "Added $uid, password: $secret"
        ;;
    passwd)
        need $# 1
        secret=${2:-Demo-$(openssl rand -hex 5)}
        ldap ldappasswd -s "$secret" "uid=$1,$USERS"
        echo "New password of $1: $secret"
        ;;
    join|leave)
        need $# 2
        op=add; [ "$command" = leave ] && op=delete
        printf 'dn: cn=%s,%s\nchangetype: modify\n%s: member\nmember: uid=%s,%s\n' "$2" "$GROUPS_DN" "$op" "$1" "$USERS" | ldap ldapmodify > /dev/null
        if [ "$op" = add ]; then echo "$1 joined $2"; else echo "$1 left $2"; fi
        ;;
    set)
        need $# 3
        printf 'dn: uid=%s,%s\nchangetype: modify\nreplace: %s\n%s: %s\n' "$1" "$USERS" "$2" "$2" "$3" | ldap ldapmodify > /dev/null
        echo "$1: $2 = $3"
        ;;
    delete)
        need $# 1
        for group in $(ldap ldapsearch -LLL -b "$GROUPS_DN" "(member=uid=$1,$USERS)" cn | awk '/^cn:/{print $2}'); do
            printf 'dn: cn=%s,%s\nchangetype: modify\ndelete: member\nmember: uid=%s,%s\n' "$group" "$GROUPS_DN" "$1" "$USERS" | ldap ldapmodify > /dev/null
        done
        ldap ldapdelete "uid=$1,$USERS"
        echo "Deleted $1"
        ;;
    group)
        need $# 1
        printf 'dn: cn=%s,%s\nobjectClass: groupOfNames\ncn: %s\nmember: cn=admin,%s\n' "$1" "$GROUPS_DN" "$1" "$BASE_DN" | ldap ldapadd > /dev/null
        echo "Added the group $1"
        ;;
    *)
        usage
        ;;
esac
