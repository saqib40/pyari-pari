import { File } from 'expo-file-system';

import type { ConverseResponse, ConverseStateResponse } from '@/types/api';

import { api } from './api-client';

/**
 * One spoken turn. `uri` is the recording: an .m4a file on the phone, a blob URL in the browser.
 * Pari's reply is spoken separately through the TTS stream, so the text arrives sooner.
 */
export async function sendSpeech(uri: string): Promise<ConverseResponse> {
  const form = new FormData();
  if (process.env.EXPO_OS === 'web') {
    const blob = await (await fetch(uri)).blob();
    form.append('audio', blob, blob.type.includes('mp4') ? 'clip.m4a' : 'clip.webm');
  } else {
    // expo/fetch, the global fetch on native, uploads a File but not React Native's { uri } parts.
    form.append('audio', new File(uri));
  }
  form.append('speak', 'false');
  return api.post<ConverseResponse>('/converse', form);
}

/** A tapped reply goes through the same conversation as a spoken one. */
export function sendText(text: string) {
  return api.post<ConverseResponse>('/converse', { text, speak: false });
}

export function fetchConversationState() {
  return api.get<ConverseStateResponse>('/converse/state');
}

/** Drops a question the app can no longer show, e.g. one asked before the app restarted. */
export function resetConversation() {
  return api.post<ConverseStateResponse>('/converse/reset');
}
