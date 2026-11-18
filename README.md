# GitHub Core Clone Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thegoodsxx/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thegoodsxx/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge running as ONE Node.js 22 process with zero external dependencies (Node standard library only).

## Architecture & Surface Implementation

### 1. In-Memory Git Engine & Forge Store (`store.ts`)
- Pure in-memory Git object store supporting loose objects (blobs, trees, commits, tags) indexed by SHA-1.
- Complete tree parsing and recursive tree delta mutations for file creation, update, and deletion with SHA verification.
- Fast commit-graph reachability, ancestor checks, and shallow clone graph traversal.
- Domain models for repositories, branches, issues, comments, labels, and pull requests.

### 2. Git Smart HTTP Protocol (`git.ts`)
- Implements both Protocol v2 and v0 smart HTTP endpoints:
  - `GET /<owner>/<repo>.git/info/refs?service=git-upload-pack`: v2 capability advertisement and v0 ref listing.
  - `GET /<owner>/<repo>.git/info/refs?service=git-receive-pack`: v0 ref advertisement.
  - `POST /<owner>/<repo>.git/git-upload-pack`: `command=ls-refs` with prefixes, symrefs, peel, and unborn support; `fetch` with shallow boundaries (`deepen`, `shallow`, `unshallow`), acknowledgments framing, and packfile generation.
  - `POST /<owner>/<repo>.git/git-receive-pack`: pkt-line command decoding, delta packfile unpacking (OFS_DELTA and REF_DELTA resolution), fast-forward checks, atomic ref updates, sideband-64k progress and report-status framing.
- Performance optimization: In-memory deflated object cache (`WeakMap<GitObject, Buffer>`) and `zlib` level 1 compression, drastically reducing CPU time for concurrent clones.

### 3. REST v3 API (`rest.ts`)
- Full implementation of `/api/v3` routes:
  - Meta & User: `GET /api/v3/`, `GET /api/v3/meta`, `GET /api/v3/user`.
  - Repositories: `GET` / `POST /api/v3/user/repos` (with absolute `Link` header pagination), `GET` / `PATCH` / `DELETE /api/v3/repos/:owner/:repo`.
  - Branches & Commits: `GET /api/v3/repos/:owner/:repo/branches`, `GET /api/v3/repos/:owner/:repo/commits`.
  - Contents API: `GET` / `PUT` / `DELETE /api/v3/repos/:owner/:repo/contents/:path` supporting recursive directory listings, new file creation, file update with stale SHA conflict detection (409).
  - Issues & Comments: `GET` / `POST /api/v3/repos/:owner/:repo/issues`, filter by state, sort by creation date, label management, comments listing and creation.
  - Pull Requests: `GET` / `POST /api/v3/repos/:owner/:repo/pulls`, `GET .../pulls/:number/files` tree diffing, and squash merge (`PUT .../pulls/:number/merge`) with conflict checks.
- Adheres to GitHub error semantics (JSON 404/422/401/405) and attaches `X-GitHub-Request-Id` headers.

### 4. GraphQL v4 Endpoint (`graphql.ts`)
- Accessible at `POST /api/graphql` with Bearer authentication.
- Supports operation batching (JSON array of operations) and single operations.
- Implements queries: `ViewerLogin`, `RepositoryFields`, Relay `node(id: ID!)`, `OpenIssues` (with states filter and `orderBy: {field: CREATED_AT, direction: DESC}`), `IssueByNumber`, `PullRequests`, `PullRequestFiles`, `IssuesPage` (cursor-based pagination with `pageInfo`).
- Implements mutations: `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` (squash), and `addComment`.
- Full GraphQL introspection: `__type` queries for `Issue`, `PullRequest`, `Repository`, and `SearchType`.

### 5. Model Context Protocol (MCP) Streamable HTTP (`mcp.ts`)
- Accessible at `POST /mcp` supporting both the 2026-07-28 `server/discover` specification and legacy `initialize` handshake.
- Idempotent `tools/list` exposing 6 core tools with complete JSON Schemas:
  - `create_repo`
  - `get_repo`
  - `create_issue`
  - `list_issues`
  - `create_pull_request`
  - `merge_pull_request`
- Robust `tools/call` execution with error reporting and parameter normalization (`full_name` splitting, prefix stripping).

### 6. Process Lifecycle & Dispatcher (`main.ts`, `app.ts`)
- Binds to ephemeral port (`server.listen(0)`), registers port with `$MAKEFUN_ENV_URL/register`.
- Long-polls `$MAKEFUN_ENV_URL/done` until test suite completion and cleanly exits with status code 0.
- Top-level exception handling ensuring resilience against malformed packets and network errors.

## Running the Forge

```bash
node --experimental-strip-types main.ts
```

Node 22+ runs TypeScript directly via `--experimental-strip-types`. No build step or `npm install` is required.

## Test Scores & Performance Benchmarks

Graded with the local suite (`grade-local` process driver, 120 conformance checks and 4 benchmark workloads):

### Conformance Checks: 120 / 120 Passed (100%)
- **git**: 30 / 30 passed
- **repos**: 15 / 15 passed
- **issues**: 15 / 15 passed
- **pulls**: 20 / 20 passed
- **graphql**: 20 / 20 passed
- **mcp**: 15 / 15 passed
- **protocol**: 5 / 5 passed

### Scorer Breakdown (out of 1000)
- **Feature Score**: 600 / 600
- **Agent Score**: 200 / 200
- **Performance Score**: 190 / 200
- **Total Score**: **990 / 1000**

### Workload Benchmark Results
- **push** (200 ops): p50 = 353.52 ms | **50 / 50 pts**
- **clone** (50 concurrent ops): p50 = 89.85 ms | **45 / 50 pts**
- **read** (2,000 ops): p50 = 741.03 ms | **49 / 50 pts**
- **write** (200 ops): p50 = 109.07 ms | **46 / 50 pts**
- **perf_p50_us**: 225,091 µs
