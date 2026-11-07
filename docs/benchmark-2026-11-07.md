# Acceptance benchmark — 2026-11-07

The acceptance run for the bulk-scan speed work (plan `docs/superpowers/plans/2026-11-07-bulk-scan-speed.md`,
spec `docs/superpowers/specs/2026-11-07-bulk-scan-speed.md`). Everything below is live measurement
against the built server from this worktree, one call at a time, no retries inside a measured call.

- **Build:** `npm run build` → `dist/`, stamp `a58a4d8 (v0.2.1-20-ga58a4d8)`, branch `sdd/bulk-scan`.
  Everything except §4 below was measured against that build. A review fix, `fbdf72b` ("correct batch
  price_stats under new_only and mark a disabled history filter"), landed in the worktree at 07:07
  while this task was running; it changes `new_only` byte accounting, not routes or latency, so §4's
  novelty measurement was re-run on it and its figures are **the final build's**.
- **Box:** shared 4-core Linux, Node v26.8.2, headed Chromium on `DISPLAY=:0` (one browser per
  process; the harness sets `XIANYU_CALL_TIMEOUT_S=600` and drops the `*_proxy` variables).
- **Harness:** `scripts/bench-scan.mjs` — spawns one `node dist/index.js`, speaks MCP stdio, prints
  one row per query plus totals. `bytes` in a table is the sum of the per-row JSON envelopes; the
  whole-call envelope size is reported separately where it matters. `wall` is the measured call wall
  time; a failed query is a row, not a retry.
- **Site state:** goofish's search was *accepted* for most runs and *refused intermittently* — see
  [Route sensitivity and site state](#route-sensitivity-and-site-state). No `非法访问` risk-control
  page was observed; the site's own words were `RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试`
  (rate limit, once) and, on the typed route, an empty homepage (`no-search-input-on-homepage`,
  `page_chars: 0`).
- **Reproduction:** the spec files are reproduced at the bottom; the only runs the repo harness cannot
  express are the `new_only: true` second pass (the harness has no flag for it) and the
  whitespace-query row (`parseSpec` refuses a blank query). Those used a throwaway stdio client with
  the exact `tools/call` arguments quoted in their sections.

## Verdict against the acceptance goals

| Goal | Target | Measured | Verdict |
|---|---|---|---|
| **G1** Bulk scan | 12 queries × `pages: 2`/`limit: 60`, ≥ 11/12 answered, ≤ 2.5 min | 12/12 answered in **41.4s**, 526 listings (514 unique), 330,616B (`a58a4d8`); 12/12 in **54.8s**, 556 listings, 351,167B on the final build | **met** (2.7–3.7× under the budget) |
| **G2** Single-query latency | warm ≤ 3s median over 5 calls via replay; typed fallback ≤ 8s | replay calls **2.1–2.7s**, median **2.575s** in the run where 3/5 answered from replay; the retry run had only 1/5 replay and a **15.3s** median, typed calls **13.9–121.3s** | **met on the replay route, not as a whole** |
| **G3** Response size | compact 60-listing reply ≤ 40KB (≥ 2.5× smaller than ~99KB full) | 60-listing single replies **40,238–43,562B**; batch rows average **629–636B/listing** → **37.7–38.2KB per 60**; 526 listings = 330,616B | **met at the batch average, missed by 0.2–3.6KB on the heaviest single replies** (title length) |
| **G4** Novelty | second scan with `new_only` returns only unseen listings + price drops | same 12 queries, same process, second pass `new_only: true` (final build): **13 new / 0 known returned** out of 515 known, **16,367B vs 351,167B (21.5× smaller)** | **met** (0 price drops: no repricing between the two passes) |
| **G5** Failure isolation | a failed query returns per-query error data + `retry_after_s`; call is `partial`; no whole-call exception | `ok: true`, `isError: false`, `status: "partial"`, per-row `error_type`/`reason`/`retry_after_s`, the valid query's 27 items still returned in **84.0s**; the real `RGV587` throttle produced row error + 3 `skipped` rows + `stop_reason: cooldown` | **met in shape**; note that a *nonsense* query is an `empty` answer on this site, not an error |

## 1. Single-query warm latency, 5 calls

Requirement: 5 calls at `pages: 1, limit: 60`, record the median and which route answered (G2 target
≤ 3s via replay, ≤ 8s via the typed fallback).

### Run A — 2026-11-07T06:48:10+05:00

```bash
node scripts/bench-scan.mjs /tmp/xianyu-final/specs/single.json --out /tmp/xianyu-final/single
```

| query | ok | status | listings | route (`via`) | wall | bytes |
|---|---|---|---|---|---|---|
| `Tesla P100 16G` | true | success | 60 | `searchbox` (typed) | 121.3s | 40,238 |
| `Tesla V100 16G` | true | success | 60 | `searchbox` (typed) | 13.9s | 43,143 |
| `Tesla P40 24G` | true | success | 60 | **`search_replay`** | 2.6s | 42,948 |
| `RTX 3090 24G` | true | success | 60 | **`search_replay`** | 2.4s | 39,894 |
| `DDR4 ECC REG 16G 2400` | true | success | 21 | **`search_replay`** | 2.1s | 16,109 |
| **total** | 5/5 | 5 success | 261 | 3 replay / 2 typed | 142.2s | 182,332 |

- **Median: 2.575s** (the three replay calls were 2.575s / 2.392s / 2.089s; the envelope's own
  `elapsed_ms` was 120,680 / 13,857 / 2,575 / 2,392 / 2,089).
- The first two calls fell back to the typed route: the replay attempt in a fresh process pays the
  homepage replay page's one-time warm-up, and on this run it did not settle inside the route's gate
  (the compact envelope drops `attempt_log`, so the refusal text is not published here; see
  [§6](#6-route-diagnostic-compact-false)).
- Different queries on purpose: the same query twice would be served from the 120s search-page cache
  and would measure the cache, not the route.

### Run B — 2026-11-07T07:10:29+05:00 (retry after the replay refusals)

```bash
node scripts/bench-scan.mjs /tmp/xianyu-final/specs/single.json --out /tmp/xianyu-final/single2
```

| query | ok | status | listings | route (`via`) | wall | bytes |
|---|---|---|---|---|---|---|
| `Tesla P100 16G` | true | success | 60 | `searchbox` (typed) | 110.9s | 40,274 |
| `Tesla V100 16G` | true | success | 60 | `searchbox` (typed) | 15.3s | 43,562 |
| `Tesla P40 24G` | true | success | 60 | `searchbox` (typed) | 15.1s | 42,310 |
| `RTX 3090 24G` | true | success | 60 | **`search_replay`** | 2.7s | 40,273 |
| `DDR4 ECC REG 16G 2400` | true | success | 19 | `searchbox` (typed) | 36.9s | 14,598 |
| **total** | 5/5 | 5 success | 259 | 1 replay / 4 typed | 180.9s | 181,017 |

- **Median: 15.3s.** The one replay call was 2.7s; four calls were typed and took 15.1s, 15.3s,
  36.9s and 110.9s. This is the same five queries as run A, ~22 minutes later, and the site refused
  the replay route for four of them.
- So G2's ≤ 3s holds **where the replay route answers**, and the retry is the evidence that the route
  is not always available. The typed fallback's ≤ 8s target was **not** met in either run: the typed
  page walk at `limit: 60` is three pages (one load + two pager pages) and measured 13.9–15.3s when
  it worked, 36.9–121.3s when the replay attempt had to time out first.

## 2. Six-query `search_batch`, `pages: 2, limit: 60`

2026-11-07T06:51:20+05:00, the plan's command verbatim:

```bash
node scripts/bench-scan.mjs scripts/bench-spec.json --tool search_batch --out /tmp/xianyu-final
```

| # | query | ok | status | listings | route | pages | wall | row bytes |
|---|---|---|---|---|---|---|---|---|
| 0 | `Tesla P100 16G` | true | success | 53 | `search_replay` | 2 | 12.3s | 33,696 |
| 1 | `Tesla V100 16G` | true | success | 48 | `search_replay` | 2 | 1.9s | 30,114 |
| 2 | `Tesla P40 24G` | true | success | 48 | `search_replay` | 2 | 1.5s | 32,033 |
| 3 | `RTX 3090 24G` | true | success | 55 | `search_replay` | 2 | 1.5s | 34,092 |
| 4 | `精粤 X99 主板 D4` | true | success | 24 | `search_replay` | 2 | 1.6s | 14,959 |
| 5 | `DDR4 ECC REG 16G 2400` | true | success | 12 | `search_replay` | 2 | 1.8s | 7,845 |
| **total** | | **6/6** | 6 success | **240** (239 unique, 1 duplicate) | 6 replay | 12 | **20.6s** (bench line 20.8s, envelope 20,741ms) | **152,739** (envelope 153,943) |

- `totals`: `requested 6, ok 6, empty 0, failed 0, skipped 0, partial 0, listings 240,
  unique_listings 239, duplicates 1, new_listings 239, known_listings 1`; `history.tracked 239`;
  `stop_reason: null`, `partial: false`.
- The first query paid the process-wide replay warm-up (12.3s); the other five answered in
  **1.5–1.9s** each. Target ≤ 90s with replay: met with 4.3× margin.

## 3. Twelve-query `search_batch`, two passes in one process

Twelve real queries: the six above plus `V100 32G`, `MI50 32G`, `2080Ti 22G`, `P102-100`,
`V100 SXM2`, `Tesla T4 16G` (the six extras are from the user's `queries-gpu.json` set).

2026-11-07T06:54:20+05:00:

```bash
node scripts/bench-scan.mjs /tmp/xianyu-final/specs/twelve.json --tool search_batch --repeat 2 \
  --out /tmp/xianyu-final/twelve
```

### Pass 1 (G1, G3)

| # | query | ok | status | listings | route | pages | wall | row bytes |
|---|---|---|---|---|---|---|---|---|
| 0 | `Tesla P100 16G` | true | success | 53 | `search_replay` | 2 | 9.8s | 33,695 |
| 1 | `Tesla V100 16G` | true | success | 48 | `search_replay` | 2 | 5.9s | 30,153 |
| 2 | `Tesla P40 24G` | true | success | 48 | `search_replay` | 2 | 2.6s | 31,619 |
| 3 | `RTX 3090 24G` | true | success | 55 | `search_replay` | 2 | 1.7s | 34,242 |
| 4 | `精粤 X99 主板 D4` | true | success | 24 | `search_replay` | 2 | 1.7s | 14,682 |
| 5 | `DDR4 ECC REG 16G 2400` | true | success | 12 | `search_replay` | 2 | 5.0s | 7,845 |
| 6 | `V100 32G` | true | success | 50 | `search_replay` | 2 | 1.8s | 32,811 |
| 7 | `MI50 32G` | true | success | 30 | `search_replay` | 2 | 1.7s | 17,694 |
| 8 | `2080Ti 22G` | true | success | 53 | `search_replay` | 2 | 1.9s | 35,227 |
| 9 | `P102-100` | true | success | 33 | `search_replay` | 2 | 2.1s | 17,932 |
| 10 | `V100 SXM2` | true | success | 60 | `search_replay` | 2 | 3.4s | 38,026 |
| 11 | `Tesla T4 16G` | true | success | 60 | `search_replay` | 2 | 3.7s | 36,690 |
| **total** | | **12/12** | 12 success | **526** (514 unique, 12 duplicates) | 12 replay | 24 | **41.3s** (envelope 41,342ms) | **330,616** (envelope 331,831) |

- `totals`: `requested 12, ok 12, empty 0, failed 0, skipped 0, partial 0, listings 526,
  unique_listings 514, duplicates 12, new_listings 514, known_listings 12`;
  `history.tracked 514`; `stop_reason: null`, `partial: false`.
- G1 target ≤ 150s: **met at 41.3s** with 12/12 answered. G3: 330,616B / 526 listings = **629B per
  compact listing**, i.e. 37.7KB per 60 — under the 40KB line; the *whole-call* 330KB is the plan's
  own extrapolation and not a per-reply target.
- Re-measured on the final build (`fbdf72b`) when §4 was re-run at 07:34: 12/12 in **54.8s**,
  556 listings (541 unique), 351,167B, every row `search_replay` (first query 22.0s, the rest
  1.6–7.2s). Same shape, slower replay warm-up; still 2.7× inside the 150s budget.

### Pass 2 (same process, immediately, no `new_only`)

This pass is the honest route-sensitivity data point: it hit Goofish's rate limit after eight
queries.

| # | query | ok | status | listings | route | wall |
|---|---|---|---|---|---|---|
| 0–7 | the first eight queries | true | success | 320 | `search_replay` | 1.5–5.0s each |
| 8 | `2080Ti 22G` | **false** | **error** | 0 | typed (`searchbox`) | 75.6s |
| 9–11 | `P102-100`, `V100 SXM2`, `Tesla T4 16G` | false | **skipped** | 0 | — | 0 |
| **total** | | 8 ok / 1 failed / 3 skipped | `partial` | **320** | | **92.8s** |

- Envelope: `ok: true`, `status: "partial"`, `count: 320`, `stop_reason: "cooldown"`,
  `throttle_reason: "rate_limited"`, `retry_after_s: 60`, `partial: true`,
  `totals.failed: 1`, `totals.skipped: 3`.
- Row 8: `error_type: "SearchUnavailableError"`, `reason: "rate_limited"`, `retryable: true`,
  `retry_after_s: 60`, message quoting goofish's own
  `FAIL_SYS_USER_VALIDATE | RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试` from the typed route.
- Rows 9–11: `status: "skipped"`, `error_type: "XianyuError"`,
  `stop_reason`/`reason: "cooldown"`, `retry_after_s: 60`. **The batch stopped on the site's own
  word instead of spending the same patience on the remaining queries** — the latch does what the
  plan says it does, measured on a real throttle.
- Novelty on this pass: `totals.new_listings: 3`, `known_listings: 317`, `history.tracked: 517`.
  The second pass was **not** cheaper in wall time (92.8s vs 41.3s) and every answered row was live
  `search_replay`, not `cache`.

## 4. Twelve-query second pass with `new_only: true` (G4)

2026-11-07T07:34:12+05:00, **final build `fbdf72b`**. Same twelve queries, **one server process**,
pass 1 with the default `new_only: false`, pass 2 with `new_only: true`. The repo harness cannot set
`new_only`, so a throwaway stdio client made the same `tools/call` twice:

```javascript
// same process, one MCP server; both passes:
{ name: 'search_batch', arguments: { queries: <the twelve, each pages: 2, limit: 60>,
  compact: true, timeout_s: 240, attempts: 2 } }
// pass 2 adds: new_only: true
```

| pass | wall | status | answered | returned listings | bytes | `totals.new_listings` | `totals.known_listings` | `history.tracked` |
|---|---|---|---|---|---|---|---|---|
| 1 (`new_only: false`) | 54.8s | success | 12/12 | 556 (541 unique) | 351,167 | 541 | 15 | 541 |
| 2 (`new_only: true`) | 52.2s | success | 12/12 (6 `empty`, 6 with 1–7 items) | **13** | **16,367** | **13** | **0** | 554 |

- `history` on pass 2: `tracked 554`, `known_count 515`, `new_count 13`, `price_drops: []`.
- **13 listings were new, 515 known were suppressed, and the answer was 21.5× smaller in bytes**
  (351,167B → 16,367B). Every returned item carried `is_new: true`; no known item slipped through.
- No price drops: the two passes were ~52s apart and no listing this process had seen was repriced
  below its last observed price in that window.
- Both passes answered every row through `search_replay`; no row was served from the search-page
  cache. That is the 16-entry page cache at work: this scan asks for 24 pages, and the all-pages-cached
  fast path needs every page it asks for to still be held. A repeat scan therefore still pays
  Goofish for the fetching; what `new_only` saves is the payload (and the caller's reading).
- For the record, the same measurement on `a58a4d8` (before the review fix) gave 333,380B → 11,533B
  with 5 new listings out of 527 and the same 0 known returned. The fix recomputes a batch row's
  `price_stats` over the filtered items under `new_only`, so the exact byte count moves with the
  number of new listings; the ratio and the filtering behaviour do not.
- Warmer novelty data from the same day's six-query run: pass 1 `new_listings 239 / known 1`
  ([§2](#2-six-query-search_batch-pages-2-limit-60)).

## 5. Failure isolation (G5)

### 5a. A nonsense query plus two valid ones — 2026-11-07T07:04:16+05:00

```bash
node scripts/bench-scan.mjs /tmp/xianyu-final/specs/isolation.json --tool search_batch \
  --out /tmp/xianyu-final/isolation
```

| # | query | ok | status | items | route | wall |
|---|---|---|---|---|---|---|
| 0 | `zzzqqqxyz` | **true** | **empty** | 0 | `search_api` | 49.2s |
| 1 | `Tesla P100 16G` | true | success | 26 | `search_replay` | 3.1s |
| 2 | `Tesla V100 16G` | true | success | 27 | `search_replay` | 3.4s |
| **total** | | 3/3 | success | 53 | | 55.8s |

Envelope: `ok: true`, `status: "success"`, `partial: false`, `totals {ok 2, empty 1, failed 0,
skipped 0, listings 53}`. **On this site a nonsense query is an `empty` answer, not an error**: it
took 49.2s to confirm zero inventory (two attempts, then the inventory count), returned no items and
no `error_type`. That is the correct behaviour — an empty search is not a failure — but it means a
nonsense string cannot exercise G5 here. The isolation test therefore needs a query that *cannot be
searched*, and the next run supplies one.

### 5b. An unsearchable query plus two valid ones — 2026-11-07T07:06:13+05:00

`queries: [{ "query": "   " }, { "query": "Tesla P100 16G", "pages": 1, "limit": 60 },
{ "query": "Tesla V100 16G", "pages": 1, "limit": 60 }]`, `compact: true`, `timeout_s: 180`
(throwaway stdio client — `parseSpec` refuses a whitespace query).

| # | query | ok | status | items | error_type | reason | retryable | retry_after_s | wall |
|---|---|---|---|---|---|---|---|---|---|
| 0 | `"   "` | false | **error** | 0 | `XianyuError` | `invalid_arguments` | false | 0 | 0.003s |
| 1 | `Tesla P100 16G` | false | **error** | 0 | `SearchUnavailableError` | `timeout` | true | 0 | 66.8s |
| 2 | `Tesla V100 16G` | **true** | success | 27 | — | — | — | 0 | 17.1s |
| **total** | | 1/2 valid | **`partial`** | 27 | | | | | **84.0s** |

- Envelope: `ok: true`, MCP `isError: false`, **`status: "partial"`**, `count: 27`,
  `totals {ok 1, failed 2, requested 3}`, `partial: true`, `stop_reason: null`. **No whole-call
  exception and no "Call deadline reached"** — the call returned in 84.0s with the working query's
  27 listings.
- Row 0 is the deterministic per-query validation failure: the batch schema accepts a whitespace
  query, `requireQuery` refuses it inside that one row, and the row names the reason instead of
  failing the call. Row 1 is the site refusing the query (the typed route could not find the search
  input: `no-search-input-on-homepage`, `page_chars: 0`, `home_path: ""`); it is reported as a
  per-query `SearchUnavailableError` with `reason: "timeout"` and `retryable: true`, exactly the
  shape G5 asks for.
- Row 1's `retry_after_s` is `0` because the failure is a timeout, not a named throttle; the envelope
  still publishes the field (the plan's G5 wording says "and `retry_after_s`" — the field is present
  on every failed row, its value is 0 when there is no wait to observe).

## 6. Route diagnostic (`compact: false`)

To see the route attempts the compact envelopes drop, one `search_items` call with `compact: false`:

```json
{ "query": "Tesla P4 8G", "pages": 1, "limit": 30, "compact": false, "attempts": 3, "timeout_s": 150 }
```

| field | value |
|---|---|
| `via` / `source` | `search_replay` / `search_api` |
| wall / `elapsed_ms` | 36.3s / 36,280 |
| `attempt_log` | page 1 `search_replay` ok, 30 items, **34,109ms**; page 2 `search_replay` ok, 30 items, 1,941ms |
| `pages_fetched` | 2 (30 kept at `limit: 30`) |
| `cache` | `hits 0`, `misses 2` |

The first replay page of a fresh process is the expensive one — the homepage replay page's warm-up
(measured 9.8s, 12.3s and 34.1s across this day's runs), after which a page is ~1.5–2.7s. That warm-up
is also why a run's first query is the one that most often falls back to `searchbox`.

## Route sensitivity and site state

The replay route was **accepted, refused and accepted again** within 40 minutes on 2026-11-07. The
runs in this file are all of it, in order:

| time (+05:00) | run | route mix | site state |
|---|---|---|---|
| 06:48 | single ×5 (run A) | 3 replay / 2 typed | replay did not settle on the first two calls; then 2.1–2.6s |
| 06:51 | six-query batch | 6/6 replay | healthy; 12.3s warm-up then 1.5–1.9s |
| 06:54 | twelve-query pass 1 | 12/12 replay | healthy; 41.3s |
| 06:56 | twelve-query pass 2 | 8 replay, then throttle | `RGV587_ERROR` rate limit; batch latched cooldown, 3 skipped |
| 07:02 | twelve-query two-pass `new_only` | 12/12 replay both passes | healthy again; 40.8s / 38.3s |
| 07:04 | nonsense isolation | 2/2 replay, nonsense `empty` | replay fine; nonsense took 49.2s to confirm zero |
| 07:06 | unsearchable isolation | 1 typed success | typed route got an empty shell (`no-search-input-on-homepage`) |
| 07:10 | single ×5 (run B) | 1 replay / 4 typed | replay refused; typed 15.1–110.9s |
| 07:16 | route diagnostic | 1/1 replay | replay answered, 34.1s first page + 1.9s second |
| 07:34 | twelve-query two-pass, final build | 24/24 replay | healthy; 54.8s / 52.2s |

What this means for reading the numbers: **the replay-route figures (2.1–2.7s a page, 20.6s for six
queries, 41.3s for twelve) are what the fast path delivers when goofish accepts it; the typed-route
figures (13.9–121.3s a query, 99–109s for six queries in the earlier task run) are what a run pays
when the site refuses it.** The batch answer never depends on the route: every row publishes `via`, and
a throttled query stops the list with per-row skip reasons (measured above).

## Before / after

| what | before this work | after (measured above) |
|---|---|---|
| one warm search, `pages: 1, limit: 60` | 13.6–40.5s typed (2026-09-29 and the reply-first run) | **2.1–2.7s** replay, 1.5–1.9s per page in a warm process |
| first call in a process | 20.9–40.5s (page load + typed search) | 9.8–34.1s (replay page warm-up), then replay speed |
| six two-page queries | 99–109s typed on a throttled run (Task 5) | **20.6s** replay, 240 listings, 152,739B |
| twelve two-page queries | not possible in one call before `search_batch` | **41.3s** (`a58a4d8`) / **54.8s** (`fbdf72b`), 12/12, 526/556 listings |
| a repeat scan | full payload again (`new_only` did not exist) | 13 new listings, **16,367B vs 351,167B** (21.5×) |
| one bad query in a list | the whole call failed | `status: "partial"`, per-row error, valid rows returned |
| response size | ~99KB for a 57-listing reply (spec, full output) | 40,238–43,562B for 60 compact listings, 629–636B/listing |

The one target this run did **not** meet is the typed fallback's ≤ 8s: measured 13.9–15.3s when the
fallback worked and 36.9–121.3s when the replay attempt had to time out first. The ≤ 3s target for a
warm single query is met on the replay route (median 2.575s in run A) and missed when the site forces
the typed route (median 15.3s in run B). Both are route facts about goofish on this IP, not something
this server can choose; the envelope's `via` is how a caller sees which one it got.

## Specs used

`/tmp/xianyu-final/specs/single.json` — five calls, `pages: 1`, `limit: 60`:

```json
[
  { "slug": "p100", "query": "Tesla P100 16G", "pages": 1, "limit": 60 },
  { "slug": "v100", "query": "Tesla V100 16G", "pages": 1, "limit": 60 },
  { "slug": "p40", "query": "Tesla P40 24G", "pages": 1, "limit": 60 },
  { "slug": "rtx3090", "query": "RTX 3090 24G", "pages": 1, "limit": 60 },
  { "slug": "ddr4-ecc", "query": "DDR4 ECC REG 16G 2400", "pages": 1, "limit": 60 }
]
```

`/tmp/xianyu-final/specs/twelve.json` — the six in `scripts/bench-spec.json` plus six from
`queries-gpu.json` (all `pages: 2`, `limit: 60`):

```json
[
  { "slug": "p100", "query": "Tesla P100 16G", "pages": 2, "limit": 60 },
  { "slug": "v100", "query": "Tesla V100 16G", "pages": 2, "limit": 60 },
  { "slug": "p40", "query": "Tesla P40 24G", "pages": 2, "limit": 60 },
  { "slug": "rtx3090", "query": "RTX 3090 24G", "pages": 2, "limit": 60 },
  { "slug": "x99", "query": "精粤 X99 主板 D4", "pages": 2, "limit": 60 },
  { "slug": "ddr4-ecc", "query": "DDR4 ECC REG 16G 2400", "pages": 2, "limit": 60 },
  { "slug": "v100-32g", "query": "V100 32G", "pages": 2, "limit": 60 },
  { "slug": "mi50-32g", "query": "MI50 32G", "pages": 2, "limit": 60 },
  { "slug": "2080ti-22g", "query": "2080Ti 22G", "pages": 2, "limit": 60 },
  { "slug": "p102", "query": "P102-100", "pages": 2, "limit": 60 },
  { "slug": "v100-sxm2", "query": "V100 SXM2", "pages": 2, "limit": 60 },
  { "slug": "t4", "query": "Tesla T4 16G", "pages": 2, "limit": 60 }
]
```

`isolation.json` — `zzzqqqxyz`, `Tesla P100 16G`, `Tesla V100 16G`, each `pages: 1`, `limit: 60`.

## Limits of this run

- One box, one IP, one afternoon. Wall-clock numbers on a shared 4-core machine with other clients
  on the same IP move; the route mix moved *within the run* (table above), which is the largest
  source of variance here.
- The twelve-query activation is 24 page fetches in one call. The project's benchmark rule asks for
  ≤ 20 live calls per run; the acceptance target itself is 12 queries × `pages: 2`, so this one run
  exceeds the guidance by four fetches. It was run once, sequentially, with no other live benchmark
  in flight.
- `price_drops` was `[]` in every run: the two passes of a scan are ~40s apart, and no seller in that
  window repriced below what the process had already read. Price-drop reporting is pinned by the
  history unit/integration tests, not by this live run.
- The 92.8s pass 2 is not a batch cost in the normal case — it is what a throttle costs. The batch's
  own budget (`timeout_s: 180`) bounded the call and the latch stopped it at eight answered queries
  instead of twelve attempts. Note that the per-query budget (60s) did **not** bound row 8: it took
  75.6s, because the replay attempt was awaited past the per-query deadline before the typed route
  ran into `RGV587`. A hung replay fetch can overshoot a query's budget by the fetch's own wait.
