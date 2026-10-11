# Issue audit for the TypeScript server

This change prepares local version 0.3.0; it does not publish a package, move a tag, delete a branch,
or rewrite remote history. The selected checkout is `alperien/xianyu-mcp` at base commit `8d0af28`.
The reported output files and the two `/home/user` clones are not available in this workspace, so
their exact failure path and divergent tags cannot be reproduced here. Current code and controlled
API/browser fixtures were used to test the remaining gaps.

| Issue | Current outcome |
| --- | --- |
| 1. Failures resemble empty results | Common status/error schema and MCP `isError` distinguish failure, empty, partial and success. Empty shells and malformed success payloads fail explicitly, including bad tool arguments. |
| 2. Undefined counts | Every response has a numeric `count`; an error’s zero means no validated returned rows, not zero inventory. Listings remain in `data.items`. |
| 3. Inventory contradiction | Search failure diagnostics can include a measured inventory count, or state that it was unavailable/unmeasured. An empty upstream search requires a confirmed zero count. The inventory endpoint is an estimate, not retrievability proof. |
| 4. Mixed-language queries | Title matching normalizes punctuation/spacing and expands Xeon/至强. Diagnostics expose token alternatives, misses and sample titles. Related categories are suggestions. The upstream query is still literal; automatic category expansion would risk unrelated products. |
| 5. Invisible throttling | Observed throttles/risk pages have reasons, retry hints and a process cooldown. Retries stop immediately on this evidence. Shared-IP activity outside this process cannot be measured. |
| 6–7. Numeric strings and prices | Raw fields remain compatible. All listing routes have numeric `typed` fields, including original price, image count and shipping fee. Chinese magnitudes parse; `price_info` identifies approximate/range/negotiable/unknown values. Deposits/prose are not guessed. |
| 8. Missing seller trust on cards | Remains an upstream data limitation. Missing facts stay null. Existing seller endpoints and optional shortlist detail can supply richer facts, with their costs visible. No sales history is inferred from a card. |
| 9. City/province inconsistency | `typed.location` has consistent nullable city/province fields. Filters accept standard suffix differences. Province is not inferred from an ambiguous city. |
| 10. Filters | Price band, city, province and excluded-title keywords run in the server after fetching. No verified upstream filtering API is available for this browser-driven route, so they do not reduce upstream card requests. Filters reapply after detail changes price/title. |
| 11. SXM vs PCIe | Optional title-evidence filters and a `hardware` block expose PCIe/SXM2–SXM5 and explicit bare-card evidence. Unknown/conflicting evidence fails a requested filter. Photos and seller verification still matter. |
| 12. Partial/resume | Validated API cards survive later-page failure or deadlines. Opaque cursors retain original filters and omitted cards, then resume unread pages. Process restart/eviction invalidates them; DOM-only fallback has no cursor. |
| 13. Stale price signal | Search reports the oldest observation age and per-page cache ages; continuation cards retain their age. The actual last price change remains unknown. |
| 14. Monitor/display requirement | An existing display can be selected with XIANYU_DISPLAY or DISPLAY; otherwise a private Xvfb starts automatically on Linux. Xvfb must be installed. README includes installation and explicit launch recipes. |
| 15. Slow calls | Retain warm pages/cache reuse, stop measured throttles, remove the known unsuccessful direct-URL retry, avoid another 32-second DOM poll after a rejected captured API set, and make full detail optional. Live latency remains unverified here. |
| 16. Conflicting ceilings | Capabilities publishes effective search ceilings and seller page size. Seller `limit` is now 1–20, matching its actual one-page capacity; search exposes requested and effective limits. |
| 17. Attempts multiply duration | `timeout_s` bounds search including queue, navigation and detail, with minor event-loop/serialization overhead. Every MCP call has a default deadline. Expired queued work does not launch a browser. |
| 18. Build provenance | Every response includes package version, commit, dirty state, TypeScript identity and a loaded-module fingerprint, including errors. |
| 19. Same name in different clones | Per-response implementation/fingerprint now identifies the answering server. TypeScript uses local version 0.3.0. The external Python/TypeScript clones and their tag divergence still require an audit on the machine that contains them. |
| 20. Checkpoints and polecat branches | Confirmed in the remote’s history/ref listing. Existing humanization tooling is present. Cleanup remains a maintainer decision because deleting refs or rewriting shared history can lose others’ work. |
| 21. Docs-only churn | This change pairs documentation with tested behavior. Historical docs commits remain part of the existing history. |
| 22. Dense tool descriptions | Descriptions and server instructions now explain query behavior, result states, filters, unknown values, pagination, deadlines and practical limits without internal API jargon. |

Additional fixes found during the audit: autocomplete cannot interpret a missing list as zero;
inventory counts reject booleans, arrays, nonfinite and unsafe integers; partial feed pages are
explicit; cooldown checks do not extend cooldown themselves; and shutdown waits for an in-flight
browser launch before closing its late handle.

Validation uses the offline regression suite, type checking, build checks, real MCP protocol requests,
and windowed Chromium with automatic Xvfb. Live Goofish validation is blocked by the cloud proxy’s
CONNECT 403 / browser tunnel error. Site retrieval quality and latency must be measured after network
access is applied; fixture success does not establish them.
