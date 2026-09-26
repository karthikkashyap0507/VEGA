// Fixture: every line marked `ruleid` must be reported. Run: semgrep --test .semgrep/
declare const logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
declare const tokens: { accessToken: string; refreshToken: string };
declare const span: { setAttribute: (k: string, v: unknown) => void };

// ruleid: token-reaches-log
logger.info({ at: tokens.accessToken }, 'refreshed');
// ruleid: token-reaches-log
logger.warn({ tokens }, 'refresh failed');
// ok: token-reaches-log
logger.info({ connectorId: 'c1' }, 'refreshed');
// ruleid: token-in-error-message
throw new Error(`bad token ${tokens.refreshToken}`);
// ruleid: token-in-span-attribute
span.setAttribute('token', tokens.accessToken);
