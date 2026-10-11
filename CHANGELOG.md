# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## About this file

This repository was published from a working history that had already been squashed, so the entries
below are release notes rather than a commit log. There is no per-commit trail on `main` to generate
them from and no attempt is made to invent one -- `main` begins at a single squashed import of the
TypeScript port (`7ab7d6b`, 2026-09-30) and everything after it is a handful of deliberate commits.
From here on, each release gets a commit behind it and this file grows normally.

The Python implementation this is a port of is not in this history at all: it lives on the
`python-original` branch as a single commit (`cfe401d`, 2026-09-27).

## [0.3.0] — Unreleased

- Add a stable response schema, MCP error flags, structured diagnostics, retry hints, call deadlines
  including queue time, and build fingerprints on every tool response.
- Add price/location/title exclusions and conservative PCIe/SXM/bare-card filters to search. Normalize
  CPU model punctuation and Xeon/至强 title matching; explain unmatched tokens and related categories.
- Preserve partial search cards and opaque continuations, including cards omitted by small limits.
  Report observation age and recheck filters after full detail reads.
- Normalize numeric magnitudes and original prices/image counts on every listing route, including
  seller cards; retain raw text and distinguish approximate, range and negotiable prices.
- Start private Xvfb automatically when no display exists, and clean up in-flight launch on shutdown.
- Reject malformed success payloads and unsafe inventory counts. Stop known throttles immediately,
  enforce a visible process cooldown, and avoid redundant DOM polling of rejected API results.
- Publish effective limits, cap seller pages at 20 cards, and shorten tool descriptions.

## [0.2.1] — 2026-10-08

### Added

- **`search_items`'s `detail` reads two listing pages at a time, and says when it stops.** One page
  load per listing is the cost of `detail`, measured warm at a median of 13.4s (n=8, 8/8 answered) --
  about 4.5 minutes for 20 listings and 11 for the 50 a side-by-side comparison wants. Loading four at
  once was measured and not built, because it needed four DOM pages and the fan-out loop is
  `search_items`' own; the loop now has the pages, so it is built. Measured: 66.3s → 27.1s for four
  listings (2.4x, not 4x), at the price of each listing's *own* latency going 11.4s → 20.5s.
  - *Width two, not four.* The wider fan-out buys its throughput by making every individual answer
    slower, and the caller reads those per-listing milliseconds, not the batch. Four is where the
    measurement stops improving the per-listing figure at all, so it is also the hard ceiling on the
    pool (`DETAIL_POOL_MAX`), and `XIANYU_DETAIL_FANOUT` (0–4, default 2) moves the width below it.
  - *The guard, which is the other half of the measurement.* On a throttled site four-at-once answered
    0/4 where the serial walk of the same four still answered 2/4: batching turns a per-listing latency
    problem into an all-or-nothing one, and a partial answer is reportable here while a missing one is
    not. So the first fan-out batch that comes back with nothing at all turns the fan-out off for the
    rest of the call, and the remaining listings are read the old way. The check reads what goofish
    answered, not whether a listing came back -- a dead batch falls back to the search card this call
    already has, which would have read as `ok` for every listing and kept the fan-out running exactly
    when it was buying nothing.
  - *It never touches the shared page.* The pool is leased from the session (`Session.fanoutSurface`),
    one page and one mtop tap per slot, capped and refused rather than grown; the shared `domPage` is
    holding the search results the call is deepening. The lock is the one `search_items` already takes,
    so two searches' fan-outs cannot overlap and no other tool can name a slot.
  - *It is published, not asserted.* `detail_fanout` carries the width, the batches, how many listings
    came back out of one and whether it backed off; every listing in `detail_report` carries its own
    `ms`, its `via` (`fanout` / `serial`) and its `slot`. `XIANYU_DETAIL_FANOUT=0` is the exact serial
    walk that shipped before any of this.

### Fixed

- **A cache-served batch is no longer mistaken for a throttled site.** The fan-out's fallback turns
  the rest of a `detail` walk serial when a batch comes back with no answers at all, which is the
  signature of a site that has stopped replying. That test counted any answer, including one served
  from this process's own `search_card_cache`. So a batch answered entirely from cache read as "the
  site refused us", and the remaining listings were walked serially for no reason.
  `readFromGoofish` now requires an answer that came from goofish.

### About these two releases

`0.2.1` exists because `v0.2.0` was published and then its tag was moved, 18 minutes later, to a
later commit. The move was comment-only and its own release notes say so, so nothing `0.2.0`
advertised was wrong — but it means the commit the tag names is not the one first published. Rather
than move a published tag a second time, the difference ships here.

The fan-out entries below were originally written into the `0.2.0` section. They are not there now:
at the `v0.2.0` tag that section did not mention the fan-out at all, and it was neither in the
release notes nor in the tagged tree. The section above now matches what shipped under `0.2.0`
exactly, and this is where the fan-out is described, under the version that actually contains it.

## [0.2.0] — 2026-10-08

Released. The seller tools went in here rather than opening a 0.3.0 section, because 0.2.0 had never
been released and a dated section for it would have been claiming a release that did not happen.

### Added

- **`scripts/serve.mjs`, a launcher that will not start a server on a `dist/` it cannot vouch for.**
  Point an MCP client at it instead of at `node dist/index.js` and a stale deployment stops being
  possible rather than merely detectable. It compares the build's stamp against the checkout's HEAD at
  every spawn; if they disagree it rebuilds and starts the rebuilt server, and if the rebuild cannot
  produce a `dist/` matching the tree it exits nonzero and says which fact did not add up. There is no
  flag to skip it and no env var to bypass it.
  - *Why the spawn and not the pull.* The obvious chokepoint is a `post-merge` hook, and it is the
    wrong one: `git post-merge` does not fire on a fast-forward, and a deployed checkout is
    fast-forwarded. It would have missed precisely the case it was meant to cover while looking
    correct under test with a real merge. This server is a local stdio process spawned per session, so
    there is no restart event to hang a rebuild on and nothing anywhere notices a pull -- which makes
    the spawn the only point that ever sees both facts at once, the tree at commit X and the dist
    claiming commit Y.
  - *Why the pull is not made to fail.* It should not be. A pull has to be allowed to succeed, and the
    rebuild belongs where a stale `dist/` can be caught rather than where it has to be prevented. The
    loud failure is a failed start: one session lost, against every session in the drift window
    answering plausibly with nothing in their answers saying otherwise.
  - *What it costs when the build is already current.* About 40ms and no network, measured: one
    `git rev-parse`, a stat, a walk of `src/`, and no base ref -- so no `rev-list`, no fetch. The
    staleness rules are not restated here; `serveVerdict` lives beside `deployVerdict` in
    `src/build-info.ts`, and the full comparison -- base ref, fetch, how far behind main -- is
    `npm run check:deploy`, which the launcher runs only when it is about to rebuild.
  - *Three things it declines to do.* It does not treat an uncommitted tree as a stale `dist/` (that
    would rebuild on every spawn forever, since a rebuild of a dirty tree is itself stamped dirty), it
    does not treat a source file dated in the future as an edit made after the build (that would loop
    for as long as the clock skew lasted), and it writes nothing at all to stdout, which is the
    JSON-RPC channel.
- **A `typed` block and a `missing` list on every listing.** `browse_feed`, `search_items`,
  `related_items`, `item_view` and `recommendations` each publish, beside the fields they already
  returned, a `typed` object reading the same values as types -- `price_amount` as a number, epochs as
  ISO 8601, `location` as `{province, city}`, `shipping` as `{fee, free_shipping}`, the seller as
  `seller_stats` -- plus `missing`, naming every path inside `typed` that is `null`. Three rules make
  it usable: every key is always present, so the block does not change shape with the route that
  answered; a value the site did not render is `null` and named, never inferred from a sibling and
  never defaulted; and a `0` the site sent is a `0`, not a gap -- nobody wanting an item and nobody
  viewing it are facts.
- The extra listing fields those blocks read, which the page already loaded and the server dropped:
  the detail reply's `gmtCreate` / `gmtModified` / seller province, and the province, condition and
  transport fee on a search or feed card. The rendered item page exposes no epoch, province or fee,
  so on that route those stay `null` and named -- which is the honest answer rather than a thinner one.
- `seller_profile`: one seller's public profile, logged out -- display name, avatar, signature, credit
  tier (卖家信用极好), shop level and score, praise ratio, review count, follower and listing counts,
  and real-name / real-person / 芝麻 status. Pass `user_id` for a single mtop call, or `item_id` to
  mean "whoever is selling this listing", which costs one item page load and additionally returns
  the seller's city, tenure, sales count and positive rate. Passing both is refused rather than
  guessed, because a caller who passes both cannot see from the envelope which one was ignored.
  Fields the call could not fill come back null and are named in `fields_missing`.
- `seller_items`: the listings one seller currently has up -- the 宝贝 tab of their goofish profile,
  with title, price, category, photo, want count and the label strip, 20 a page, `has_more` from
  goofish's own `nextPage`. Same `user_id`-or-`item_id` choice as `seller_profile`. On a site with no
  ratings and no feedback threads, "what else does this seller have" is the whole of due diligence, and
  nothing in this server could answer it before.
- `item_view` reports the listing's `seller_id`, the hop from a listing to the seller behind it. Nothing
  else about the envelope changed: `fields_present` / `fields_missing` are driven by `ITEM_FIELDS`,
  which did not gain an entry.
- `XIANYU_SELLER_PROFILE_BUDGET_S`: wall-clock budget (5–600s, default 90) for the item-page hop the two
  seller tools make when given an `item_id`. A lookup by `user_id` runs no loop and spends none of it.
- The probe notes behind the above, so the next person does not have to redo them: `page.head` and
  `xyh.item.list` answer SUCCESS through the page's own mtop client **from a page that never calls
  them**, because goofish stamps only the calls its own bundle originates -- whereas `idle.pc.detail`
  and `idlemtopsearch.pc.search`, which the current page does call, answer `TIMEOUT::接口超时` when
  re-issued. That asymmetry is why response interception cannot reach a seller profile and a synthesised
  call can.
- `XIANYU_SEARCH_MAX_ITEMS`: a runtime ceiling on one `search_items` call, clamped to 30–300 and read
  per call like the budget overrides. It clamps both `limit` and how deep the pager walk goes (one
  page of 30 per 30 of the cap), so even `pages: 10, limit: 500` stops inside
  `XIANYU_SEARCH_BUDGET_S`. A test pins the walk stopping at the cap, and that the recommendation
  rail is still refused as results.
- This file, and a test that the version the MCP handshake advertises is read from `package.json`
  rather than written down a second time.
- **A TTL cache for the two answers worth remembering: one listing read in full, keyed by `item_id`,
  and one page of search results, keyed by `(query, page)`.** A repeat view no longer pays for an item
  page load (measured 4–10s), a re-paged search no longer re-clicks the pager (5–9.5s a page), and a
  search whose pages are all cached answers with no page, no keystroke and no mtop call at all
  (`via: "cache"`, `attempts: 0`). `capabilities` reports the cache before it is relied on.
  - **Staleness is published, never silent.** Every answer that can come from the cache carries a
    `cache` block -- `hit`, `age_s`, `stored_at`, `ttl_s`, the `key` it was looked up under, and a
    sentence saying whether goofish was asked -- on `item_view`, per pager page on `search_items`, and
    per listing in `detail_report`. A miss publishes the same block with null ages, so an envelope's
    shape never depends on which route answered. This is the same rule the `typed`/`missing` block
    already follows, applied to where the answer came from.
  - **The TTLs are 45s for a listing and 120s for a search page**, overridable with
    `XIANYU_CACHE_ITEM_TTL_S` / `XIANYU_CACHE_SEARCH_TTL_S`, with `XIANYU_CACHE=0` turning the whole
    thing off. Chosen against what is actually measured rather than for feel: goofish's own match
    counter for `x220` read 28,791 / 28,804 / 28,810 inside one session -- live inventory drifting
    ~0.07% -- which argues against a window of minutes, while the read being replaced costs 4–12s,
    which argues against a window shorter than the read. The two are split because the risks differ: a
    stale listing is a price on something that may have sold, while a stale search page is 30 listings
    being compared and the detail read is what re-checks liveness.
  - **`browse_feed` is deliberately not cached.** Two identical feed calls return completely disjoint
    inventory -- goofish serves each visitor a randomised slice -- so a repeat there is a different
    answer, not a stale copy, and caching it would replace sampling live inventory with re-sampling
    the same slice. The mtop-only tools cost 0.4–2.2s and have nothing to save either.
  - Only real reads are stored: a refused answer leaves the cache untouched, and the
    `search_card_cache` fallback is never written to it, because pinning a five-field card for the TTL
    would turn one degraded read into a window of them. Cached pages are pooled and judged by the same
    relevance guard as a live walk, so a cached answer cannot be a laxer one.
- **`capabilities` gained a `probe` argument, default `true`, so the freshness answer stops waiting
  for a browser.** The `build` block — which commit is answering, and is it behind `origin/main` — was
  assembled inside the same payload as the live browser/mtop probes, so a caller who wanted only "is
  this deploy current?" paid a measured 60-90s cold Chromium launch for an answer that is a pure
  function of the build stamp, the base ref and the checkout. A browser cannot change that answer,
  and on a wedged Chromium the wait was unbounded. One caller filed the server as hung; it was
  answering, slowly.
  - `probe: false` returns `build`, `cache` and the static payload immediately and never calls
    `getSession()`. Nothing about the default contract changed: `probe` defaults to `true`, so every
    existing caller still gets the live picture, and the default itself is pinned by the
    published-arguments invariant.
  - **The fast path cannot imply a probe it did not run.** `session_state`, `login_probe_ret`,
    `feed_reachable` and `browser_launches` come back `null` on the unprobed path, not `false`, and a
    new `probes` block names them under `not_measured`. `feed_reachable: false` would assert goofish
    did not answer when nobody asked — and a freshness gate trusting it would report a healthy server
    as unreachable. `null` is the same "could not measure" idiom `build.stale: null` already uses,
    and the distinction survives probe failure: `unknown` means a probe ran and could not tell, `null`
    means none ran.
  - Deliberately **not** a second tool, and not a two-stage answer within one call. A separate tool
    would be a second code path to staleness, and the two could disagree about whether a deployment
    is current — a worse bug than the latency. An MCP tool result is one-shot, so "freshness first,
    probes after" has to be two invocations. Both paths call the same `buildBlock()`, which is the
    same `src/build-info.ts` logic `npm run check:deploy` runs, so there is one staleness rule,
    tested once.

### Changed

- `search_items` defaults to 120 results instead of 60, and its published maximum is 300 -- the full
  pager depth -- instead of the shared 500. Depth is still two arguments: `pages` walks the pager and
  `detail` reads the top N in full, and both still ride the one shared dom page without relaunching
  the browser.
- Six tools now run on the parked api page rather than four. The lock rule is stated where it actually
  lives -- *the lock is taken where a navigating page is read* -- rather than as a list of tools, because
  `seller_profile` and `seller_items` are the case that breaks the list: mtop-only given a `user_id`,
  and one shared-lock item-page hop given an `item_id`, released before their mtop calls.
- **The session's first load is paid at boot, in the background.** The first item page of a session
  cost 12–21s and the first search 15–41s, all of it paid by whoever happened to ask first. A
  warm-up at startup now pays it on a page of its own, which shares the browser context's HTTP cache
  with the real pages and holds no lock, so nothing queues behind it. Measured across two runs of
  alternating fresh sessions (n=8 per arm, 15 of 16 calls answered): the first `item_view` fell from a
  median of 22.7s to 13.9s. It is fire-and-forget, every failure is caught and recorded rather than
  raised, each tool that needs a page still loads one for itself, and `XIANYU_NO_WARMUP=1` skips it.
  `capabilities` publishes the outcome under `cold_start_warm` -- `pending` for a session's first few
  seconds, `failed` if the warm-up lost, neither of which changes what any tool does.
- **A load goofish declines is now named in seconds instead of after a minute and a half.** Its
  risk-control page and its own error notice are 35 bytes of text with no mtop client and no detail
  call behind them, so the page is read for them at load time: the wait for an mtop client that can
  never arrive is skipped, and `item_view` stops after one load with the cause named instead of
  spending five. A page that is merely slow says nothing here, and the marker alone is not trusted
  without the emptiness -- 10 healthy loads were checked and none was mistaken for a refusal.
- The retry path was measured rather than assumed, and left alone: a plain reload of the document
  this session already has is not cheaper than the cache-busted load (6.3s against 3.9s to
  `domcontentloaded`, n=7 a side), so the nonce stays. The cold load a retry really pays is the
  session's first one, and that is now paid at boot.

### Measured boundaries of the two seller endpoints

Recorded here rather than only in `src/` because each of these is a thing a later change can silently
break, and every one was found by a live call rather than by reading the payload:

- `mtop.idle.web.user.page.head` takes `{userId}` and nothing else that helps. `encryptedUserId` alone is
  refused with `FAIL_BIZ_CLIENT_PARAM_INVALID` -- so the encrypted id a search card carries
  (`clickParam.args.seller_id`) is not a way in. Adding `self: false` or an empty `encryptedUserId`
  changes nothing. The id it wants is plain digits: `kcUserId` in its own reply, `sellerId` in a detail
  reply's `sellerDO`.
- Its `module.base.ipLocation` is **not** the seller's city. It is where goofish thinks the request came
  from: it answered `上海市` for a seller whose own listing record says `北京`. It is deliberately not
  published, and the seller's city comes from the listing's `sellerDO` instead.
- `mtop.idle.web.xyh.item.list` serves **at most 50 pages of 20** (page 50 `SUCCESS`, page 51 and pageSize
  30 both `FAIL_BIZ_FORBIDDEN::||最大可查看页数或者每页最大可查看商品数超限`), so `page` is bounded at 50 rather
  than at the shared 10,000. `totalCount` is always 0 and is never published; `nextPage` is the field that
  works.
- A page past the end comes back `SUCCESS` with **`cardList` absent**, not empty. That is `count: 0`, not a
  shape change -- the first version raised a `ParseError` on `page: 2`, which is the most ordinary call
  there is.
- Free shipping arrives in the label strip as a bare `content: 'freeShippingIcon'` with no text, so the
  `/Icon$/` filter the `fishTags` reader already used has to apply here too. Without it the first live run
  shipped `"freeShippingIcon"` as a fact about a listing.
- A seller that is not there is `FAIL_BIZ_USER_NOT_FOUND` from `page.head` and
  `FAIL_BIZ_NOT_FOUND::||对方账号不存在` from `xyh.item.list`. Both raise `DetailUnavailableError` rather than
  a throttle, because the two are different facts and a caller cannot tell them apart without the ret.

### Not added, and why

The bead this work came from offered four candidates for a second tool. Three of them were measured
against the live site and would have had to invent data, so they are recorded here rather than faked:

- **`category_items`** -- the homepage feed answers `cCatId`, `channelId`, `catId` and `bizParam` with
  `SUCCESS` and 20 cards, but two identical `{pageNumber: 1}` calls return completely disjoint
  inventory and no category filter narrows anything. The endpoint that *does* take `cCatId` is
  `idlemtopsearch.pc.search`, which this server cannot issue at all (`TIMEOUT`).
- **`area_search`** -- the match counter takes `userPositionJson`, and five spellings of it (city only,
  city + lat/lon, `ipLocation`, a far-away city) all returned the identical `hitnum`. The apparent
  difference in an earlier probe was the counter's own drift.
- **`favorites` / `saved`** -- a logged-out visitor has no saved set to read, and the tool-name invariant
  refuses anything matching `favou?rite` as a write tool.

`seller_items` is what shipped instead of a category filter: it fills the same agent gap ("show me more
from this source") off an endpoint that was verified answering anonymously.

### Removed

- **Eleven throwaway probe scripts, from the repo root.** `probe.mjs` and `probe2.mjs`–`probe11.mjs` were
  scratch scripts — each one drives Chromium against the live site to answer a single question, and
  several import `./src/*.ts` directly rather than the built `dist/`. They were working notes that got
  committed, and a root full of `probe*.mjs` reads like tooling: the next person edits one, runs it
  against the live site from a checkout they did not intend to touch, and lands it again.
  - *The measurements are not lost with them, which is the only reason this is safe.* Every number a
    probe produced is written down in this file — the cold-start medians, the reload-versus-cache-bust
    comparison, the detail-route latencies, the seller-endpoint boundaries above — because that is where
    a later change can read it and notice it broke something. The scripts themselves stay in git history
    for anyone who wants to re-run a measurement; what leaves the tree is the copy on `main`.
  - *The three comments that cited them by filename now cite the measurement instead.* `reloadFresh` and
    the boot warm-up still carry their sample sizes and medians (`n=7 a side`, `12.4s`), and the SPA
    route note still carries `0/8 answered in 32s` — a comment that points at a file the reader cannot
    open is a worse version of the same sentence.
  - `.gitignore` now ignores `/probe*.mjs` at the root, so a probe stays where a probe belongs.

### Fixed

- The MCP handshake advertised a hardcoded `0.1.0` while `package.json` carried its own copy of the
  same number. Nothing compared them, so a `npm version` bump would leave every client being told the
  previous release existed. The entry point now reads `package.json` at startup.

## [0.1.0] - 2026-10-01

First public release. `v0.1.0` is the tag; it points at `9b5b656`.

### Added

- Eight read-only tools -- `capabilities`, `browse_feed`, `search_count`, `search_suggest`,
  `search_items`, `related_items`, `item_view`, `recommendations` -- over goofish.com with no Xianyu
  account, no cookies, no stored credentials and no write path.
- Reads goofish's own `window.lib.mtop.request` from the page rather than re-implementing token
  minting and request signing, which is the whole reason a browser is involved.
- `item_view` and `search_items` read the calls the page makes for itself, and `search_items` refuses
  to return the recommendation rail as results.
- A two-page browser session: four mtop-only tools get a parked page of their own so they never queue
  behind a 70s search, and only the three DOM tools take the shared-page lock.
- Windowed Chromium by default, because headless is served goofish's risk-control page instead of the
  app. `XIANYU_HEADLESS=1` overrides it, and `XIANYU_BROWSER_PATH` supplies a specific binary.
- Wall-clock budgets for the three retry loops, via `XIANYU_SEARCH_BUDGET_S`,
  `XIANYU_ITEM_VIEW_BUDGET_S` and `XIANYU_RECOMMENDATIONS_BUDGET_S`.
- 58 hermetic tests: no network, no browser, driven through a fake session.
- CI on push and pull request, pinned to Node 22.18 -- the floor for unflagged type stripping.

### Changed

- `playwright` moved from `dependencies` to `optionalDependencies` and is imported dynamically inside
  `launch()`. Module load drops from ~4.0s to ~30ms, and a missing browser is now a launch-time
  `BrowserError` carrying the install hint instead of a `MODULE_NOT_FOUND` at startup.

### Notes

- The published tarball ships prebuilt `dist/`. Node refuses to strip TypeScript types from files
  under `node_modules/`, so shipping `src/*.ts` would install cleanly and then fail on first run.
- `npx playwright install chromium` is still required: playwright has no install script, so `npm ci`
  does not fetch a browser.
- Endpoint knowledge, the search-relevance rules and the item/search extractors derive from
  [fancyboi999/goofish-cli](https://github.com/fancyboi999/goofish-cli), credited in `NOTICE`.
