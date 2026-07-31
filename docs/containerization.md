# Containerization

> ## ⚠️ DESIGNED, NOT EXECUTED
>
> **Nothing in this file has been run.** The build machine had no container
> runtime — no Docker, no WSL2 distribution, no `kubectl`. These artifacts are
> written from the architecture, not verified against it.
>
> They are here because the design decisions are real and worth reviewing. They
> are **not committed as working files**, because a `compose.yaml` in the repo
> root implies `docker compose up` works, and a reviewer who runs it and hits an
> error learns something bad about everything else in the repo. An unverifiable
> claim is worse than a stated gap.

---

## What is already done

Containerising this is a packaging step rather than a redesign, because the
things that actually make a service container-ready were built in from the
start — each justified on its own merits, not on a container that did not exist:

| Seam | Where | Why it was worth building anyway |
|---|---|---|
| All config from the environment, validated once at boot | `packages/config` | A missing variable fails at startup naming the variable, instead of as a `TypeError` at 3am |
| No local disk state | everywhere | Any replica can serve any request |
| `/healthz` (liveness) and `/readyz` (readiness), **genuinely different** | `apps/ingest`, `apps/web` | Liveness is dependency-free on purpose: wiring it to the database turns a brief blip into a restart loop across every replica |
| SIGTERM → stop accepting → flush → close pool → exit | `apps/ingest`, `packages/sdk` | Without it every deploy silently drops whatever was buffered — invisible loss that reads as a small traffic dip |
| Structured JSON logs to stdout, never files | `packages/sdk`, `apps/ingest` | What every log shipper already collects |
| Migrations as a standalone command | `npm run db:migrate` | Becomes the compose one-shot / k8s Job verbatim |

`SHUTDOWN_GRACE_MS` (default 10s) is deliberately the same number as
`terminationGracePeriodSeconds` below.

---

## Dockerfile (per app)

Multi-stage. The workspace is built once, then only production dependencies and
`dist/` are copied into the runtime image.

```dockerfile
# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root. The default `node` user exists in the base image.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/ingest ./apps/ingest

EXPOSE 3001

# Signals reach the process directly. Wrapping this in `npm run` would make npm
# PID 1, and npm does not forward SIGTERM — the graceful shutdown handler would
# never fire and every deploy would drop the buffer.
CMD ["node", "apps/ingest/dist/server.js"]
```

The `CMD` note is the one detail most likely to be got wrong, and it silently
undoes the graceful-shutdown work.

---

## compose.yaml

```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: ollive
      POSTGRES_DB: ollive
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d ollive"]
      interval: 2s
      timeout: 3s
      retries: 15

  # One-shot. Migrations must complete before anything serves traffic, and must
  # not race across replicas — the runner takes a session-scoped advisory lock,
  # but running them once here is cleaner than relying on that.
  migrate:
    build: { context: ., dockerfile: docker/Dockerfile.ingest }
    command: ["node", "packages/db/dist/cli/migrate.js"]
    environment:
      DATABASE_URL: postgres://postgres:ollive@db:5432/ollive?sslmode=disable
    depends_on:
      db: { condition: service_healthy }

  ingest:
    build: { context: ., dockerfile: docker/Dockerfile.ingest }
    environment:
      DATABASE_URL: postgres://postgres:ollive@db:5432/ollive?sslmode=disable
      INGEST_API_KEY: ${INGEST_API_KEY:-dev-local-key}
      INGEST_PORT: 3001
    ports: ["3001:3001"]
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3001/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 5
    # Matches SHUTDOWN_GRACE_MS so the drain can finish.
    stop_grace_period: 15s

  web:
    build: { context: ., dockerfile: docker/Dockerfile.web }
    environment:
      DATABASE_URL: postgres://postgres:ollive@db:5432/ollive?sslmode=disable
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      INGEST_ENDPOINT: http://ingest:3001
      INGEST_API_KEY: ${INGEST_API_KEY:-dev-local-key}
    ports: ["3000:3000"]
    depends_on:
      ingest: { condition: service_healthy }
    stop_grace_period: 15s

volumes:
  pgdata:
```

Target: `git clone && cp .env.example .env && docker compose up` reaches a
working chat on a clean machine.

**Health-gated `depends_on`, not plain `depends_on`.** The plain form waits for
the container to *start*, not to be *usable* — the app then races Postgres and
fails on first connect roughly half the time, which reads as flakiness rather
than a config error.

---

## Kubernetes

Only the parts that carry a decision.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: ollive-ingest }
spec:
  replicas: 2
  template:
    spec:
      # The one number that must match SHUTDOWN_GRACE_MS. Too short and the
      # drain is SIGKILLed mid-flush, which is exactly the loss the handler
      # exists to prevent.
      terminationGracePeriodSeconds: 30
      containers:
        - name: ingest
          image: ollive/ingest:latest
          ports: [{ containerPort: 3001 }]
          envFrom:
            - secretRef: { name: ollive-secrets }
          livenessProbe:
            httpGet: { path: /healthz, port: 3001 }
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /readyz, port: 3001 }
            periodSeconds: 5
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { memory: 512Mi }
```

**Two probes, two different endpoints — this is the point of having built them
separately.** `/healthz` never touches the database, so a database blip takes
pods *out of rotation* (readiness) instead of *restarting every replica*
(liveness). Pointing both at the same check is the classic way to convert a
30-second database hiccup into a cluster-wide restart storm.

Migrations run as a `Job`, not an init container: an init container runs once per
pod, so three replicas would run migrations three times concurrently.

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: ollive-migrate }
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ollive/ingest:latest
          command: ["node", "packages/db/dist/cli/migrate.js"]
          envFrom: [{ secretRef: { name: ollive-secrets } }]
```

A `CronJob` handles retention — `ensure_events_partition` for next month and
dropping partitions past 90 days. Both are idempotent, so a double run is
harmless.

An `HPA` on CPU would work, but ingestion is I/O-bound; queue depth or request
rate via a custom metric is the better signal. Not written, because writing an
autoscaler for a workload with no measured load would be guessing.

---

## To actually finish this

1. Install Docker Desktop + a WSL2 distribution (~2 GB, a reboot, possibly a BIOS
   virtualization change).
2. Write the two Dockerfiles under `docker/` and `compose.yaml` at the root.
3. `docker compose up` from a clean clone. Fix what breaks.
4. `k3d cluster create`, apply the manifests, capture `kubectl get all`.

Steps 1–3 are roughly 2.5 hours including the install. Step 4 is another 2. The
seams above mean none of it should require touching application code — which is
the claim this document exists to make checkable.
