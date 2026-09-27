/**
 * The API without an HTTP server. The PC's server.ts and the phone's fetch
 * bridge both end up in handleApi; this gives the phone a way in that needs no
 * socket, by handing handleApi a request and response that only hold bytes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from './api.ts';

export interface RouteResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export async function route(method: string, url: URL, bodyText = ''): Promise<RouteResult> {
  const req = {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (bodyText) yield new TextEncoder().encode(bodyText);
    },
  } as unknown as IncomingMessage;

  const out: RouteResult = { status: 200, headers: {}, body: new Uint8Array() };
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      Object.assign(out.headers, headers);
      return res;
    },
    end(chunk?: string | Uint8Array) {
      if (typeof chunk === 'string') out.body = new TextEncoder().encode(chunk);
      else if (chunk) out.body = chunk;
      return res;
    },
  } as unknown as ServerResponse;

  const handled = await handleApi(req, res, url);
  if (!handled) return { status: 404, headers: {}, body: new Uint8Array() };
  return out;
}
