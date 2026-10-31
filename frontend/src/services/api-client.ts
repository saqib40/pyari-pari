import { env } from '@/config/env';
import type { ApiErrorBody } from '@/types/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The backend's error code, such as `NOTHING_HEARD`, or `NETWORK` when it couldn't be reached. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  /** Sent as JSON, or as multipart when it is FormData. */
  body?: unknown;
  signal?: AbortSignal;
};

export const authHeaders = { 'x-api-key': env.apiKey };

/** `path` is relative to /api, e.g. `/entries`. */
export function apiUrl(path: string, query?: Record<string, string>) {
  return `${env.apiUrl}/api${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const form = body instanceof FormData;

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      signal,
      headers: {
        Accept: 'application/json',
        ...authHeaders,
        ...(body === undefined || form ? null : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK', `Couldn’t reach Pari at ${env.apiUrl}`);
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (!response.ok) {
    const error = (data as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? `${method} ${path} failed with ${response.status}`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
};
