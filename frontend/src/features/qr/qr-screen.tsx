import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOutDown, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTabBarInset } from '@/components/navigation/tab-bar-inset';
import { SkyOrb } from '@/components/sky/sky-orb';
import { AppText } from '@/components/ui/app-text';
import { PillButton } from '@/components/ui/pill-button';
import { ScreenHeader } from '@/components/ui/screen-header';
import { env } from '@/config/env';
import { useLedgerEntries } from '@/features/ledger/use-ledger';
import { useContentWidth } from '@/lib/use-content-width';
import { simulateQrPayment } from '@/services/demo-service';
import type { LedgerEntry } from '@/types/ledger';
import type { Profile } from '@/types/profile';
import { colors, screenPadding, spacing } from '@/theme';

import { PaymentMatchCard } from './payment-match-card';
import { QrCode } from './qr-code';
import { useProfile } from './use-profile';
import { useQrPayments } from './use-qr-payments';

/** Space kept below the orb for the name and actions; the orb is sized to fit what's left. */
const FOOTER_HEIGHT = 144;

export function QrScreen() {
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const width = useContentWidth();
  const [stageHeight, setStageHeight] = useState(0);
  const { data: payments } = useQrPayments();
  const [payment, ...waiting] = payments ?? [];

  const stageSize = Math.round(
    Math.min(width - screenPadding * 2, stageHeight - FOOTER_HEIGHT - spacing.lg, 340),
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.sm, paddingBottom: tabBarInset }]}>
      <ScreenHeader overline="Get paid" title="Scan to pay" />

      <View style={styles.stage} onLayout={(event) => setStageHeight(event.nativeEvent.layout.height)}>
        {stageSize > 0 ? (
          <Animated.View entering={FadeIn.duration(300)}>
            <MyCode size={stageSize} covered={Boolean(payment)} />
          </Animated.View>
        ) : null}
      </View>

      {payment ? (
        <Animated.View
          key={payment.id}
          entering={FadeInDown.duration(350)}
          exiting={FadeOutDown.duration(200)}
          style={[styles.match, { bottom: tabBarInset }]}>
          <PaymentMatchCard payment={payment} waiting={waiting.length} />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** What the newest open entry still owes, the payment a demo customer would make. In paise. */
function newestPending(entries: LedgerEntry[] = []) {
  return entries
    .filter((entry) => entry.status === 'open' && entry.pending > 0)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]?.pending;
}

/** `covered` while a payment match card sits over the footer. */
function MyCode({ size, covered }: { size: number; covered: boolean }) {
  const { data: profile, isError, refetch } = useProfile();
  const { data: entries } = useLedgerEntries();
  const cardSize = Math.round(size * 0.6);

  // Demo only: a customer scans the code and pays, and Pari asks whose payment it is.
  const pending = env.demoTools ? newestPending(entries) : undefined;
  const payQr = pending
    ? () => {
        if (process.env.EXPO_OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        simulateQrPayment(pending / 100).catch(() => {});
      }
    : undefined;

  return (
    <View style={styles.centered}>
      <SkyOrb size={size} glow={0.16}>
        {profile ? (
          <Pressable onLongPress={payQr} disabled={!payQr}>
            <Animated.View entering={ZoomIn.duration(400)} style={[styles.card, cardStyle(cardSize)]}>
              <QrCode value={profile.qrPayload} size={Math.round(cardSize * 0.8)} />
            </Animated.View>
          </Pressable>
        ) : null}
      </SkyOrb>

      {covered ? (
        <View style={styles.footer} />
      ) : isError ? (
        <View style={styles.footer}>
          <AppText variant="body" align="center" color={colors.textSecondary}>
            Couldn’t load your code.
          </AppText>
          <PillButton label="Try again" onPress={() => void refetch()} />
        </View>
      ) : (
        <Animated.View entering={FadeIn.duration(250)}>
          <Identity profile={profile} />
        </Animated.View>
      )}
    </View>
  );
}

function Identity({ profile }: { profile?: Profile }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const address = profile?.paymentAddress;

  const copy = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
  };

  const share = () => {
    if (!profile || !address) return;
    void Share.share({ message: `Pay ${profile.businessName} with Pyari Pari: ${profile.qrPayload}` });
  };

  return (
    <View style={styles.footer}>
      <View style={styles.names}>
        <AppText variant="title" align="center" numberOfLines={1} style={styles.name}>
          {profile?.businessName ?? ' '}
        </AppText>
        <AppText variant="caption" align="center">
          {address ?? ' '}
        </AppText>
      </View>
      {profile && !address ? null : (
        <View style={styles.actions}>
          <PillButton
            icon={copied ? 'check' : 'copy'}
            label={copied ? 'Copied' : 'Copy ID'}
            onPress={() => void copy()}
            disabled={!address}
          />
          <PillButton icon="share" label="Share" onPress={share} disabled={!address} />
        </View>
      )}
    </View>
  );
}

const cardStyle = (side: number) => ({
  width: side,
  height: side,
  borderRadius: Math.round(side * 0.16),
});

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: screenPadding,
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: {
    alignItems: 'center',
  },
  card: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    boxShadow: '0 18px 40px rgba(12, 28, 84, 0.38)',
  },
  footer: {
    height: FOOTER_HEIGHT,
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.lg,
  },
  names: {
    alignItems: 'center',
    gap: spacing.xxs,
  },
  name: {
    fontSize: 30,
    lineHeight: 36,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  match: {
    position: 'absolute',
    left: screenPadding,
    right: screenPadding,
  },
});
