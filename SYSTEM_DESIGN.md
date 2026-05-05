# Stage 4a — System Design: Scaling Insighta Labs+

---

## 1. Requirements

### Functional Requirements

The system must continue to support everything built in Stage 3:

- Authenticate users via GitHub OAuth, issue and rotate JWT access and refresh tokens
- Enforce role-based access control (admin / analyst) across all endpoints
- Accept structured filter queries against the profiles dataset (gender, age, age group, country, probability ranges)
- Parse simple keyword queries into structured filters via rule-based NLP
- Return paginated, sorted results with consistent response shapes
- Export filtered results as CSV
- Serve a CLI tool and a web portal backed by the same API

At scale, the system must additionally:

- Handle hundreds to low thousands of queries per minute without degradation
- Serve repeated query patterns efficiently without hitting the database every time
- Ingest new profiles without disrupting read availability
- Remain available when individual components fail

### Non-Functional Requirements

| Requirement | Target |
|---|---|
| P50 query latency | < 500ms |
| P95 query latency | < 2 seconds |
| Read throughput | Hundreds to ~1,000 queries/minute |
| Data scale | Tens of millions of profiles |
| Deployment | Single-region |
| Consistency | Eventual for cached reads, strong for writes |
| Availability | No single point of failure at the application layer |

---

## 2. Architecture

```
                        ┌─────────────────────────────────────┐
                        │              Clients                │
                        │     CLI          Web Portal         │
                        └──────────────┬──────────────────────┘
                                       │ HTTPS
                                       ▼
                        ┌─────────────────────────────────────┐
                        │           Load Balancer             │
                        │        (Nginx / managed LB)         │
                        └──────────┬──────────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
             ┌──────────┐  ┌──────────┐  ┌──────────┐
             │  API     │  │  API     │  │  API     │
             │ Node.js  │  │ Node.js  │  │ Node.js  │
             │ instance │  │ instance │  │ instance │
             └────┬─────┘  └────┬─────┘  └────┬─────┘
                  │             │             │
                  └──────┬──────┘─────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
     ┌─────────────────┐   ┌────────────────────┐
     │   Redis Cache   │   │   PostgreSQL       │
     │                 │   │                    │
     │  Query results  │   │  Primary (writes)  │
     │  (TTL: 5 min)   │   │         │          │
     └─────────────────┘   │  Read Replica      │
                           │  (reads)           │
                           └────────────────────┘
                                     │
                           ┌─────────────────────┐
                           │  Batch Ingestion    │
                           │  (profile writes)   │
                           └─────────────────────┘
```

**Components:**
- **Load Balancer** — distributes traffic across API instances. Handles SSL termination.
- **API instances (Node.js)** — stateless. Multiple instances run the same Stage 3 codebase. Statelessness is already guaranteed because JWT auth carries user identity — no session state on the server.
- **Redis** — caches the output of repeated query executions.
- **PostgreSQL primary** — handles all writes (profile creation, token storage, user upserts).
- **PostgreSQL read replica** — handles all read queries (list, search, export). Reduces load on the primary.
- **Batch ingestion** — profile creation from external APIs is async and separated from the query path.

---

## 3. Data Flow

### Query Flow

```
Client sends GET /api/profiles?gender=male&country_id=NG&page=1
  │
  ▼
Load balancer routes to any available API instance
  │
  ▼
authenticate middleware — verifies JWT (stateless, no DB hit for valid tokens)
  │
  ▼
apiVersion + authorize middleware — fast, synchronous checks
  │
  ▼
buildQuery() — compiles filter params into SQL + cache key
  │
  ▼
Redis lookup (cache key = hash of normalized query params)
  ├── HIT  → return cached result immediately (~5ms)
  └── MISS → query read replica
              │
              ▼
           PostgreSQL read replica
           SELECT * FROM profiles WHERE gender=$1 AND country_id=$2
           ORDER BY created_at ASC LIMIT 10 OFFSET 0
              │
              ▼
           Results written to Redis (TTL: 5 minutes)
              │
              ▼
           Response returned to client
```

### Write Flow (Profile Ingestion)

```
POST /api/profiles { name: "Ada" }
  │
  ▼
Admin authenticated → createProfile()
  │
  ▼
Three external API calls in parallel (Genderize, Agify, Nationalize)
  │
  ▼
INSERT INTO profiles → PostgreSQL primary
  │
  ▼
Invalidate Redis cache keys that match affected filters
(gender + country_id combination cache entries purged)
  │
  ▼
201 response returned
```

### Auth Flow

Auth token verification is fully stateless — `jwtVerify()` checks the signature locally, no DB query. The DB is only hit to check `is_active` once per request. This is already in place and does not change at scale.

---

## 4. Design Decisions

### Decision 1 — Query result caching with Redis

**Requirement it addresses:** P50 < 500ms at tens of millions of rows.

**The problem:** Without caching, every `GET /api/profiles?gender=male&country_id=NG` executes a `SELECT COUNT(*) + SELECT *` pair against a table of tens of millions of rows. Even with indexes, this becomes expensive at scale. Analyst teams run the same queries repeatedly — the same demographic filters applied every morning by the same team.

**The decision:** Cache the full serialized response in Redis, keyed by a hash of the normalized query parameters. TTL of 5 minutes.

**Why this works:** Profile data is not real-time. It is ingested in batch. A 5-minute stale result is acceptable for analytical use. If ~40% of queries repeat the same filter combinations, caching eliminates 40% of database load entirely.

**Cache invalidation:** On `POST /api/profiles`, invalidate cache entries whose keys include the affected gender and country. A simple approach: use key prefixes (`profiles:gender=male:country_id=NG:*`) and delete by pattern on write.

**Trade-off:** Stale results for up to 5 minutes after a new profile is added. Acceptable for this use case — analysts are not expecting real-time data.

---

### Decision 2 — PostgreSQL read replica

**Requirement it addresses:** Read throughput at hundreds of queries per minute without overloading the primary.

**The problem:** All reads and writes currently go to a single PostgreSQL instance. At scale, concurrent read queries compete with writes for I/O, connection slots, and buffer pool. The primary becomes a bottleneck.

**The decision:** Add one read replica. All `SELECT` queries (list, search, export, `GET /api/users/me`) are routed to the replica. All `INSERT`, `UPDATE`, `DELETE` go to the primary.

**Implementation:** A second `pg.Pool` instance pointing at the replica URL. A thin routing function:

```js
export const readQuery  = (text, params) => readPool.query(text, params);
export const writeQuery = (text, params) => pool.query(text, params);
```

This requires no architectural change — just a second connection pool used in `listProfiles`, `getProfileById`, and `exportProfiles`.

**Why not more replicas?** One replica is sufficient for the stated scale (hundreds to ~1,000 queries/minute). With Redis absorbing repeated queries, the database load on reads is already reduced. A second replica would be premature.

**Trade-off:** Replication lag — a newly inserted profile may not be visible on the replica for a few hundred milliseconds. Acceptable for this system. If a user creates a profile and immediately queries for it, that specific case can be routed to the primary.

---

### Decision 3 — Horizontal API scaling (multiple Node.js instances)

**Requirement it addresses:** Availability, resilience, and throughput at hundreds of concurrent users.

**The problem:** A single Node.js process is single-threaded. Under high load, CPU-bound work (JWT verification, response serialization) and I/O wait (DB queries) can saturate the event loop and increase latency.

**The decision:** Run multiple instances of the same Node.js process behind a load balancer. This is already possible because the application is completely stateless — JWT auth carries user identity, no session is stored server-side.

**Why this is cheap to implement:** No code changes are required. The existing Stage 3 codebase runs as multiple processes today. A managed platform (Railway, Render, Fly.io) handles this with a single config change.

**Trade-off:** Rate limiting is currently in-process (express-rate-limit uses an in-memory store). Across multiple instances, each instance has its own counter — a user could send 10 requests to each of 3 instances and bypass the rate limit. Fix: move rate limit state to Redis using `rate-limit-redis` as the store. This is a one-line config change.

---

### Decision 4 — Compound indexes on the profiles table

**Requirement it addresses:** P95 < 2 seconds for filtered queries against tens of millions of rows.

**The problem:** The current schema has single-column indexes on `gender`, `country_id`, `age_group`, and `age`. When a query filters on multiple columns (the common case — e.g. `gender=male AND country_id=NG AND age_group=adult`), PostgreSQL must either use one index and filter the rest in memory, or perform a bitmap index scan across multiple indexes. At tens of millions of rows, this becomes slow.

**The decision:** Add compound indexes on the most common filter combinations:

```sql
CREATE INDEX idx_profiles_gender_country
  ON profiles(gender, country_id);

CREATE INDEX idx_profiles_gender_country_age_group
  ON profiles(gender, country_id, age_group);

CREATE INDEX idx_profiles_country_age_group
  ON profiles(country_id, age_group);
```

These cover the majority of real query patterns from the rule-based NLP parser output.

**Why not index every combination?** Indexes consume storage and slow down writes. Three compound indexes covering the most frequent combinations is sufficient. Single-column indexes remain for queries that only filter on one dimension.

**Trade-off:** Write performance degrades slightly as each insert now maintains additional indexes. Acceptable because writes are infrequent (batch ingestion, not high-frequency).

---

### Decision 5 — Async batch ingestion (separate from the query path)

**Requirement it addresses:** Write operations (profile creation) should not impact read latency.

**The problem:** `POST /api/profiles` currently calls three external APIs (Genderize, Agify, Nationalize) synchronously, waits for all three responses, then writes to the DB. At scale, bulk ingestion of profiles saturates external API rate limits and keeps HTTP connections open for 5–15 seconds per profile.

**The decision:** For single profile creation (admin UI or CLI), keep the synchronous flow — the user expects an immediate result. For bulk ingestion, introduce a simple async queue: accept a list of names, enqueue the enrichment work, return a job ID, process in the background.

**Implementation without a message queue:** A lightweight in-process queue using `setImmediate` or a `Promise` chain is sufficient for the stated scale. A full message queue (Redis queues, RabbitMQ) is not warranted unless ingestion volumes reach thousands of profiles per hour.

**Trade-off:** Bulk ingestion results are not immediately visible. A status endpoint (`GET /api/ingestion/:jobId`) can surface progress.

---

## 5. Trade-offs and Limitations

### What this design handles well

- Repeated analytical queries — Redis eliminates DB round trips for the most common patterns
- Horizontal read scaling — read replica absorbs query load as data grows
- No downtime during API deploys — multiple instances, load balancer routes around restarting instances
- No architecture change required — Stage 3 codebase is unchanged; additions are additive

### What this design does not handle well

**Cache invalidation precision:** The current invalidation strategy (pattern-delete on write) is coarse. It may evict more cache entries than necessary on each write. At high write volumes, the cache hit rate drops. A more precise approach (content-addressable cache keys) would help but adds complexity not warranted at this scale.

**Export at massive scale:** `GET /api/profiles/export` currently fetches all matching rows in a single query and streams them. At tens of millions of matching rows, this is a multi-second, memory-intensive operation. The fix is cursor-based streaming pagination — fetch and write rows in chunks. Not implemented because export is an admin-only, infrequent operation at this stage.

**Rate limiting across instances:** As noted above, in-memory rate limiting does not work correctly across multiple API instances. Requires Redis-backed store. Simple fix, but not yet in place.

**Single region:** A single-region deployment means all users experience latency proportional to their geographic distance from the server. Acceptable for an internal platform with known user locations. Not acceptable for a global product.

**Replica lag on immediate reads after writes:** A profile created by an admin may not be visible to an analyst for a few hundred milliseconds if the analyst's query hits the replica before replication completes. For this use case, this is acceptable. For a use case requiring read-your-writes consistency, all reads should be temporarily routed to the primary after a write.

**No observability:** There is currently no structured metrics collection (query duration histograms, cache hit/miss rates, DB connection pool utilization). At scale, these are essential for detecting degradation before it becomes an outage. Adding Prometheus metrics or a hosted APM (Datadog, Sentry) is the next operational step.

---

## Optional: Future Extensions

### Real-time analytics

The current system returns pre-stored, static profiles. Real-time analytics would mean aggregations that reflect the current state of the dataset at query time — e.g. "how many male adults are from Nigeria right now?"

The simplest path is **PostgreSQL materialized views**, refreshed on a schedule:

```sql
CREATE MATERIALIZED VIEW profile_aggregates AS
  SELECT gender, country_id, age_group, COUNT(*) AS count
  FROM profiles
  GROUP BY gender, country_id, age_group;
```

Refreshed every few minutes via a cron job (`REFRESH MATERIALIZED VIEW CONCURRENTLY`). This gives near-real-time aggregation without a streaming infrastructure. A proper streaming system (Kafka + ksqlDB) would only be justified if refresh frequency needed to drop below 30 seconds.

### True natural language queries

The current NLP is rule-based: keyword matching with a hand-crafted lookup table. It works well for the defined vocabulary but cannot generalize.

A pragmatic evolution path:

1. **Expand the rule set** — cover more filter combinations, synonyms, and negations. Low effort, high return for the near term.
2. **Intent classification** — train a small text classifier (e.g. with fastText) to map query strings to structured filter templates. No LLM required, fast inference, deterministic output.
3. **LLM-assisted parsing** — use a small, fast model (e.g. a quantized Llama or a hosted API call to a cheap model) to convert free-form queries into a structured JSON filter object. The LLM's output is validated against the existing `buildQuery` schema before execution — the LLM never touches the database directly.

The staged approach means the system degrades gracefully at each level: if the LLM is unavailable, fall back to the classifier; if the classifier is unavailable, fall back to rule-based parsing.
