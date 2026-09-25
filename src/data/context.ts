import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServerResponse } from 'node:http';

export type LayoutMeta = {
  title?: string;
  description?: string;
  [key: string]: unknown;
};

export type Redirect = {
  url: string;
  statusCode: RedirectStatus;
};

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

type Store = {
  layoutMeta: LayoutMeta;
  statusCode?: number;
  redirect?: Redirect;
  response?: ServerResponse;
};

const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

const storage = new AsyncLocalStorage<Store>();

export function runWithLayoutMeta<T>(callback: () => T): T {
  return storage.run({ layoutMeta: {} }, callback);
}

export function setLayoutMeta(meta: LayoutMeta) {
  const store = storage.getStore();

  if (!store) {
    throw new Error(
      'setLayoutMeta() must run during a page render (Server Component).',
    );
  }

  store.layoutMeta = {
    ...store.layoutMeta,
    ...meta,
  };
}

export function getLayoutMeta() {
  return storage.getStore()?.layoutMeta ?? {};
}

export function useLayoutMeta() {
  return getLayoutMeta();
}

export function setStatus(statusCode: number) {
  const store = storage.getStore();

  if (!store) {
    throw new Error(
      'setStatus() must run during render() (Server Component render).',
    );
  }

  store.statusCode = statusCode;

  if (store.response && !store.response.headersSent) {
    store.response.statusCode = statusCode;
  }
}

export function getStatusCode() {
  return storage.getStore()?.statusCode;
}

export function redirect(url: string, statusCode: RedirectStatus = 302) {
  const store = storage.getStore();

  if (!store) {
    throw new Error(
      'redirect() must run during render() (Server Component render).',
    );
  }

  if (!REDIRECT_STATUS_CODES.has(statusCode)) {
    throw new Error(
      `redirect() status must be one of 301, 302, 303, 307, 308 (got ${statusCode}).`,
    );
  }

  store.redirect = { url, statusCode };
  store.statusCode = statusCode;
}

export function getRedirect() {
  return storage.getStore()?.redirect;
}

export function attachRenderResponse(response: ServerResponse) {
  const store = storage.getStore();

  if (!store) {
    return;
  }

  store.response = response;
}
