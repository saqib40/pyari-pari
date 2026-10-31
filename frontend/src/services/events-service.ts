import { fetch } from 'expo/fetch';

import type { PariEventDto } from '@/types/api';

import { apiUrl, authHeaders } from './api-client';

const RECONNECT_MS = 2000;

/** Follows the backend's server-sent events until the returned function is called, reconnecting when the stream drops. */
export function subscribeToPariEvents(onEvent: (event: PariEventDto) => void) {
  const controller = new AbortController();
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        await readEvents(onEvent, controller.signal);
      } catch {
        // Refused or dropped, e.g. while the backend restarts.
      }
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  })();
  return () => controller.abort();
}

async function readEvents(onEvent: (event: PariEventDto) => void, signal: AbortSignal) {
  const response = await fetch(apiUrl('/events'), {
    headers: { ...authHeaders, Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Event stream failed with ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const name = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (name && data && name !== 'pari.ready') onEvent(JSON.parse(data) as PariEventDto);
    }
  }
}
