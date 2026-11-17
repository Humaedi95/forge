# Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Humaedi95/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Humaedi95/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process, written
for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge").

No git binary, no database, no outside service: everything lives in an
in-memory store, and every byte the forge stores or sends is deterministic
(fixed timestamps, sequential ids, content-addressed git objects).

## Run it

Requires Node 22+ (type stripping only — no build step, no dependencies).

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=spg1d5j0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

- **git smart HTTP** — `upload-pack` protocol v2 and `receive-pack` v0:
  clone, fetch (full, incremental, shallow, deepen), and push, with a
  from-scratch implementation of pkt-lines, packfiles (read/write, OFS/REF
  deltas, thin packs), refs, and annotated tags.
- **REST v3** — `/api/v3`: repositories, branches, commits, refs, contents
  (create/update/delete with sha checks), labels, issues (+ comments), and
  pull requests (create, files, squash merge with conflict detection).
- **GraphQL v4** — `/api/graphql`: `viewer`, `repository`, `node(id:)`,
  issues/pull requests with cursor pagination, mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), batched operations, and `__type` introspection. Includes a
  small hand-written GraphQL parser for this subset.
- **MCP** — `/mcp`: JSON-RPC 2.0 Streamable HTTP, modern `server/discover`
  era plus the legacy `initialize` fallback, with six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

The forge binds an ephemeral port, `POST`s `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
suite finishes the trial and exits 0. With `MAKEFUN_ENV_URL` unset it serves
until killed (local development). `GET /healthz` answers `{"ok": true}`.

Authentication: every protected route takes
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the token names the viewer
(`adaiversen`). When the variable is unset, any request is accepted.

## Layout

```
main.ts            the whole forge (one file, stdlib only)
LICENSE            MIT © 2026 A HUMAEDI
.makefun/owner.json  payout wallet for the make.fun entry
```

## Local practice scores

Against the kit's sealed environment (`program/env/server.mjs`), independently
verified with `grade-local` (2026-11-17):

- **Total 990/1000** — feature 600/600, agent 200/200, perf 190/200;
  live trial and replay produced byte-identical state exports.
- Earlier practice trial 2: **~972/1000** — conformance 120/120
  (git 30/30, repos 15/15, issues 15/15, pulls 20/20, GraphQL 20/20,
  MCP 15/15, protocol 5/5), perf 172/200.
- Both above the house reference forge (~900).

## Referral

Built by [@humaedi-ahmad](https://make.fun/r/spg1d5j0) — try make.fun with
my referral link: https://make.fun/r/spg1d5j0
