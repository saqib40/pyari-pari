import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { useCallback, useEffect, useRef } from 'react';

const RECORDING: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
const POLL_MS = 100;

/** Readings this low (Android reports -160) mean the recorder had nothing to measure yet. */
const NO_SIGNAL_DB = -100;
const SPEECH_ABOVE_FLOOR_DB = 12;
const QUIET_ABOVE_FLOOR_DB = 8;
const QUIET_BELOW_PEAK_DB = 20;
/** Longer than the pauses between words. */
const QUIET_MS = 1200;
const NO_SPEECH_MS = 8000;
const MAX_MS = 20_000;

type Handlers = {
  /** 0–1 loudness, about ten times a second. */
  onLevel: (level: number) => void;
  /** The merchant spoke and went quiet, or never started. */
  onSilence: () => void;
};

/** Records one clip at a time and notices when the speaker has finished. */
export function useMicrophone(handlers: Handlers) {
  const recorder = useAudioRecorder(RECORDING);
  const latest = useRef(handlers);
  const recording = useRef(false);
  const poll = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    latest.current = handlers;
  });

  const stopPolling = useCallback(() => {
    clearInterval(poll.current);
    poll.current = undefined;
  }, []);

  /** Resolves false when the merchant hasn't allowed the microphone. */
  const start = useCallback(async () => {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) return false;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    recording.current = true;

    const hear = silenceDetector(Date.now());
    poll.current = setInterval(() => {
      const { level, done } = hear(recorder.getStatus().metering, Date.now());
      latest.current.onLevel(level);
      if (done) {
        stopPolling();
        latest.current.onSilence();
      }
    }, POLL_MS);
    return true;
  }, [recorder, stopPolling]);

  /** Resolves with the recording's uri, or null if nothing was being recorded. */
  const stop = useCallback(async () => {
    stopPolling();
    if (!recording.current) return null;
    recording.current = false;
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    return recorder.uri;
  }, [recorder, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  return { start, stop };
}

/**
 * Judges speech against the room instead of fixed levels: Android meters peaks,
 * browsers meter RMS, and a shop is louder than a bedroom.
 */
function silenceDetector(startedAt: number) {
  let smoothed: number | undefined;
  let floor = -35;
  let peak = -Infinity;
  let loudFrames = 0;
  let heardSpeech = false;
  let quietSince: number | undefined;

  return (metering: number | undefined, now: number) => {
    const elapsed = now - startedAt;
    if (elapsed >= MAX_MS) return { level: 0, done: true };
    if (metering === undefined || metering <= NO_SIGNAL_DB) {
      return { level: 0, done: !heardSpeech && elapsed >= NO_SPEECH_MS };
    }

    smoothed = smoothed === undefined ? metering : smoothed + (metering - smoothed) * 0.5;
    floor = Math.max(Math.min(floor, smoothed), -75);
    peak = Math.max(peak, smoothed);

    loudFrames = smoothed >= floor + SPEECH_ABOVE_FLOOR_DB ? loudFrames + 1 : 0;
    if (loudFrames >= 2) heardSpeech = true;

    const quiet = smoothed < Math.max(floor + QUIET_ABOVE_FLOOR_DB, peak - QUIET_BELOW_PEAK_DB);
    quietSince = quiet ? (quietSince ?? now) : undefined;

    return {
      level: Math.min(1, Math.max(0, (smoothed - floor - 4) / 26)),
      done: heardSpeech ? quietSince !== undefined && now - quietSince >= QUIET_MS : elapsed >= NO_SPEECH_MS,
    };
  };
}
