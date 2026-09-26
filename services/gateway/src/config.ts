import { z } from 'zod';

/**
 * Gateway configuration, validated at startup. A misconfigured gateway refuses to start —
 * the alternative is discovering at the first sign-in that the session secret is the
 * placeholder from .env.example.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GATEWAY_PORT: z.coerce.number().int().default(3001),
  GATEWAY_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CONTROL_URL: z.string().url().default('http://localhost:3002'),

  ZITADEL_ISSUER: z.string().url().default('http://localhost:8080'),
  ZITADEL_REDIRECT_URI: z.string().url().default('http://localhost:3001/v1/oauth/callback'),
  ZITADEL_APP_KEY_PATH: z.string().default('./infra/docker/secrets/zitadel-app-key.json'),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)')
    .refine((v) => !v.startsWith('CHANGE_ME'), 'SESSION_SECRET is still the .env.example placeholder'),
  /** Token lifetime without use (idle), and the rotation horizon. */
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  /** Absolute session lifetime. Rotation never extends past this. */
  REFRESH_TTL_SECONDS: z.coerce.number().int().min(300).default(12 * 3600),

  /** PKCS#8 EC P-256 key for principal assertions. Unset in dev: an ephemeral key is generated. */
  PRINCIPAL_SIGNING_KEY_PATH: z.string().optional(),
  RUN_TOKEN_SIGNING_KEY_PATH: z.string().optional(),

  VALKEY_URL: z.string().default('redis://localhost:6379'),
  RATE_LIMIT_TENANT_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
  RATE_LIMIT_TOKEN_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_ANON_PER_MINUTE: z.coerce.number().int().min(1).default(30),

  /** Local dev only: let /v1/signup set a password so the owner can sign in immediately. */
  SIGNUP_ALLOW_PASSWORD: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type GatewayConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`gateway configuration invalid:\n${lines}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && c.SIGNUP_ALLOW_PASSWORD) {
    throw new Error('SIGNUP_ALLOW_PASSWORD must not be enabled in production');
  }
  return {
    ...c,
    /** Secure cookies whenever the public URL is https; always in production. */
    cookieSecure: c.NODE_ENV === 'production' || c.GATEWAY_PUBLIC_URL.startsWith('https://'),
  };
}
