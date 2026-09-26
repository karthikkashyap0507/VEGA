import { isIP } from 'node:net';
import { isPublicAddress } from '@vega/connector-web';

export { defineTool, ToolError, type ConnectorDefinition, type ToolContext } from '@vega/connector-sdk';

/**
 * For the HTTP tool, private ranges are ALLOWED (internal APIs are the point) once an admin
 * allowlists them — but loopback, link-local (cloud metadata) and unspecified never are.
 */
export function isPublicAddressLike(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(h) || /^metadata(\.google\.internal)?$/i.test(h)) return false;
  if (!isIP(h)) return true;
  if (/^(127\.|169\.254\.|0\.)/.test(h) || h === '::1' || h === '::' || /^fe80:/i.test(h)) return false;
  return isPublicAddress(h) || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(h);
}
