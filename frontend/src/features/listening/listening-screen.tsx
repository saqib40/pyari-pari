import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTabBarInset } from '@/components/navigation/tab-bar-inset';
import { SkyOrb } from '@/components/sky/sky-orb';
import { AppText } from '@/components/ui/app-text';
import type { IconName } from '@/components/ui/icon';
import { PillButton } from '@/components/ui/pill-button';
import { formatMoney, formatPhone } from '@/lib/format';
import { useContentWidth } from '@/lib/use-content-width';
import type { ConversationState } from '@/types/api';
import type { LedgerEntry, PaymentLink } from '@/types/ledger';
import { colors, screenPadding, spacing, springs } from '@/theme';

import type { Turn } from './conversation-store';
import { useVoiceAssistant, type Notice } from './use-voice-assistant';

const LISTEN_HINT: Record<ConversationState, string> = {
  IDLE: 'Who bought what, and how much they paid.',
  AWAITING_ENTRY_CONFIRM: 'Haan, nahi, or what to change.',
  AWAITING_COLLECT_CHOICE: 'Haan ya nahi?',
  AWAITING_PHONE: 'Say the ten digits.',
  AWAITING_PHONE_CONFIRM: 'Haan ya nahi?',
  AWAITING_QR_MATCH: 'Haan ya nahi?',
};

const VOICE_ANSWER = 'Or tap the sky and say “haan”';
/** Longer lines get a smaller headline so they still fit. */
const LONG_LINE = 64;

type Action = {
  label: string;
  icon?: IconName;
  tone?: 'accent';
  onPress: () => void;
};

/** What the conversation area shows: Pari's line, a detail, and the replies. */
type Scene = {
  key: string;
  headline: string;
  body?: string;
  /** The body says what went wrong rather than what the merchant said. */
  alert?: boolean;
  note?: string;
  /** Pari wasn't sure she heard the amounts right. */
  flagged?: boolean;
  actions?: Action[];
  footnote?: string;
};

/** "…150 baaki. Save karoon?" puts the question on its own line. */
function breakBeforeQuestion(text: string) {
  return text.replace(/\. (?=[^.]*\?( \([^)]*\))?$)/, '.\n');
}

function breakdown(entry: LedgerEntry) {
  return `Total ${formatMoney(entry.total)} · Paid ${formatMoney(entry.paid)} · Baaki ${formatMoney(entry.pending)}`;
}

function linkOffer(entry?: LedgerEntry) {
  const phone = entry?.customer.phone;
  return phone ? `Paytm payment link by SMS to ${formatPhone(phone)}` : 'Paytm payment link by SMS';
}

function linkSent(link: PaymentLink) {
  return `Sent to ${formatPhone(link.phone)}. The entry closes itself once it’s paid.`;
}

const viewLedger: Action = {
  label: 'View in ledger',
  icon: 'ledgerFilled',
  onPress: () => router.navigate('/ledger'),
};

function turnScene(turn: Turn, answer: (text: 'haan' | 'nahi') => void): Scene {
  if (!turn.reply) {
    return {
      key: 'start',
      headline: 'Tap the sky and speak',
      body: '“Gupta ji ne 350 ka samaan liya, 200 UPI diya, 150 baaki”',
    };
  }

  const yes = (label: string, icon: IconName = 'check'): Action => ({
    label,
    icon,
    tone: 'accent',
    onPress: () => answer('haan'),
  });
  const no = (label: string): Action => ({ label, onPress: () => answer('nahi') });
  const said = {
    key: `turn-${turn.id}`,
    headline: breakBeforeQuestion(turn.reply.text),
    body: turn.transcript ? `“${turn.transcript}”` : undefined,
  };

  switch (turn.state) {
    case 'AWAITING_ENTRY_CONFIRM':
      return {
        ...said,
        note: turn.entry && breakdown(turn.entry),
        flagged: turn.needsReview,
        actions: [yes('Haan, save karo'), no('Nahi')],
        footnote: VOICE_ANSWER,
      };
    case 'AWAITING_COLLECT_CHOICE':
      return {
        ...said,
        note: linkOffer(turn.entry),
        actions: [yes('Link bhejo', 'link'), no('Abhi nahi')],
        footnote: VOICE_ANSWER,
      };
    case 'AWAITING_PHONE':
      return { ...said, actions: [no('Rehne do')], footnote: 'Tap the sky and say the number.' };
    case 'AWAITING_PHONE_CONFIRM':
      return { ...said, actions: [yes('Haan'), no('Nahi')], footnote: VOICE_ANSWER };
    case 'AWAITING_QR_MATCH':
      return {
        ...said,
        note: 'Paid to your shop QR',
        actions: [yes('Haan'), no('Nahi')],
        footnote: VOICE_ANSWER,
      };
    case 'IDLE':
      return {
        ...said,
        note: turn.link?.status === 'sent' ? linkSent(turn.link) : undefined,
        actions: turn.entry && turn.entry.status !== 'rejected' ? [viewLedger] : undefined,
      };
  }
}

/** An open question stays on screen, with the problem in place of the merchant's words. */
function withNotice(scene: Scene, notice: Notice | null, waiting: boolean): Scene {
  if (!notice) return scene;
  if (waiting) return { ...scene, key: `${scene.key}-notice`, body: notice.title, alert: true };
  return { key: 'notice', headline: notice.title, body: notice.detail };
}

export function ListeningScreen() {
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const width = useContentWidth();
  const { height } = useWindowDimensions();
  const { turn, phase, notice, level, energy, tapOrb, answer } = useVoiceAssistant();

  const orbSize = Math.round(Math.min(width * 0.72, height * 0.32, 340));

  const pressScale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: pressScale.value }] }));

  const onPress = () => {
    if (process.env.EXPO_OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    }
    tapOrb();
  };

  const waiting = turn.state !== 'IDLE';
  const scene: Scene =
    phase === 'recording'
      ? { key: 'recording', headline: 'Sun rahi hoon…', body: LISTEN_HINT[turn.state] }
      : phase === 'transcribing'
        ? { key: 'transcribing', headline: 'Soch rahi hoon…' }
        : withNotice(
            turnScene(turn, (text) => void answer(text)),
            notice,
            waiting,
          );
  const busy = phase === 'transcribing' || phase === 'answering';

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.sm, paddingBottom: tabBarInset }]}>
      <AppText variant="headline" align="center" color={colors.textSecondary} style={styles.wordmark}>
        pyari pari
      </AppText>

      <View style={styles.stage}>
        <Pressable
          onPress={onPress}
          onPressIn={() => pressScale.set(withSpring(0.96, springs.press))}
          onPressOut={() => pressScale.set(withSpring(1, springs.press))}
          disabled={busy}
          role="button"
          accessibilityLabel={
            phase === 'recording' ? 'Stop listening' : waiting ? 'Answer by voice' : 'Speak an entry'
          }>
          <Animated.View style={pressStyle}>
            <SkyOrb size={orbSize} energy={energy} level={level} glow={0.1} ripples />
          </Animated.View>
        </Pressable>

        <View style={[styles.conversation, { marginTop: Math.round(orbSize * 0.17) }]}>
          <SceneView key={scene.key} scene={scene} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

function SceneView({ scene, disabled }: { scene: Scene; disabled: boolean }) {
  return (
    <Animated.View entering={FadeIn.duration(400)} exiting={FadeOut.duration(150)} style={styles.block}>
      <AppText
        variant="headline"
        align="center"
        numberOfLines={4}
        style={scene.headline.length > LONG_LINE && styles.longHeadline}>
        {scene.headline}
      </AppText>
      {scene.body ? (
        <AppText
          variant="body"
          align="center"
          numberOfLines={2}
          color={scene.alert ? colors.text : colors.textSecondary}>
          {scene.body}
        </AppText>
      ) : null}
      {scene.note ? (
        <AppText variant="caption" align="center" color={scene.flagged ? colors.due : undefined}>
          {scene.note}
        </AppText>
      ) : null}
      {scene.actions ? (
        <View style={styles.actions}>
          {scene.actions.map((action) => (
            <PillButton
              key={action.label}
              label={action.label}
              icon={action.icon}
              tone={action.tone}
              disabled={disabled}
              onPress={action.onPress}
            />
          ))}
        </View>
      ) : null}
      {scene.footnote ? (
        <AppText variant="caption" align="center" color={colors.textTertiary}>
          {scene.footnote}
        </AppText>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: screenPadding,
  },
  wordmark: {
    fontSize: 22,
    lineHeight: 28,
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Sized for the idle prompt so the orb stays centered; taller steps overflow downwards.
  conversation: {
    alignSelf: 'stretch',
    height: 120,
  },
  block: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: spacing.sm,
  },
  longHeadline: {
    fontSize: 24,
    lineHeight: 30,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
