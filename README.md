# xianyu-mcp

[![ci](https://github.com/alperien/xianyu-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alperien/xianyu-mcp/actions/workflows/ci.yml)

xianyu-mcp is a read-only MCP server for Xianyu (闲鱼, Goofish). It needs no Xianyu account: no
cookies, no login, no stored credentials, and no tool that writes anything.

TypeScript, run straight by Node. Unflagged type stripping landed in 23.6 and was backported to
**22.18**, so that is the floor: on 22.6–22.17 `node src/index.ts` and `node --test` both fail with
`ERR_UNKNOWN_FILE_EXTENSION` unless you add `--experimental-strip-types`. A checkout runs from
`src/`; `npm run build` emits `dist/` for the published tarball, prebuilt because Node will not strip
types from files under `node_modules/`.

It drives its own throwaway Chromium with Playwright and reads goofish the way an anonymous visitor's
browser does -- including calling goofish's own JS client (`window.lib.mtop.request`) rather than
re-implementing token minting and request signing, which is the whole reason a browser is involved.

It launches **windowed**, and needs a display (`DISPLAY=:0`, or Xvfb). That is a measurement, not a
preference: [headless gets served goofish's risk-control page](#headless-vs-headed) instead of the app.
It never clicks anything in the page, and [the login dialog is left alone on purpose](#the-login-dialog-is-left-alone-on-purpose).

## Install

From a clone:

```bash
npm install                      # deps: @modelcontextprotocol/sdk, zod
npx playwright install chromium  # or point XIANYU_BROWSER_PATH at a Chrome/Chromium binary
```

`playwright` is an *optional* dependency and is loaded the first time a browser is actually launched,
not at startup. That keeps it off the critical path: the server reaches MCP-ready in ~30ms instead of
paying ~4s for the import, and a tool call that never needs a Chromium never pays for one. If
playwright is missing entirely, the failure is a launch-time error naming the browser, not a
`MODULE_NOT_FOUND` at startup.

As a dependency (`npm install xianyu-mcp`), the published tarball is prebuilt -- `dist/` -- and
`npx playwright install chromium` is still needed. The build exists because Node refuses to strip
TypeScript types from files under `node_modules/`, so shipping `src/*.ts` would install fine and then
fail on first run.

Requires **Node 22.18+** (the server runs TypeScript directly, natively). It launches a windowed
Chromium, so it needs a display. On a machine with no monitor, run it under a virtual one:

```sh
# Debian/Ubuntu: sudo apt install xvfb    Arch: sudo pacman -S xorg-server-xvfb
xvfb-run -a node src/index.ts          # or point your MCP client at this command
```

This recipe is not yet run end to end on a headless host; if it fails, the error is from Chromium, not the server.
See [Headless vs headed](#headless-vs-headed) for what `XIANYU_HEADLESS=1` costs you.

## MCP client config

```json
{
  "mcpServers": {
    "xianyu": { "command": "node", "args": ["/path/to/xianyu-mcp/dist/index.js"] }
  }
}
```

Pointing a client straight at `dist/index.js` means nothing checks that this `dist/` is the build of
the checkout it sits in. `scripts/serve.mjs` does, at every spawn:

```json
{
  "mcpServers": {
    "xianyu": { "command": "node", "args": ["/path/to/xianyu-mcp/scripts/serve.mjs"] }
  }
}
```

It compares the build's stamp against the checkout's HEAD. If they disagree -- a `git pull` that
fast-forwarded without rebuilding, which is the case that ran unnoticed for nine commits and then again
for thirteen minutes after being fixed -- it runs `npm ci && npm run build` and starts the rebuilt
server. If that cannot produce a `dist/` matching the tree, it **refuses to start** rather than
serving one it cannot vouch for: a loud failure costs one session, while a silently stale dist costs
every session in the drift window and none of them can tell which ones those were. There is no flag to
skip the check and no env var to bypass it, on purpose. A spawn where the build is already current
costs about 40ms and no network; everything it prints goes to stderr, because stdout is the
JSON-RPC channel.

The gate is the spawn because it is the only point that sees both facts at once: there is no
long-lived process here, so a pull into the checkout is never noticed by anything. `git post-merge` is
not the alternative -- it does not fire on a fast-forward, which is exactly the pull this is for.

For a clone only. The published tarball ships `dist/` and no `src/`, has no checkout to be stale
against, and does not include `scripts/`, so `dist/index.js` is the right thing to point at there.

`npm run check:deploy` asks the same question on demand and prints the whole comparison -- which commit
is answering, which base it was compared against, how far behind it is. The launcher asks the narrower
half of it (is this `dist/` the build of *this tree*) because that is the half a rebuild can fix; the
full answer, base ref and fetch included, is what it runs when it has to rebuild.

| Env var | Default | Purpose |
|---|---|---|
| `XIANYU_BROWSER_PATH` | Playwright's Chromium | use a specific Chrome/Chromium binary |
| `XIANYU_HEADLESS` | `0` (windowed) | `1` runs headless. Headed is the default because goofish serves headless Chromium its risk-control page instead of the app -- see [Headless vs headed](#headless-vs-headed). Needs a display (`DISPLAY=:0`, or Xvfb). |
| `XIANYU_SEARCH_BUDGET_S` | 90 | wall-clock budget for the `search_items` retry loop (5–600s) |
| `XIANYU_ITEM_VIEW_BUDGET_S` | 90 | wall-clock budget for the `item_view` retry loop (5–600s) |
| `XIANYU_SELLER_PROFILE_BUDGET_S` | 90 | wall-clock budget for the item-page hop `seller_profile` / `seller_items` make when given an `item_id` (5–600s). A lookup by `user_id` runs no loop and spends none of it |
| `XIANYU_SEARCH_MAX_ITEMS` | 300 | ceiling for one `search_items` call, in listings -- clamps both `limit` and how deep the pager walk goes (30–300), so a huge walk stays inside `XIANYU_SEARCH_BUDGET_S` |
| `XIANYU_DETAIL_FANOUT` | 2 | how many listing pages `detail` loads at once (0–4), `0` reads them one at a time -- see [the detail fan-out](#detail-reads-two-listings-at-a-time-and-says-when-it-stops) |
| `XIANYU_CACHE` | `1` | `0` turns the item-detail / search-page cache off entirely, no restart -- see [the cache](#repeat-views-are-cached-and-the-cache-says-so) |
| `XIANYU_CACHE_ITEM_TTL_S` | 45 | how long a listing read in full may be served again (1–600) |
| `XIANYU_CACHE_SEARCH_TTL_S` | 120 | how long one page of search results may be served again (1–600) |

The budget bounds the *loop*, not the call. It is checked between attempts, so a page load already in
flight runs to completion: at the 90s default and a 10–25s load you get several attempts, and a call
can overshoot its budget by roughly one page load.

The server runs windowed and needs a display. goofish serves headless Chromium its risk-control
page instead of the app, which leaves the three DOM tools with nothing to read, so headed is the
default and a headless machine needs `xvfb-run` or an X server. The mtop-only tools work either way.

## Tools

Every tool returns `{"ok": true, "data": …}` or `{"ok": false, "error_type": …, "message": …}`.
`error_type` is the class name, and the list is exhaustive: `BrowserError`, `GatedError`,
`SearchUnavailableError`, `DetailUnavailableError`, `ParseError`, `NavigationError` or `XianyuError`,
plus `Error` for a throw that is none of ours (a test pins the list against the classes in `errors.ts`).
Calls are serialised: one browser, one page, so two tools in flight cannot navigate each other out of
their own data.

| Tool | Args | Key return fields |
|---|---|---|
| `capabilities` | `probe` (bool, dtrue) | with `probe: true` (the default): `session_state` (`unexpectedly_logged_in` / `logged_out` / `unknown`, where `logged_out` only comes from a ret that actually names the session or token, so a rate limit or a timeout reads `unknown` rather than proving anonymity), `login_probe_ret`, `feed_reachable`, `probes` (`ran`, `measured`, `not_measured`), `cache` (`enabled`, the two TTLs, how many listings and search pages are held), `works_without_account`, `anonymous_flakiness`, `notes`, `note`, `browser_launches`, and a `browser_error` / `login_error` / `feed_error` per probe. Never raises, not even if the browser is gone. **With `probe: false`** the same static payload and `build` / `cache` come back immediately, no browser launched, and the four live-probe keys are `null`; see [which build is answering](#which-build-is-answering-and-is-it-current). |
| `browse_feed` | `page_number` (1–10000, d1), `pages` (1–25, d1), `limit` (≤500, d60) | `items[]` of `rank, item_id, title, price, original_price, city, seller, want_count, image_count, image_urls, is_video, category_id, url`; `page_reports`, `raw_cards`, `unique_items`, `count`, `source: homepage_feed`. Every item also carries `typed` + `missing`; see [the typed block](#the-typed-block-every-listing-carries) |
| `search_count` | `query` | `match_count`, `has_matches`, `source: filter_hitnum`. Zero is an answer, not an error, but only when the site said zero: a `hitnum` that is missing, null, a string or carries a thousands separator is a `ParseError`, never `match_count: 0`. |
| `seller_profile` | `user_id` **or** `item_id` (exactly one) | `display_name, avatar_url, signature, seller_credit, buyer_credit, level, level_score, praise_ratio, review_count, listings_count, ratings_count, followers, following, verified_real_name, verified_real_person, verified_zhima`, plus `city, tenure_years, items_sold, items_listed, positive_rate, reply_rate_24h, last_active` **only when given an `item_id`**, `profile_url`, `item_id`, `fields_present` / `fields_missing`, and `source`: **`idle_user_page_head`** (given a `user_id`, one mtop call, no page load) or **`item_detail+idle_user_page_head`** (given an `item_id`, one item page load). A seller that does not exist raises `DetailUnavailableError`; a throttle raises `GatedError`. See [seller tools](#the-two-seller-tools). |
| `seller_items` | `user_id` **or** `item_id` (exactly one), `limit` (d20), `page` (1–50, d1) | `items[]` of `rank, item_id, title, price, category_id, want_count, tags, image_urls, url`, `has_more` (from goofish's own `nextPage` -- walk `page`, do not assume 20), `raw_cards`, `count`, `profile_url`, `source: idle_xyh_item_list`. An empty shop and a page past the end are both `count: 0`, not an error; a payload carrying none of the endpoint's own keys is a `ParseError`. goofish serves at most 50 pages of 20, so walk `has_more` rather than asking for a page number up front. |

## The two seller tools

`seller_profile` and `seller_items` answer the two questions about a seller that nothing else here can:
what their standing is, and what else they have for sale. On a marketplace with no ratings and no
feedback threads, that is the whole of due diligence.

Both take the same choice, and it is a choice about cost:

| you pass | what it costs | what you get |
|---|---|---|
| `user_id` | **one mtop call, no page load** | the standing: credit tier, shop level and score, praise ratio, review count, followers, listing count, identity checks |
| `item_id` | **one item page load** | the standing *plus* the seller's city, tenure, sales count and positive rate -- and `seller_items` means that listing's seller |

Passing both is refused rather than one quietly winning: a caller who passes both has no way to see from
the envelope which one was ignored. Passing neither gets the same treatment. The four fields in the
bottom row are named in `fields_missing` when you passed a `user_id`, because the profile endpoint has
no answer for them at all and a blank there would read as "this seller has no history".

The profile endpoint is reached in a way worth knowing. `mtop.idle.web.user.page.head` is the
endpoint goofish's own `/personal?userId=` page calls, and this server reads it by *issuing* it through
that page's own mtop client -- from a page that never makes the call. That works, and it is the opposite
of what happens with `mtop.taobao.idle.pc.detail`:

| endpoint | the page calls it? | issued by this server |
|---|---|---|
| `mtop.taobao.idle.pc.detail` (item detail) | yes | **`TIMEOUT::接口超时`** |
| `mtop.taobao.idlemtopsearch.pc.search` | yes | **`TIMEOUT::接口超时`** |
| `mtop.idle.web.user.page.head` (seller profile) | no | **`SUCCESS::调用成功`** |
| `mtop.idle.web.xyh.item.list` (seller's listings) | no | **`SUCCESS::调用成功`** |

goofish stamps a per-call anti-bot blob onto the requests its own bundle originates, and a request we
synthesise does not carry it. So for an endpoint the current page happens to use, the only honest route
is to let the page make the call and read the reply off the wire -- which is what `item_view` and
`search_items` do, and what the seller tools do for the one hop they cannot avoid. For an endpoint the
page never uses there is nothing to stamp, so the same client answers directly. Response interception
can only ever report a call the page already decided to make, which is why a seller profile was not
reachable before and is now.

That asymmetry is also why `seller_profile` given an `item_id` still costs a page load: the seller of a
listing is behind `mtop.taobao.idle.pc.detail`, and no feed or recommendation card carries a seller id
(measured -- the recommend endpoint's cards have no `user` or `detailParams` at all). So the hop reads
the item page's own detail reply, under the shared-page lock, and releases it before the profile call.

One field is deliberately not published. The profile payload carries `module.base.ipLocation`, which
reads like the seller's city and is not: it is where goofish thinks *this request* came from. Measured,
it answered `上海市` for a seller whose own listing record says `北京`. Publishing it would put a wrong
city in the field an agent would most trust it in. The seller's city comes from the listing's detail
record, which is why it is in the bottom row of the table above.

## The login dialog is left alone, on purpose

goofish puts a full-page login dialog in front of anonymous visitors: an `ant-modal-mask` (z-index 1000)
and an `alibaba-login-box` passport iframe. **It does not gate anything, and closing it is not what makes
search work.** This server used to claim the opposite -- "it must be closed or the page renders zero
cards" -- and to click its close controls after every navigation. That was backwards, and it made
`search_items` decline on essentially every attempt.

An A/B, headed, same URL, one fresh context per arm:

| arm | t+6s | t+12s | t+18s | t+24s |
|---|---|---|---|---|
| no dismissal | 0 cards | **30 cards**, real X220 matches (`联想ThinkPad X220，12.5寸黑色…`) | 30 | 30 |
| dismiss at t+6s | 0 | 0 (4 elements clicked) | 0 | 0 |
| dismiss at t+12s | 0 | 0 | 0 (4 clicked) | 0 |

The cards are in the DOM *underneath* the mask the whole time; clicking the close controls put the page
into a state where the result list never rendered and the 猜你喜欢 rail was served instead.

So nothing here clicks the page at all. Both scrapers work off `querySelectorAll` and `innerText`, which
see straight through an overlay -- measured directly: on an item page the `为你推荐` rail rendered and was
read with `ant-modal-mask` still up, and `bottomLead` -- the fixed full-width "登录后可以更懂你…
立即登录" bar at z-index 999 -- was up in the same samples without changing the card count. It sits at the
bottom of the viewport and would cover the last row for a real user clicking around; it covers nothing
that is read. A test pins this: a search page with the dialog and four clickable close controls wired to
a tripwire still returns its matches, and the tripwire has to stay quiet.

A real logged-out user does see a first popup at ~7s, a second one later, and reports that closing them
makes results appear. That is a real-browser-profile observation and this code is not it, so it is
recorded and not designed around. The one thing measured here is that the click, on this client, is
harmful.

## Search is a keystroke, not a URL

`search_items` does not navigate to `/search?q=`. It loads goofish's **homepage**, finds the SPA's own
header search input, focuses it, types the query and presses Enter -- and the results it returns are the
search call the page makes for itself, read off the wire. That call cannot be re-issued by this server:
`mtop.taobao.idlemtopsearch.pc.search`, with the payload the page itself sent, answers
`TIMEOUT::接口超时` when it is, for the same reason item detail does (see
[item_view](#item_view-reads-the-calls-the-page-makes)). Letting the page ask is the only route, and
it is the richer one: 30 structured results per query, each with a price, a want count, a city and a
photo, where the DOM card this used to scrape could see a title and little else.

This is measured, not preferred. A 2x2x2 matrix -- headed/headless x fresh/persistent profile x
direct-URL/search-input, one fresh browser per cell -- returned results from exactly one cell:

| cell | cards | cards whose titles contain the query | outcome |
|---|---|---|---|
| headed, fresh, **typed into the input** | 30 | 30 | results |
| headed, fresh, `/search?q=` | 20 | 0 | 猜你喜欢 rail |
| every direct-URL cell, headed included | 20 | 0 | 猜你喜欢 rail |
| headless, all cells | 20 | 0 | risk-control page |

So a direct-URL search on this client returns the recommendation rail, not results, and no amount of
retrying fixes it. The first three attempts type; the last is the one direct-URL navigation, kept so a
refusal can quote a real page rather than a guess -- it is expected to be refused, and is reported as
what it is.

### Depth: `pages` and `detail`

`compact: true` on `search_items` returns each item as one pipe-separated line (rank, id, price, want count, city, seller, first three tags, title) instead of an object. It costs a fraction of the tokens, so use it to scan a large result set, then ask for `detail` or `item_view` on the shortlist. The default is unchanged.

One search reply is 30 listings, and the search API cannot be re-issued -- replaying the page's own
payload through the same client answers `TIMEOUT::接口超时`, for the same anti-bot reason item detail
does. Scrolling the results page does not paginate. So the only way past 30 is the page's own pager,
which this server clicks: a DOM `click()`, not a Playwright pointer click, so the login dialog's
`ant-modal-mask` cannot intercept it the way it eats every other click here. It is the search page's
own pagination control, not a dialog dismissal.

Measured: **30 new listings per page, 5–9.5s, zero overlap**, against 13–25s for a fresh page load.

How many of a page's 30 actually match is not 30. goofish's ranking drifts between requests, so
across three separate sessions `pages: 2` gave **25, 28 and 55** matches of 60 scanned, and a page
three sometimes returned items already seen on pages one and two. `pages` is therefore a floor, not a
ceiling: if the pages it walked leave fewer than `limit` matches, up to two more are walked. That bounds
a thin market at about 14s extra rather than letting a degraded page silently under-deliver -- and
`pages_fetched` and `count` are both in the envelope, so what you actually got is never a guess.

| | scanned | matches | time |
|---|---|---|---|
| `pages: 1` | 30 | 24–26 | 27s |
| `pages: 2` | 60 | 25 / 28 / 55 | 21–36s |
| `pages: 4` | 90 | **81–82** | 19–36s |

`detail: N` reads the top N of the ranked results in full -- description, every photo, and the seller
with their city, tenure, sales count, rating, reply rate, signature and 芝麻 status. It is **one page
load per listing -- measured at a median of 13.4s warm** (n=8, 8/8 answered: 4.5s to `domcontentloaded`,
then goofish's own detail call lands 9–17s after that) -- and `item_view` cannot skip it: an SPA route
change is not available at all (0/8 answered in 32s, because the item page is a micro-frontend with no
reachable router and no item links to click). What `detail` *can* do is stop loading them one after
another. See [the next section](#detail-reads-two-listings-at-a-time-and-says-when-it-stops).

**`search_items("thinkpad x220", pages: 2, limit: 50, detail: 50)`, measured:**

| | |
|---|---|
| 50 listings, **50 read in full, 0 failures** | 410s and 548s on two runs (374s / 506s of it detail) |
| 39 fields per listing, 50 descriptions | 45–46 of 50 with a seller rating on file |
| 246–247 photos, price ¥80–¥499.9, median ¥228–248 | 104–108 KB of JSON, the token cost |

The card fields are the reason `detail` is optional. Every listing in the reply already has a price, a
want count, a city, the seller, their avatar, a photo and the tag strip (free shipping, price drop,
seller credit) -- all free, because it is in the reply we already had. The seller was the visible gap:
a search card's name is `exContent.userNickName`, and reading `userNick` -- which does not exist on a
search card -- left every search result with an empty seller. So ask for `detail` only on the shortlist
you want in depth, not on all fifty.

`detail_report` is published for exactly this reason: it names every listing by id, whether it
answered, from which route, and what goofish said when it did not. A listing that will not answer
falls back to the search card rather than being dropped, and says so in `detail_source` -- a shorter
list is fine, a dishonest one is not.

### `detail` reads two listings at a time, and says when it stops

Four pages loading four listings at once takes the batch's wall clock from **66.3s to 27.1s** -- 2.4×,
not 4× -- and costs something the wall clock hides: each listing's *own* latency goes **11.4s →
20.5s**. On a site that was throttling the anonymous IP the same four-wide run answered **0/4**, where
the serial walk of the same four still answered **2/4**. So the second number is the one that decides
the shape: batching turns a per-listing latency problem into an all-or-nothing one, and on a
read-only server a partial answer is reportable while a missing one is not.

So `detail` does it anyway, bounded and guarded:

| | |
|---|---|
| **width** | 2 at a time (`XIANYU_DETAIL_FANOUT`, 0–4), each on a page of its own -- **never** the shared page, which is still holding the search results the call is deepening |
| **the pool** | leased from the session and capped at `DETAIL_POOL_MAX`; a slot past it is refused rather than opened, because a pool that grows on request is a pool nobody measured |
| **the guard** | the first batch that comes back with *no* answer at all turns the fan-out off for the rest of the call, and the rest is read the old way -- one load at a time on the shared page |
| **the report** | `detail_fanout` says the width, the batches, how many listings came back out of one, and whether it backed off; every listing in `detail_report` carries its own `ms`, its `via` (`fanout` / `serial`) and its `slot` |

The guard reads what **goofish** answered, not whether a listing came back at all -- a throttled batch
fails every page and falls back to the search card this call already has, which is `ok` for every
listing. A check on `ok` would have kept the fan-out running exactly when it was buying nothing. It
also means a batch of two listings that are both simply gone reads the same way and backs the fan-out
off: serial is the slow, conservative route, so the cost of a wrong guess is a slower `detail`, never a
listing that was never read.

**This costs nothing for anyone who does not ask for it.** `detail: 0` is unchanged, `detail: 1` leases
one page, and `XIANYU_DETAIL_FANOUT=0` is the exact serial walk that shipped before any of this -- the
same pages, the same report, the same envelope.

**What it costs, measured.** The 50-listing run above (410s, then 548s) was the serial walk; the
fan-out's own measurement is 66.3s → 27.1s for four listings, and its width here is half that, so a
`detail: 50` on a healthy site should land well under the serial number -- but the honest reading is
that this is a speed-up worth measuring on *your* site, not a new constant: `detail_fanout.batches` and
every listing's own `ms` are in the envelope, which is how you check whether the guard fired and what
it actually bought. Budget 6–11 minutes on 50 if it falls back.

A query matches by its terms, in any order. That is not a detail. goofish titles are in whatever
word order the seller typed, and Chinese has no spaces to learn word boundaries from, so an exact
substring test rejects nearly everything on this site. Measured, before this was fixed: a search for
`机械硬盘4t` -- 70,146 listings by goofish's own counter -- returned *nothing*, because the titles say
`西数4T机械硬盘`; `i350网卡` failed because titles say `Intel i350 网卡`. The query is split at
whitespace and at every CJK↔Latin boundary (with a bare number and its unit kept together, so
`显示器24寸` is `显示器` + `24寸`), and a listing matches when its title carries *all* of the terms in
any order. The rail is still refused: a page full of bicycles does not contain `机械硬盘` and `4t`
together. `matched_by` reports `phrase` when the strict and loose rules agreed and `all_terms` when
the loose one admitted the set on its own.

Only the first search of a session pays for a page load. If the dom page is already showing
results, the next query is typed into the header input *there* -- an SPA route change, measured 13–15s
against 21s for a cold load. The input is selected-and-retyped rather than appended to, because on a
warm page it still holds the previous query and `thinkpad x220` + `ipad air` submits as one nonsense
keyword that legitimately finds nothing. That was a real bug the warm path introduced, and the
relevance guard is what surfaced it rather than a plausible-looking result set.

The input is focused, not clicked. goofish's login dialog puts an `ant-modal-mask` over the header,
and Playwright's click actionability check times out against it (measured: a 10s timeout with the element
resolved but never receiving the event). `focus()` needs no pointer, and the keystrokes that follow are
what the SPA's form listens for.

Typing is verified rather than assumed. The SPA re-renders that input under the cursor, and a
`keyboard.type` burst spanning a re-render is silently truncated -- measured, `thinkpad x220` landing as
`th`, which then submitted a near-empty keyword and served the rail. The input is read back after
typing and whatever did not land is re-sent; a query that still will not take is reported as
`incomplete-keystrokes` rather than as a decline.

The homepage is a 512-character footer-only shell for 8–14s before the app mounts, so "no input yet" is
the normal state for the first ten seconds and is polled, not treated as a verdict. After Enter the
router needs ~12s, and the SPA destroys the execution context on the way -- a lost context is waited out,
because it is the navigation landing rather than a failure.

## Repeat views are cached, and the cache says so

Two answers here are expensive enough to be worth remembering: **one listing read in full** (an item
page load, measured 4–10s) and **one page of search results** (a page load plus 5–9.5s for each pager
step past the first). Both are cached in the process for a TTL, so the ordinary loop -- search, open
what looks interesting, open it again, page deeper -- pays for the page load once.

A search whose `(query, page)` set is already cached answers with **no page, no keystroke and no mtop
call at all**: `via: "cache"`, `attempts: 0`. A deeper walk reuses the pages it already has and clicks
only the new ones. `detail` is unaffected by where the cards came from -- a cached search still reads
its top N in full, from the listing cache where it can and from goofish where it cannot.

Nothing else is cached, and one thing deliberately is not. `browse_feed` is not: two identical
feed calls return completely disjoint inventory -- goofish serves each visitor a randomised slice -- so
a repeat call there is a *different answer*, not a stale copy of the first, and caching it would swap
"sampling live inventory" for "re-sampling the same inventory". The mtop-only tools cost 0.4–2.2s and
have nothing to save.

The rule that shaped the cache: a cached answer may never be indistinguishable from a live one. This
server scrapes a marketplace where a listing can be sold, delisted or repriced between two calls, and
a cache that serves a stale price is worse than a slow answer. So every answer that *can* come from the
cache publishes where it came from -- on `item_view`, per pager page on `search_items`, per listing in
`detail_report`, and in `capabilities` before you have relied on any of it:

```jsonc
"cache": {
  "hit": true,                 // false on a miss, with the same keys -- the shape never changes with the route
  "key": "item:809806779491",  // or "search:thinkpad x220#2" -- what it was looked up under
  "age_s": 12.4,               // whole seconds, as a float; "0" would read as "just now" when it may be 0.4s
  "stored_at": "2026-10-05T18:04:11.204Z",
  "ttl_s": 45,
  "note": "this listing was served from this process's own cache, 12.4s old (TTL 45s): goofish was not asked, so this listing may have been sold, repriced or edited since. Re-read it with XIANYU_CACHE=0, or after the TTL."
}
```

A search publishes one line per pager page (`cache.pages[]`, with `hits` / `misses`), because a walk
whose pages were read at different moments is the normal case and one age for the whole set would be a
claim about a set that does not exist.

The TTLs are 45s for a listing and 120s for a search page, overridable per process with
`XIANYU_CACHE_ITEM_TTL_S` and `XIANYU_CACHE_SEARCH_TTL_S`, and `XIANYU_CACHE=0` turns the whole thing
off -- no restart, no code change, for a caller who would rather pay the 8s than reason about a TTL.

They are not numbers that looked reasonable. Nobody here has measured how fast an individual Xianyu
listing sells, and this does not invent one. What the measurements do say is that the market turns over
*inside a session* -- goofish's own match counter for `x220` was read at 28,791 / 28,804 / 28,810 across
one session, a live-inventory count drifting ~0.07% -- which argues against a window of minutes; and
that what the cache replaces is expensive (4–10s a listing, 4–12s a warm search, 5–9.5s a pager page),
which argues against a window shorter than the read it replaces. The two are split because the risks are
not the same: a stale *listing* is a price on something that may since have been sold, which is the
harmful case; a stale *search page* is 30 listings being compared against each other, none of which is
being transacted, and the liveness of any one of them is exactly what a detail read re-checks.

Only real reads are stored. A refused answer leaves the cache exactly as it found it, and the
`search_card_cache` fallback -- the degraded answer for a listing whose page would not load -- is never
written to the cache, because pinning a five-field card for the TTL would turn one degraded read into a
window of them.

## Which build is answering, and is it current?

`capabilities` publishes a `build` block: the commit answering your calls, how far it is behind
`origin/main`, when it was built, and whether that could be measured at all. It is there because a
deployment can be many commits and a whole release behind and still answer every call plausibly.
An opencode.json pointing at a nine-commit-old dist looked entirely healthy for weeks.

Freshness is a pure function of the build stamp, the base ref and the checkout. It needs no browser,
no page and no network. It used to be returned anyway *after* a cold Chromium launch and the mtop
probes, because it was assembled inside the same payload as the live probes. So a caller who
wanted only "is this deploy current?" paid a measured 60-90s for an answer no browser could have
influenced, and on a wedged Chromium paid longer. That covers a spawn-time freshness gate, a latency
measurement, or a trust check before spending 400s on a 50-listing comparison. One caller filed a bug
that the server was hung; it was answering, just slowly.

So `capabilities` takes `probe`, default `true`. Nothing about the default contract changed: every
existing caller still gets the live picture. With `probe: false` the tool returns `build`, `cache`
and the whole static payload immediately and never touches the browser.

**The fast path cannot pretend it probed.** The four conclusions that need a live site
(`session_state`, `login_probe_ret`, `feed_reachable`, `browser_launches`) come back **`null`**, not
`false`, and a `probes` block names them under `not_measured`. This is the same distinction
`build.stale: null` already draws: null means *could not be measured*, false means *measured, and it
said no*. `feed_reachable: false` on an unprobed path would assert goofish did not answer when the
truth is that nobody asked, and a freshness gate trusting it would report a healthy server as
unreachable. The two states stay distinct even under failure: `unknown` means a probe ran and could
not tell, `null` means no probe ran.

```jsonc
"probes": {
  "ran": false,
  "measured": [],
  "not_measured": ["session_state", "login_probe_ret", "feed_reachable", "browser_launches"],
  "note": "probe: false -- nothing was asked of goofish and no browser was launched, so the four keys above are null because nobody looked, NOT because a probe failed."
}
```

Both paths call the same `buildBlock()`, which is the same `src/build-info.ts` logic
`npm run check:deploy` runs from the command line. There is one staleness rule, tested once, so the
two paths cannot disagree about whether a deployment is current. That disagreement is the failure
worth worrying about here; a slow answer is merely annoying.

## Headless vs headed

Measured, same URL, one fresh context per run, sampling every 4s for 128–200s:

| | headed | headless |
|---|---|---|
| what goofish serves | the app: filter bar, suggest rail, login dialog, 20 cards, 2.3KB | the risk-control page: `非法访问 为了保障您的体验，请使用正常浏览器访问闲鱼~`, 0 cards, **35 bytes**, for the entire run |
| `mtop` client | up | **up** -- it boots on the risk-control page too |
| DOM tools | get the real page | get nothing to read |

So **headed is the default** and the three DOM tools need a display. What headless can still do is
everything that only needs goofish's own JS client -- `browse_feed`, `search_count`, `related_items`,
the seller tools, and the probes inside `capabilities` -- because the mtop client comes up on the
risk-control page as well. That was measured: all four returned normal data headless.

Set `XIANYU_HEADLESS=1` to opt back in; the cost is the DOM tools.

## Latency

Measured live on 2026-09-29, headed, on a shared 4-core box at load ~12 (one goofish page load is
10–25s here, Chromium launch is ~5s). One process, one browser: the first row is the cold start, every
other figure is that same warm session. Treat these as order of magnitude, not a benchmark.

| tool | warm | result |
|---|---|---|
| cold start (launch + first feed) | 24.7s | n/a |
| `capabilities` | 1.9s | `logged_out`, `feed_reachable: true` (probed; `probe: false` is milliseconds; see [which build is answering](#which-build-is-answering-and-is-it-current)) |
| `search_count` | 0.5s | 28,8xx for `thinkpad x220` |
| `related_items` | 2.2s | 20 listings, `item_web_recommend` |
| `browse_feed` | 1.5s | 20 listings, `homepage_feed` |
| `search_items` -- first of a session | 20.9s | 10 matches, `search_api` |
| `search_items` -- later, warm page | 13.6–14.9s | 10 matches, `search_api` |
| `item_view` | 6.4–9.5s | 5/5 live listings, `item_detail_api`, `fields_missing: []` |

Two things do the work. The mtop-only tools run on a page of their own that never navigates, so
they cost one request and no page load -- 0.4–2.2s warm -- and they no longer queue behind a search. And
only the *first* `search_items` of a session pays for a page load: later ones retype into the header
input of the page already showing results, which is an SPA route change, 13–15s against 21s for a cold
load. `item_view` reads the call the page makes for itself, which is both the only route that works and
far cheaper than the reload-and-retry loop it replaced.

The budget bounds the *loop*, not the call. It is checked between attempts, so a page load already in
flight runs to completion: at the 90s default and a 10–25s load you get several attempts, and a call
can overshoot its budget by roughly one page load. At that default `attempts: 4` is reachable without
raising anything. Note that raising the budget alone does not help when the site is declining every
load: a 280s budget with the default 4 attempts still stopped at 90s on the attempt cap, and 200s of
continuous polling on one page load never produced a result.

## What is verified, and what is not

Verified against the live site on 2026-09-29, when the server still had ten tools. `search_suggest` and `recommendations` were removed afterwards; the endpoint results below are unchanged. The mtop endpoints behind `browse_feed`,
`search_count`, `search_suggest` and `related_items` all answer anonymously, in *both* headless and
headed: 8 feed pages / 157 unique listings with 0 duplicates, the match counter at 28,841 and 29,671
for `x220` on consecutive runs (it drifts, so treat the number as a magnitude, not a constant) and 0 for
a nonsense string, autocomplete turning `x220` into `x220笔记本` / `x220键盘` / …, and ~30–60 real
listings per recommendation call. The four raw mtop rets were read directly off the wire:
`SUCCESS::调用成功` for the feed (20 cards), the counter, the suggest list and the recommendation list,
and `FAIL_SYS_SESSION_EXPIRED::Session过期` for `loginuser.get` -- so the session really is logged out.
`recommendations` also worked end-to-end off the rendered DOM, 10 real listings, `source:
dom_recommendation`, in both modes, with the login dialog up -- on three of four runs; the fourth fell
back to `source: homepage_feed` with a `fallback_reason`, which is the designed behaviour when the rail
will not paint, and is live listings either way. The MCP server itself was driven over
stdio: `initialize`, `tools/list` returning all ten with their schemas and the no-account note on each,
and a live `search_count` returning `{"ok":true,...,"match_count":28846}`.

### `item_view` reads the calls the page makes

goofish does not serve item detail to a request *this server* makes. Its own detail call,
`mtop.taobao.idle.pc.detail`, answers `TIMEOUT::接口超时` when re-issued through the page's mtop client
with the payload the page itself sent -- goofish stamps the requests its own bundle originates with a
per-call anti-bot blob, and a request we synthesise does not carry it. The same API, called by the page,
answers `SUCCESS::调用成功` and carries the listing.

So `item_view` loads the item page and reads the reply that page makes for itself, off the wire. That
is the only route that works, and it is also the richer one: the reply holds the title, the full photo
gallery, the description, the 品牌/成色/已用年限 attribute block, the seller's city, tenure, sales
count, positive rate, signature, reply rate and avatar, plus favourites, quantity and shipping.

This replaces a premise this README used to state, in three comments in the source and in the tool
description: that "goofish does not serve item pages to logged-out visitors". It does. Measured on
2026-09-29: the detail block paints, the API answers anonymously, and 6/6 live listings returned in
4–10s. The DOM path the tool fell back to is the thing that was actually broken -- it could not produce
a title at all (empty on 6 of 6 live listings, because the title is not in the page's text; it is in
the document title), and its photo selector returned goofish's own promo banners, four `-tps-242-150.png`
strips on a page whose listing was a nail gun.

| | when | what you get |
|---|---|---|
| `source: item_detail_api` | the page's detail call answered | everything listed above, exact |
| `source: item_page_dom` | no API reply, but the detail block rendered | the ten DOM-scrapable fields, title included |
| `source: search_card_cache` | the page would not answer, but an earlier search in this session returned the id | title, price, city, want count, photo -- and `fields_missing` naming the description and the seller statistics |

The card route is keyed on `item_id`, not on a query, so it cannot return a similarly-named listing.
It is the *last* resort rather than the first, now that the page itself is fast; it replaced a fallback
that ran up to eight whole keyword searches, each a fresh 10–25s page load.

If none of them find it, the error quotes what goofish actually said -- most often that this id is
sold, removed, or too old to still be live, since goofish answers a dead id with no listing rather than
an error. It does not tell you to look for a throttled IP, which is what an earlier version of this
README did and what was wrong.

Still worth knowing about the site. goofish decides *per page load* whether to serve a given page,
and an automated client is served a risk-control notice (`非法访问 / 请使用正常浏览器访问闲鱼`) more often
than a real browser is. That page is a 200 that renders no listing at all; the mtop-only tools keep
working through it because they need only the client. When it happens the DOM tools say `blocked: true`
rather than reporting zero results. Its own edge also fails outright sometimes, serving a `网络不见了`
page -- named as `site_error`, and retried rather than waited on.

## Guarantees, enforced by tests

- No account, ever. A brand-new browser context per session. `loginuser.get` is called only to
  *prove* the session is logged out, never to act as one, and `capabilities` reports `session_state`
  from what that probe actually returned -- not from the fact that it failed.
- No credentials. No cookie, storage-state or persistent-profile API appears anywhere in `src/`
  or `test/`; the test that enforces it matches `.cookies(` with whitespace stripped, so
  `page.context().cookies()` and a call split across lines cannot slip through either.
- No orphaned browsers. The server holds a real windowed Chromium, so shutdown is deliberate: a
  client closing stdin, a signal, and an unexpected exit all route through one bounded teardown, and
  a `browser.close()` that hangs is SIGKILLed rather than left running. Two measured defects are
  behind that guarantee, and both were invisible from inside the process. The SDK's stdio transport
  does not listen for the end of stdin, so a client that simply went away left the server running
  indefinitely. And closing stdin emits *both* `end` and `close`, so the second one hit the
  re-entrancy guard and called `process.exit` while the teardown was still in flight -- the node
  process died mid-`close()` and left the browser reparented to init: **15 orphaned processes after
  one audit run**. The guard now lets the in-flight teardown finish, and a `process.on('exit')` hook
  SIGKILLs the browser synchronously for the path where the event loop has already stopped. Verified
  after every fix: 0 processes left, 0 orphans.
- Read-only. No publish, delete, message, upload or account tool exists. The nine mtop API names the
  server may use are a closed list -- only `window.lib.mtop.request`, the client method the whole
  design rests on, is exempt -- and a test fails if any other `mtop.*` name appears. Seven are called
  by this server; the other two (`idle.pc.detail`, `idlemtopsearch.pc.search`) are named because the
  *page* calls them and the server reads the replies -- see
  [item_view](#item_view-reads-the-calls-the-page-makes).
- The lock is taken where a page is read, not by a list of tools. The three DOM tools hold the
  shared navigating page, and the mtop-only ones never queue behind a 70s search. The two seller tools
  are the case that forces the rule to be stated that way: mtop-only given a `user_id`, and holding the
  lock for exactly one item-page hop given an `item_id`, released before their mtop calls. A test reads
  the source and fails if either is wrapped in the blanket lock, if `resolveSeller` stops taking the
  shared one, or if either grows a lock of its own.
- A field that cannot be filled is null and named. `seller_profile` publishes `fields_missing`
  covering the four facts the profile endpoint does not carry, rather than an empty-looking profile that
  reads as "no history". It refuses a payload whose `kcUserId` is not the seller asked for, on the same
  grounds as `item_view` refusing a detail reply about another listing -- and the profile payload's
  `ipLocation` is dropped rather than published as a city, because it is the request's origin and
  measured 上海市 for a 北京 seller.
- goofish only, over https. Every navigation passes a host *and* scheme allowlist checked against
  the *parsed* URL, and re-checked against the URL goofish itself landed on, at both `goto` sites and in
  `revive`. Those checks are point-in-time, and a caller then polls for seconds before it reads
  anything, so every DOM read also re-checks the URL that is live *now*, in the same statement as the
  read -- one helper, and no scraper may bypass it (a test fails the build if one does).
  `https://www.goofish.com@evil.com/`, `https://www.goofish.computer/` and
  `https://www.goofish.com.evil.com/` are all refused, including when the page lands on one of them
  mid-call.
- No invented data. If a page will not render, the tool raises rather than guessing. If goofish
  serves a different listing than the one asked for, or a page with no listing id at all,
  `item_view` raises instead of reporting its fields. The recommendation rail is never returned as
  search results.
- A cached answer is never indistinguishable from a live one. Item detail and search pages are
  cached for a TTL (45s and 120s, overridable, `XIANYU_CACHE=0` disables). Every answer that can come
  from the cache publishes `hit`, `age_s`, `stored_at`, `ttl_s` and the key it was looked up under:
  on `item_view`, per pager page on `search_items`, per listing in `detail_report`, and in
  `capabilities`. A miss publishes the same block with null ages, so the envelope's shape does not
  change with the route. Only real reads are stored, a failed read leaves the cache untouched, and a
  cached answer is judged by the same relevance guard and identity checks as a live one. See
  [the cache](#repeat-views-are-cached-and-the-cache-says-so).
- **The freshness answer never waits for a browser, and never fakes a probe.** `capabilities`
  (`probe: false`) returns `build` without launching Chromium. Staleness is a pure function of the
  stamp, the base ref and the checkout, and a browser cannot change it. The four keys that do need
  the live site are then `null` under `probes.not_measured`, never `false`: "nobody looked" is not
  "looked, and it failed", and `capabilities` must not report a probe it did not run. See
  [which build is answering](#which-build-is-answering-and-is-it-current).
- **A speed-up is never invisible.** `detail`'s fan-out reports the width it ran at, how many batches,
  and whether it fell back, in `detail_fanout` -- and every listing in `detail_report` carries its own
  `ms`, its `via` and its `slot`. The batch's wall clock is never presented as the listing's cost,
  because measured on this site it is not: at four wide the batch fell 2.4x while each listing's own
  latency rose from 11.4s to 20.5s. See [the detail fan-out](#detail-reads-two-listings-at-a-time-and-says-when-it-stops).
- **The page is never clicked.** A structural test fails if a `.click(` call appears anywhere in
  `src/` or `test/`, and if the dismisser's selectors come back.
- One version, written once. The version in the MCP handshake is read out of `package.json` at
  startup, and a test fails if a semver literal reappears anywhere in `src/`. It used to be written
  down in both places, so `npm version` could bump the package while every client was still told the
  previous release existed.

## Development

```bash
npm test                 # 141 tests, no network, no browser
npm run typecheck        # tsc --noEmit over src and test
npm run build            # src/*.ts -> dist/*.js, what the tarball ships
npm run serve            # dist/index.js, rebuilt first if it is not the build of this checkout
npm run check:deploy     # is this checkout's dist current, and what is it behind
node src/index.ts        # stdio, run from source; refuses to run interactively
```

`tsconfig.json` is `noEmit` on purpose -- the source runs directly under Node's type stripping, so a
clone needs no build step. `tsconfig.build.json` is the emit config for the published artifact, and the
two differ only in that. Any import in `src/` keeps its `.ts` extension and `rewriteRelativeImportExtensions`
turns it into a `.js` one at build time; do not hand-write `.js` imports.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Release notes are in
[CHANGELOG.md](CHANGELOG.md).

This is a TypeScript rewrite. The repository's `main` branch is the TypeScript port; the original
Python implementation is preserved on the `python-original` branch. The endpoint knowledge, the
search-relevance rules and the item/search extractors derive from
[fancyboi999/goofish-cli](https://github.com/fancyboi999/goofish-cli), which is credited in `NOTICE`.

Security policy, including what this server deliberately does not hold and how to report a problem:
[SECURITY.md](SECURITY.md).
