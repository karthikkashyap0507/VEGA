/**
 * @vega/verifier — independent verification of VEGA evidence (docs/module7.md §5.8).
 * Apache-2.0. Runs offline; no network calls; the rules it checks are written out in README.md.
 */
export { canonicalize } from './canonical.js';
export { digestBytes, digestOf, entryHash, GENESIS, hex, payloadDigest, sha256Hex, unhex, type EntryBody } from './hash.js';
export { leafHash, nodeHash, rootOf, verifyConsistency, verifyInclusion } from './merkle.js';
export { ALG, b64, entryMessage, keyCovers, manifestMessage, treeHeadMessage, unb64, verifySignature, type PublicKeyRecord } from './sign.js';
export { formatReport, PACK_FORMAT, referencedDigests, verifyPack, type ChainEntry, type Check, type CheckId, type Manifest, type Redaction, type Report, type TreeHead, type VerifyOptions } from './pack.js';
export { readZip, writeZip } from './archive.js';
