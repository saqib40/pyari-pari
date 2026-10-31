import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { PillButton } from '@/components/ui/pill-button';
import { formatMoney, formatTime } from '@/lib/format';
import type { QrPayment } from '@/types/payments';
import { colors, radii, spacing } from '@/theme';

import { useResolveQrPayment } from './use-qr-payments';

function settles(amount: number, pending: number) {
  const left = pending - amount;
  if (left > 0) return `${formatMoney(left)} of their ${formatMoney(pending)} stays baaki`;
  if (left < 0) return `Clears their ${formatMoney(pending)} baaki, with ${formatMoney(-left)} extra`;
  return `Clears their ${formatMoney(pending)} baaki`;
}

type PaymentMatchCardProps = {
  payment: QrPayment;
  /** Other payments waiting behind this one. */
  waiting: number;
};

/**
 * Asks whether a QR payment is for its best-matching open entry; each "Nahi"
 * moves to the next suggestion until none are left.
 */
export function PaymentMatchCard({ payment, waiting }: PaymentMatchCardProps) {
  const [index, setIndex] = useState(0);
  const resolve = useResolveQrPayment();
  const suggestion = payment.suggestions.at(index);
  const amount = formatMoney(payment.amount);

  const dismiss = () => resolve.mutate({ paymentId: payment.id });

  const via = payment.source === 'link' ? 'More than the link asked' : 'On your QR';
  const meta = [`${via} · ${formatTime(payment.receivedAt)}`, waiting > 0 ? `${waiting} more waiting` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.card}>
      <View style={styles.meta}>
        <Icon name={payment.source === 'link' ? 'link' : 'qr'} size={13} color={colors.accentText} />
        <AppText variant="caption" numberOfLines={1}>
          {meta}
        </AppText>
      </View>

      <Animated.View key={index} entering={FadeIn.duration(250)} style={styles.question}>
        <AppText variant="headline" style={styles.headline}>
          {suggestion ? `${amount} aaya, ${suggestion.customerName} ka?` : `${amount} aaya. Kiska hai?`}
        </AppText>
        <AppText variant="caption">
          {suggestion ? settles(payment.amount, suggestion.pending) : 'No open entry matches this payment.'}
        </AppText>
      </Animated.View>

      <View style={styles.actions}>
        {suggestion ? (
          <>
            <PillButton
              tone="accent"
              icon="check"
              label="Haan"
              disabled={resolve.isPending}
              onPress={() => resolve.mutate({ paymentId: payment.id, entryId: suggestion.entryId })}
              style={styles.action}
            />
            <PillButton
              label="Nahi"
              disabled={resolve.isPending}
              onPress={() => (index + 1 < payment.suggestions.length ? setIndex(index + 1) : dismiss())}
              style={styles.action}
            />
          </>
        ) : (
          <PillButton label="Theek hai" disabled={resolve.isPending} onPress={dismiss} style={styles.action} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.xl,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    boxShadow: '0 -8px 40px rgba(0, 0, 0, 0.7)',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  question: {
    gap: spacing.xxs,
  },
  headline: {
    fontSize: 25,
    lineHeight: 30,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  action: {
    flex: 1,
  },
});
