import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Easing, useSharedValue, withTiming } from 'react-native-reanimated';

import { env } from '@/config/env';
import { ledgerKeys } from '@/features/ledger/use-ledger';
import { qrPaymentKeys } from '@/features/qr/use-qr-payments';
import { ApiError } from '@/services/api-client';
import {
  fetchConversationState,
  resetConversation,
  sendSpeech,
  sendText,
} from '@/services/conversation-service';
import { toLedgerEntry, toPaymentLink } from '@/services/ledger-service';
import { stopSpeaking, subscribeToSpeaking } from '@/services/speech-service';
import type { ConverseResponse } from '@/types/api';

import { getTurn, showTurn, useTurn } from './conversation-store';
import { useMicrophone } from './use-microphone';

/** What the app itself is doing. Where the conversation stands is the server's `turn.state`. */
export type Phase = 'ready' | 'recording' | 'transcribing' | 'answering';

/** Why the last attempt didn't get through, shown until the next one. */
export type Notice = { title: string; detail?: string };

const MIC_BLOCKED: Notice = {
  title: 'Pari needs the microphone',
  detail: 'Allow it in settings, or answer with the buttons.',
};
const MIC_FAILED: Notice = { title: 'The microphone didn’t start', detail: 'Tap the sky to try again.' };

function noticeFor(error: unknown): Notice {
  const code = error instanceof ApiError ? error.code : '';
  if (code === 'NOTHING_HEARD' || code === 'AUDIO_TOO_SHORT') {
    return { title: 'Kuch sunaai nahi diya, phir boliye.' };
  }
  if (code === 'NETWORK') {
    return { title: 'Can’t reach Pari', detail: `Check that the backend is running at ${env.apiUrl}.` };
  }
  if (error instanceof ApiError && code.startsWith('SARVAM')) {
    return { title: 'Pari can’t hear right now', detail: error.message };
  }
  return { title: 'That didn’t work', detail: 'Tap the sky to try again.' };
}

function energyFor(phase: Phase, speaking: boolean, waiting: boolean) {
  if (phase === 'recording') return 1;
  if (phase === 'transcribing') return 0.55;
  if (phase === 'answering') return 0.45;
  if (speaking) return 0.6;
  return waiting ? 0.3 : 0;
}

export function useVoiceAssistant() {
  const queryClient = useQueryClient();
  const turn = useTurn();
  const [phase, setPhase] = useState<Phase>('ready');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [speaking, setSpeaking] = useState(false);
  /** The phase right now, for callbacks that outlive the render they came from. */
  const current = useRef<Phase>('ready');

  /** 0–1 microphone loudness, smoothed for the orb. */
  const level = useSharedValue(0);
  /** 0–1 how "awake" the orb should look. */
  const energy = useSharedValue(0);

  const target = energyFor(phase, speaking, turn.state !== 'IDLE');
  useEffect(() => {
    energy.set(withTiming(target, { duration: 700, easing: Easing.out(Easing.cubic) }));
  }, [energy, target]);

  useEffect(() => subscribeToSpeaking(setSpeaking), []);

  // A question asked before the app started can't be shown, so the merchant's next words would answer it blind.
  useEffect(() => {
    if (getTurn().id > 0) return;
    fetchConversationState()
      .then(({ state }) => (state === 'IDLE' ? undefined : resetConversation()))
      .catch(() => {});
  }, []);

  const go = (next: Phase) => {
    current.current = next;
    setPhase(next);
  };

  const show = (response: ConverseResponse) => {
    // "Samajh nahi aaya" turns repeat the question without its entry, so the breakdown stays.
    const previous = getTurn();
    const same = response.state === previous.state && !response.entry;
    showTurn({
      state: response.state,
      reply: response.reply,
      transcript: response.transcript,
      entry: response.entry ? toLedgerEntry(response.entry) : same ? previous.entry : undefined,
      link: response.link && toPaymentLink(response.link),
      needsReview: response.needsReview ?? (same ? previous.needsReview : undefined),
    });
    void queryClient.invalidateQueries({ queryKey: ledgerKeys.all });
    void queryClient.invalidateQueries({ queryKey: qrPaymentKeys.all });
  };

  const finish = async () => {
    if (current.current !== 'recording') return;
    go('transcribing');
    level.set(withTiming(0, { duration: 200 }));
    try {
      const uri = await stopMic();
      if (uri) show(await sendSpeech(uri));
    } catch (error) {
      setNotice(noticeFor(error));
    }
    go('ready');
  };

  const { start: startMic, stop: stopMic } = useMicrophone({
    onLevel: (value) => level.set(withTiming(value, { duration: 120 })),
    onSilence: () => void finish(),
  });

  const listen = async () => {
    stopSpeaking();
    setNotice(null);
    go('recording');
    let started = false;
    try {
      started = await startMic();
      if (!started) setNotice(MIC_BLOCKED);
    } catch {
      setNotice(MIC_FAILED);
    }
    if (!started) go('ready');
    // Tapped again, or left the tab, while the microphone was starting.
    else if (current.current !== 'recording') void stopMic();
  };

  /** A tapped reply; the server treats it exactly like the spoken word. */
  const answer = async (text: 'haan' | 'nahi') => {
    if (current.current !== 'ready') return;
    stopSpeaking();
    setNotice(null);
    go('answering');
    try {
      show(await sendText(text));
    } catch (error) {
      setNotice(noticeFor(error));
    }
    go('ready');
  };

  /** The orb is the mic: it starts listening, or stops and sends what was said. */
  const tapOrb = () => {
    if (current.current === 'recording') void finish();
    else if (current.current === 'ready') void listen();
  };

  useFocusEffect(
    useCallback(
      () => () => {
        if (current.current !== 'recording') return;
        current.current = 'ready';
        setPhase('ready');
        level.set(0);
        void stopMic();
      },
      [level, stopMic],
    ),
  );

  return { turn, phase, notice, level, energy, tapOrb, answer };
}
