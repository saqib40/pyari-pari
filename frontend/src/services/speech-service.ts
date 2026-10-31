import { createAudioPlayer, type AudioStatus } from 'expo-audio';

import { env } from '@/config/env';
import type { Line } from '@/types/api';

import { apiUrl } from './api-client';

/** Gives up on a line that never loads or never reports its end, so the queue keeps moving. */
const LINE_TIMEOUT_MS = 30_000;

const queue: Line[] = [];
const listeners = new Set<(speaking: boolean) => void>();
let finishCurrent: (() => void) | null = null;

/** Pari says `line` once she has finished whatever she is already saying. */
export function speak(line: Line) {
  if (!line.speech.trim()) return;
  queue.push(line);
  if (!finishCurrent) playNext();
}

/** Cuts Pari off and forgets anything queued, e.g. when the merchant starts talking. */
export function stopSpeaking() {
  queue.length = 0;
  finishCurrent?.();
}

export function subscribeToSpeaking(listener: (speaking: boolean) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function playNext() {
  const line = queue.shift();
  if (!line) {
    finishCurrent = null;
    listeners.forEach((listener) => listener(false));
    return;
  }

  // Streamed WAV has no final length in its header. Browsers cope; native players may not, so they download first.
  const player = createAudioPlayer(
    { uri: apiUrl('/tts/stream', { text: line.speech, key: env.apiKey }) },
    { downloadFirst: process.env.EXPO_OS !== 'web' },
  );
  let started = false;
  const finish = () => {
    if (finishCurrent !== finish) return;
    clearTimeout(timeout);
    subscription.remove();
    player.remove();
    playNext();
  };
  const subscription = player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
    if (status.didJustFinish || status.error) {
      finish();
    } else if (status.isLoaded && !started) {
      started = true;
      player.play();
    }
  });
  const timeout = setTimeout(finish, LINE_TIMEOUT_MS);

  finishCurrent = finish;
  listeners.forEach((listener) => listener(true));
}
