import { z } from 'zod';

/** Shared mail vocabulary for the Gmail and Outlook connectors. */

export const Address = z.string().email().max(320);

export interface OutgoingMessage {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  inReplyTo?: string | undefined;
  /** Deterministic Message-ID: lets verification (M6) find exactly this message later. */
  messageId?: string | undefined;
}

/** Header values cannot contain line breaks: that is how header injection works. */
function header(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('header value contains a line break');
  return value;
}

function encodeSubject(subject: string): string {
  // RFC 2047 for anything outside printable ASCII.
  return /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** RFC 5322 message, base64url-encoded as the Gmail API's `raw` field expects. */
export function rawMessage(m: OutgoingMessage): string {
  const lines = [
    `To: ${m.to.map(header).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(header).join(', ')}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.map(header).join(', ')}`] : []),
    `Subject: ${encodeSubject(header(m.subject))}`,
    ...(m.messageId ? [`Message-ID: ${header(m.messageId)}`] : []),
    ...(m.inReplyTo ? [`In-Reply-To: ${header(m.inReplyTo)}`, `References: ${header(m.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body, 'utf8').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export function allRecipients(m: { to: string[]; cc?: string[] | undefined; bcc?: string[] | undefined }): string[] {
  return [...new Set([...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map((a) => a.toLowerCase()))];
}

/**
 * HTML → plain text for message bodies. Not a sanitizer for rendering (Module 3's quarantined
 * extractor never renders), but it removes script/style blocks and every tag, so no active
 * content reaches a model even as text.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
