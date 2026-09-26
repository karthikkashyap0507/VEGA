import { ToolError } from './errors.js';

/**
 * Token bucket per tenant per connector (module2.md §5.3). Capacity and refill come from each
 * provider's documented quota, not a guess (certification checklist §12).
 *
 * The in-memory bucket is exact within one process; `ValkeyTokenBucket` (below) shares the
 * bucket across replicas with a single atomic script.
 */
export interface BucketSpec {
  capacity: number;
  refillPerSecond: number;
}

export interface TokenBucket {
  /** Takes one token or throws RATE_LIMITED with the wait until one is available. */
  take(key: string, spec: BucketSpec): Promise<void>;
}

export class MemoryTokenBucket implements TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async take(key: string, spec: BucketSpec): Promise<void> {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: spec.capacity, at: t };
    const refilled = Math.min(spec.capacity, b.tokens + ((t - b.at) / 1000) * spec.refillPerSecond);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, at: t });
      const wait = Math.ceil((1 - refilled) / spec.refillPerSecond);
      throw new ToolError('RATE_LIMITED', 'local rate limit for this connector', {
        committed: 'no',
        retryAfterSeconds: Math.max(1, wait),
      });
    }
    this.buckets.set(key, { tokens: refilled - 1, at: t });
  }
}

const TAKE_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(state[1]) or capacity
local at = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + ((now - at) / 1000) * rate)
local ok = 0
if tokens >= 1 then tokens = tokens - 1; ok = 1 end
redis.call('HSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, math.ceil(capacity / rate * 1000) + 1000)
return { ok, tostring(tokens) }
`;

/**
 * The one Valkey primitive the bucket needs: run a server-side Lua script atomically. Wire it
 * to ioredis as `{ script: (src, keys, args) => redis.call('EVAL', src, keys.length, ...keys, ...args) }`.
 * (Server-side Lua, not JavaScript evaluation — nothing here executes strings in this process.)
 */
export interface ScriptClient {
  script(source: string, keys: string[], args: Array<string | number>): Promise<unknown>;
}

export class ValkeyTokenBucket implements TokenBucket {
  constructor(private readonly client: ScriptClient) {}

  async take(key: string, spec: BucketSpec): Promise<void> {
    const [ok, tokens] = (await this.client.script(TAKE_SCRIPT, [`tb:${key}`], [
      spec.capacity,
      spec.refillPerSecond,
      Date.now(),
    ])) as [number, string];
    if (ok !== 1) {
      const wait = Math.ceil((1 - Number(tokens)) / spec.refillPerSecond);
      throw new ToolError('RATE_LIMITED', 'rate limit for this connector', {
        committed: 'no',
        retryAfterSeconds: Math.max(1, wait),
      });
    }
  }
}
