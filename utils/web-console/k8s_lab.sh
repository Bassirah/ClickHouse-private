#!/usr/bin/env bash
# Development lab for the Kubernetes provider of the web console's Cluster Management (see README.md).
#
#   utils/web-console/k8s_lab.sh up     creates the k3d cluster `chlab` (1 server, 2 agents), installs cert-manager,
#                                       the ClickHouse operator, and an expandable storage class; writes the kubeconfig
#   utils/web-console/k8s_lab.sh down   deletes the k3d cluster and its volumes
#
# Needs docker, k3d, kubectl, curl, and python3 with PyYAML. Versions are pinned to the ones the provider was verified with.
# Files go to $LAB_DIR (default tmp/k8s in the repository); K3D_CLUSTER names the k3d cluster (default chlab).
set -euo pipefail

CLUSTER="${K3D_CLUSTER:-chlab}"
CERT_MANAGER=v1.16.2
OPERATOR=v0.0.8
HOSTPATH=v1.17.1
ATTACHER=v4.8.0
PROVISIONER=v5.2.0
RESIZER=v1.13.1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LAB_DIR="${LAB_DIR:-$ROOT/tmp/k8s}"
export KUBECONFIG="$LAB_DIR/kubeconfig"

down() {
    k3d cluster delete "$CLUSTER"
    rm -f "$KUBECONFIG"
}

up() {
    mkdir -p "$LAB_DIR/manifests"
    cd "$LAB_DIR/manifests"
    k3d cluster create "$CLUSTER" --servers 1 --agents 2 --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait --timeout 300s
    k3d kubeconfig get "$CLUSTER" > "$KUBECONFIG"
    chmod 600 "$KUBECONFIG"

    # cert-manager: the operator's webhook needs its certificates.
    curl -sSfL -o "cert-manager-$CERT_MANAGER.yaml" "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER/cert-manager.yaml"
    kubectl apply -f "cert-manager-$CERT_MANAGER.yaml"
    kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=300s

    curl -sSfL -o "clickhouse-operator-$OPERATOR.yaml" "https://github.com/ClickHouse/clickhouse-operator/releases/download/$OPERATOR/clickhouse-operator.yaml"
    kubectl apply --server-side --force-conflicts -f "clickhouse-operator-$OPERATOR.yaml"
    kubectl -n clickhouse-operator-system wait --for=condition=Available deployment --all --timeout=300s

    # The CSI host-path driver, for a storage class that allows volume expansion (k3s's local-path does not). Only the
    # driver, the provisioner, the attacher, and the resizer: snapshots and health monitoring need more CRDs and are not
    # used. It runs on one node, so the class binds volumes immediately and pods follow them to that node. The driver
    # records the size of a volume but does not enforce it: a lab for the expansion workflow, not for capacity limits.
    curl -sSfL -o "hostpath-$HOSTPATH.tar.gz" "https://github.com/kubernetes-csi/csi-driver-host-path/archive/refs/tags/$HOSTPATH.tar.gz"
    rm -rf hostpath && mkdir hostpath && tar -xzf "hostpath-$HOSTPATH.tar.gz" -C hostpath --strip-components=1
    curl -sSfL -o rbac-attacher.yaml "https://raw.githubusercontent.com/kubernetes-csi/external-attacher/$ATTACHER/deploy/kubernetes/rbac.yaml"
    curl -sSfL -o rbac-provisioner.yaml "https://raw.githubusercontent.com/kubernetes-csi/external-provisioner/$PROVISIONER/deploy/kubernetes/rbac.yaml"
    curl -sSfL -o rbac-resizer.yaml "https://raw.githubusercontent.com/kubernetes-csi/external-resizer/$RESIZER/deploy/kubernetes/rbac.yaml"
    python3 -I - <<'EOF'
import yaml
D = 'hostpath/deploy/kubernetes-1.31/hostpath/'
out = []
for d in yaml.safe_load_all(open(D + 'csi-hostpath-plugin.yaml')):
    if not d:
        continue
    if d['kind'] in ('ClusterRoleBinding', 'RoleBinding') and any(x in d['metadata']['name'] for x in ('snapshot', 'health-monitor')):
        continue
    if d['kind'] == 'StatefulSet':
        spec = d['spec']['template']['spec']
        spec['containers'] = [c for c in spec['containers'] if c['name'] not in ('csi-snapshotter', 'csi-external-health-monitor-controller')]
    out.append(d)
out.append(yaml.safe_load(open(D + 'csi-hostpath-driverinfo.yaml')))
out.append({'apiVersion': 'storage.k8s.io/v1', 'kind': 'StorageClass', 'metadata': {'name': 'csi-hostpath-expandable'}, 'provisioner': 'hostpath.csi.k8s.io',
            'reclaimPolicy': 'Delete', 'volumeBindingMode': 'Immediate', 'allowVolumeExpansion': True})
yaml.safe_dump_all(out, open('hostpath-lab.yaml', 'w'), sort_keys=False)
EOF
    kubectl apply -n default -f rbac-attacher.yaml -f rbac-provisioner.yaml -f rbac-resizer.yaml
    kubectl apply -n default -f hostpath-lab.yaml
    kubectl -n default rollout status statefulset/csi-hostpathplugin --timeout=300s

    kubectl get storageclass
    echo "Kubeconfig: $KUBECONFIG. Start the agent with CLUSTER_AGENT_KUBECONFIG=$KUBECONFIG."
}

case "${1:-}" in
    up) up ;;
    down) down ;;
    *) echo "Usage: $0 up|down" >&2; exit 2 ;;
esac
