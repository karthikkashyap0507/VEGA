# @vega/verifier — `vega-verify`

Independent verification of VEGA evidence packs. **Apache-2.0.** It runs **offline**: it opens no
socket and never contacts VEGA. A verifier that phones home is not independent verification.

```
$ vega-verify ./evidence-pack-acme-2026-q3.zip --keys keys.json

  ✓ Signing keys match the published keys   (1 key(s))
  ✓ Manifest signature valid                 (key vega-evidence-2026-Q3)
  ✓ Every file matches its manifest digest   (41 files)
  ✓ 1,247 entries, sequence complete         (seq 88,412 → 89,658, no gaps)
  ✓ Every entry hashes to its entry_hash
  ✓ 1,247 signatures valid
  ✓ Hash chain intact
  ✓ 2 signed tree heads valid                (latest: 89,658 entries at 2026-09-30T23:00:00.000Z)
  ✓ Inclusion proofs valid                   (every entry is in the log of 89,658)
  ✓ Consistency with 1 earlier anchor confirmed
  ✓ 12 content objects match their digests
  ⚠ 3 entries have redacted content          (digests still verify)

  VERIFIED
```

Exit status: `0` verified, `1` not verified, `2` usage or I/O error. `--json` prints the report as
JSON. A pack also carries a bundled copy of this verifier in `verifier/`, runnable with Node ≥ 20:
`node verifier/vega-verify.mjs <pack.zip>`.

## What you should obtain independently

The pack contains the public keys and tree heads it was signed with — but a pack cannot vouch for
itself. For a verification that does not trust VEGA:

- `--keys keys.json` — the published keys, from `GET /.well-known/vega/keys` (rotated keys stay
  published forever). Without it, the report says the keys were taken from the pack.
- `--anchors anchors.json` — the tenant's published tree heads, from
  `GET /.well-known/vega/anchors/<tenant-slug>`. A tree head that differs from the published one
  for the same size is a rewritten history.

## The rules this verifier checks

These are the whole specification. Anything that writes VEGA evidence must produce exactly these
bytes; this package is the reference.

### Canonical JSON — RFC 8785 (JCS)

Objects: members sorted by key, comparing UTF-16 code units; no insignificant whitespace. Strings:
ECMAScript `JSON.stringify` escaping. Numbers: ECMAScript `Number.prototype.toString` (`-0` → `0`;
NaN and Infinity are not allowed). An object member whose value is absent is omitted.

### Entries

```
body            = { kind, ts, payload }              ts: RFC 3339 UTC with milliseconds
payload_digest  = "sha256:" hex(SHA-256(JCS(payload)))
entry_hash      = "sha256:" hex(SHA-256(JCS(body) ‖ LF ‖ prev_hash ‖ LF ‖ tenant_id ‖ LF ‖ seq))
```

`seq` is a per-tenant decimal sequence starting at 1, with no gaps. Entry 1's `prev_hash` is
`sha256:` followed by 64 zeros; every later entry's `prev_hash` is its predecessor's `entry_hash`.
Payloads hold **digests, never plaintext**: the content they commit to lives in a separate,
redactable store.

### Signatures — ML-DSA-65 (FIPS 204)

Written `ML-DSA-65:<base64>`. Every signed message is domain-separated:

| Object | Message signed |
|---|---|
| entry | `vega-entry-v1` LF `entry_hash` |
| signed tree head | `vega-sth-v1` LF JCS(tree head without `signature`) |
| pack manifest | `vega-manifest-v1` LF JCS(manifest without `signature`) |

A key signs only while current (`notBefore ≤ ts < notAfter`); rotated keys remain valid for what
they signed.

### The log — RFC 6962 Merkle tree

Leaf `i` is the entry with `seq = i + 1`; its leaf data is the 32 raw bytes of the `entry_hash`.
Leaf hash `SHA-256(0x00 ‖ data)`, node hash `SHA-256(0x01 ‖ left ‖ right)` — the tree Trillian and
Certificate Transparency use. A signed tree head commits to `treeSize`, `rootHash`, and the chain
head (`chainHeadSeq = treeSize`, `chainHeadHash`). Inclusion proofs (RFC 9162 §2.1.3) show each
entry is in the log; consistency proofs (§2.1.4) show each tree head extends the previous one —
which is what proves history was not rewritten, even by whoever holds the key.

### The pack

| File | Contents |
|---|---|
| `manifest.json` | format `vega-evidence-pack/1`, query, seq ranges, the tree head, every file's digest, signature |
| `entries.jsonl` | the entries, ascending by `seq` |
| `anchors.json` | signed tree heads, the last being the one proofs are against |
| `proofs/inclusion.json` | an inclusion proof per entry |
| `proofs/consistency.json` | consistency proofs between consecutive tree heads |
| `keys.json` | the public keys used |
| `redactions.json` | each redaction, pointing at the `redaction` chain entry that recorded it |
| `content/<hex>` | content the requester may see (verified against its digest) |
| `policies/`, `approvals/`, `models.json`, `control-map.md` | context for the auditor |
| `verifier/` | this verifier |

A filtered pack (for example, one client) holds non-contiguous entries: each is proven by its
inclusion proof, and the chain links are checked wherever neighbours are both present.

### What it rejects

Tests (`services/evidence/test/tamper.test.ts`) prove each of these is rejected by the check that
exists to catch it: a modified payload byte, reordered entries, a deleted entry, an inserted forged
entry, an old signature replayed onto new content, an altered `prev_hash`, a substituted key, a
truncated chain, a rewritten and re-anchored history, a forged anchor, an altered redaction record,
swapped content, an altered inclusion proof, a missing consistency proof, and an unlisted file.

Language matters: this makes VEGA's evidence **tamper-evident**, not tamper-proof.
