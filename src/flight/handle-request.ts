import type { IncomingMessage, ServerResponse } from 'node:http';
import type React from 'react';
import type { ReactFormState } from 'react-dom/client';
import {
  createTemporaryReferenceSet,
  decodeAction,
  decodeFormState,
  decodeReply,
  loadServerAction,
  renderToReadableStream,
  type TemporaryReferenceSet,
} from 'react-server-dom-rspack/server.node';
import {
  attachRenderResponse,
  getRedirect,
  getStatusCode,
  normalizeHttpResponse,
  setStatus,
} from 'nest-can-react';
import { renderHTML } from './entry.ssr';
import { parseRenderRequest } from './request';

export type RscPayload = {
  root: React.ReactNode;
  returnValue?: { ok: boolean; data: unknown };
  formState?: ReactFormState;
};

export type NestRenderOptions = {
  /**
   * The HTTP response object — either a Node.js `ServerResponse`
   * (Express) or a Fastify `Reply`.  `handleRequest` normalizes it
   * to Node.js `ServerResponse` semantics before rendering.
   */
  response: unknown;
  request?: IncomingMessage | Request;
  statusCode?: number;
  url?: string;
};

function toWebRequest(
  request: IncomingMessage | Request | undefined,
  fallbackUrl: string,
): Request {
  if (request instanceof Request) {
    return request;
  }

  if (!request) {
    return new Request(fallbackUrl, {
      method: 'GET',
      headers: { accept: 'text/html' },
    });
  }

  const host = request.headers.host ?? 'localhost';
  const protocol =
    (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const url = new URL(request.url ?? '/', `${protocol}://${host}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  if (!headers.has('accept')) {
    headers.set('accept', 'text/html');
  }

  return new Request(url, {
    method: request.method ?? 'GET',
    headers,
  });
}

async function webResponseToNode(
  webResponse: Response,
  nodeResponse: ServerResponse,
  statusCode?: number,
) {
  nodeResponse.statusCode = getStatusCode() ?? statusCode ?? webResponse.status;

  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') {
      return;
    }
    nodeResponse.setHeader(key, value);
  });

  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }

  const reader = webResponse.body.getReader();

  // Server Components render lazily, so a page's `redirect()` only runs once
  // the Flight stream starts flowing. Read the first chunk before flushing
  // anything, so a redirect is answered with a bare 3xx instead of HTML.
  const first = await reader.read();

  if (await settleRedirect(reader, nodeResponse)) {
    return;
  }

  try {
    if (first.done) {
      nodeResponse.end();
      return;
    }

    nodeResponse.write(Buffer.from(first.value));

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!nodeResponse.headersSent) {
        const liveStatus = getStatusCode();
        if (liveStatus != null) {
          nodeResponse.statusCode = liveStatus;
        }
      }
      nodeResponse.write(Buffer.from(value));
    }
    nodeResponse.end();
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
}

/**
 * Answers the request with a 3xx when the render called `redirect()`.
 * Returns false when no redirect happened and streaming should continue.
 */
async function settleRedirect(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  nodeResponse: ServerResponse,
): Promise<boolean> {
  const redirect = getRedirect();

  if (!redirect) {
    return false;
  }

  // Best-effort teardown: the SSR path pipes through rsc-html-stream, whose
  // writer may already be mid-enqueue and rejects the cancellation.
  try {
    await reader.cancel();
  } catch {
    // ignore — the response is being ended anyway
  }

  nodeResponse.statusCode = redirect.statusCode;
  nodeResponse.setHeader('location', redirect.url);
  nodeResponse.setHeader('content-length', '0');
  nodeResponse.end();

  return true;
}

export async function handleRequest({
  request,
  response,
  getRoot,
  bootstrapScripts,
  statusCode,
  url,
}: NestRenderOptions & {
  getRoot: () => React.ReactNode;
  bootstrapScripts?: string[];
}): Promise<void> {
  // Normalize the platform-specific HTTP response to a Node.js
  // ServerResponse-compatible object before any setHeader/write/end calls.
  // Express: already a ServerResponse → returned as-is.
  // Fastify: unwraps reply.raw → the underlying Node.js ServerResponse.
  const nodeResponse = normalizeHttpResponse(response);

  attachRenderResponse(nodeResponse);

  if (typeof statusCode === 'number') {
    setStatus(statusCode);
  }

  const fallbackUrl = url ?? 'http://localhost/';
  const webRequest = toWebRequest(request, fallbackUrl);
  const renderRequest = parseRenderRequest(webRequest);
  const normalized = renderRequest.request;

  let returnValue: RscPayload['returnValue'] | undefined;
  let formState: ReactFormState | undefined;
  let temporaryReferences: TemporaryReferenceSet | undefined;
  let actionStatus: number | undefined;

  if (renderRequest.isAction === true) {
    if (renderRequest.actionId) {
      const contentType = normalized.headers.get('content-type');
      const body = contentType?.startsWith('multipart/form-data')
        ? await normalized.formData()
        : await normalized.text();
      temporaryReferences = createTemporaryReferenceSet();
      const args = await decodeReply(body, { temporaryReferences });
      const action = loadServerAction(renderRequest.actionId);
      try {
        const data = await action(...args);
        returnValue = { ok: true, data };
      } catch (error) {
        returnValue = { ok: false, data: error };
        actionStatus = 500;
      }
    } else {
      const formData = await normalized.formData();
      const decodedAction = await decodeAction(formData);
      try {
        const result = await decodedAction();
        formState = (await decodeFormState(
          result,
          formData,
        )) as ReactFormState;
      } catch {
        nodeResponse.statusCode = 500;
        nodeResponse.setHeader('content-type', 'text/plain;charset=utf-8');
        nodeResponse.end('Internal Server Error: server action failed');
        return;
      }
    }
  }

  const rscPayload: RscPayload = {
    root: getRoot(),
    formState,
    returnValue,
  };
  const rscStream = renderToReadableStream(rscPayload, {
    temporaryReferences,
  });

  const devCacheHeaders =
    process.env.NEST_CAN_REACT_DEV === '1'
      ? ({ 'cache-control': 'no-store' } as const)
      : {};

  if (renderRequest.isRsc) {
    const flightResponse = new Response(rscStream, {
      status: actionStatus ?? getStatusCode() ?? statusCode ?? 200,
      headers: {
        'content-type': 'text/x-component;charset=utf-8',
        ...devCacheHeaders,
      },
    });
    await webResponseToNode(flightResponse, nodeResponse);
    return;
  }

  const ssrResult = await renderHTML(rscStream, {
    bootstrapScripts,
    formState,
  });

  const htmlResponse = new Response(ssrResult.stream, {
    status: getStatusCode() ?? ssrResult.status ?? statusCode ?? 200,
    headers: {
      'content-type': 'text/html;charset=utf-8',
      ...devCacheHeaders,
    },
  });

  await webResponseToNode(htmlResponse, nodeResponse);
}
