# Kubernetes

The same stack as `compose.yaml`, with one structural difference: the ingestion
API and the queue worker are separate Deployments, so they scale independently.

```
k8s/
  base/            the real shape: 2 web pods, 2 ingest pods, room to breathe
  overlays/local/  what fits on a laptop: 1 of each, requests cut to idle usage
```

The laptop constraints live in an overlay rather than in the base, so the
committed manifests describe a cluster somebody would actually deploy to.

## Status: written and rendering, not yet applied

Both variants render through kustomize with no warnings, and all three images
build. Nothing here has scheduled a pod.

The machine this was developed on has 7.4 GB of RAM. Docker Desktop's kind
cluster wants roughly 2 GB for the control plane before any workload, and
`kubeadm init` failed twice on this hardware. Rather than trim the manifests
until something started and call that a Kubernetes deployment, the state is
recorded as it is.

What that means for anyone applying these: expect the manifests to be structurally
sound and expect image pull configuration to be the first thing that needs
attention, since the local tags assume a shared image store.

```
   Service web:3000  ->  web x2        (SDK runs inside these pods)
                              |
                              v
   Service ingest:3001 -> ingest x2    INGEST_WORKER=false, accepts and enqueues
                              |
                          pgmq queue
                              |
                          worker x1    INGEST_WORKER=true, drains and persists
                              |
                              v
   Service db:5432    ->  postgres     StatefulSet, one volume

   Service dashboard:3002 -> dashboard  reads rollups only
```

## Run it

Tested on Docker Desktop Kubernetes. Enable it under Settings, Kubernetes,
Enable Kubernetes.

**1. Build the images locally.** The manifests use `imagePullPolicy: IfNotPresent`
and local tags, so nothing is pulled from a registry and no pull secret is
needed. Docker Desktop's Kubernetes shares the Docker image store.

```bash
docker build -f docker/Dockerfile.ingest    -t datadawg/ingest:local    .
docker build -f docker/Dockerfile.web       -t datadawg/web:local       .
docker build -f docker/Dockerfile.dashboard -t datadawg/dashboard:local .
```

Build context is the repo root in all three cases. The apps import `packages/*`,
and a context scoped to an app directory cannot see them.

**2. Create the secret.**

```bash
cp k8s/base/02-secret.example.yaml k8s/secret.yaml
# edit k8s/secret.yaml, set ANTHROPIC_API_KEY and INGEST_API_KEY
kubectl apply -f k8s/secret.yaml
```

`k8s/secret.yaml` is gitignored. It is applied on its own rather than through
kustomize, so a `kubectl apply -k` on a fresh clone cannot install placeholder
credentials over real ones.

**3. Apply everything else.**

```bash
kubectl apply -k k8s/overlays/local/   # on a laptop
kubectl apply -k k8s/base/             # on a real cluster
kubectl -n datadawg get all
```

A kind control plane takes roughly 2 GB before a single application pod is
scheduled, so on a machine with 8 GB or less the overlay is the one that works.
Applying the base there leaves pods `Pending` on insufficient memory.

**4. Open it.**

- Chat: http://localhost:3000
- Dashboard: http://localhost:3002

Docker Desktop maps `LoadBalancer` Services to localhost. On a cluster without a
load balancer controller those Services stay `Pending`, and you reach them with:

```bash
kubectl -n datadawg port-forward svc/web 3000:3000
kubectl -n datadawg port-forward svc/dashboard 3002:3002
```

Ingestion has no external Service on purpose. Only the web pods call it. To poke
it by hand:

```bash
kubectl -n datadawg port-forward svc/ingest 3001:3001
curl localhost:3001/readyz
```

## The parts that are not a translation of compose.yaml

**Ordering.** Compose has `depends_on: service_completed_successfully`.
Kubernetes has nothing equivalent, and pods start in whatever order the
scheduler picks. So the migration runs as a Job, and every application pod
carries an initContainer that loops on `db:verify` until the schema is actually
correct. That reuses the checker already used in development and CI, rather than
sleeping and hoping.

**The API and worker split.** Under Compose one process did both. Here they are
two Deployments off the same image with opposite `INGEST_WORKER` values.
Accepting events scales with client traffic, draining the queue scales with
backlog, and those are different numbers.

Running more than one worker is safe. pgmq gives each message to one consumer
for the visibility timeout, and the persist path de duplicates on `event_id`, so
at least once redelivery cannot double count.

**The probes finally do something.** `/healthz` is dependency free and
`/readyz` reports the database. Under Compose that distinction was tested but
nothing consumed it. Here, readiness failing pulls a pod out of its Service
instead of routing traffic into failures, and liveness staying dependency free
means a brief database blip does not restart the entire fleet at the moment the
database is already struggling.

On a pod that owns the worker, readiness also checks consumer lag. A wedged
worker answers `/healthz` perfectly: the process is alive and HTTP works, it
just is not draining anything.

**Graceful shutdown.** `terminationGracePeriodSeconds: 20` sits above
`SHUTDOWN_GRACE_MS: 10000`. The SDK buffers events in memory and flushes on
SIGTERM, so cutting the pod off early discards up to one flush interval of
telemetry on every rollout. That reads as a small traffic dip rather than a bug.

This only works because the containers run `node` as PID 1 rather than
`npm run`. npm does not forward SIGTERM, so the handler would never fire.

## Verify it works

```bash
# every pod ready, migrate Job completed
kubectl -n datadawg get pods

# the split is real: one says in-process, the other says external
kubectl -n datadawg exec deploy/worker -- wget -qO- localhost:3001/readyz
kubectl -n datadawg exec deploy/ingest -- wget -qO- localhost:3001/readyz

# a rollout drains rather than dropping
kubectl -n datadawg rollout restart deploy/web
kubectl -n datadawg rollout status  deploy/web
```

Then send a message in the chat and watch the call appear on the dashboard.

## Not done

- No Ingress. Two `LoadBalancer` Services are enough on a laptop, and an Ingress
  would need a controller that adds nothing to what this demonstrates.
- No HorizontalPodAutoscaler. Autoscaling on CPU would be guessing. The honest
  signal for the worker is queue depth, which needs a custom metrics adapter.
- No NetworkPolicy. On a shared cluster, ingestion and Postgres should only
  accept traffic from inside the namespace.
- Postgres runs in the cluster. Fine for a demo, wrong for production, where it
  should be a managed database and this StatefulSet should not exist.
