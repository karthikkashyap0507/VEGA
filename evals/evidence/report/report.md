# Evidence load eval

| | |
|---|---|
| Chain | 100,000 signed entries over 12 months (generation 113.8 s, not measured) |
| Query | everything about one client, 12 months (24,984 entries concern the client) |
| **Pack build** | **31.9 s** — target < 60 s · 24,984 entries · 99.2 MB |
| Offline verification | 53.1 s — VERIFIED |
| Append (lock → sign → commit) | p50 8.4 ms · p99 30.8 ms · max 54.4 ms (300 sequential appends, one tenant) |
| Result | ✅ PASS |
