import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { env } from '@/config/env';
import { formatMoney, formatTime } from '@/lib/format';
import { simulateLinkPaid } from '@/services/demo-service';
import type { LedgerEntry } from '@/types/ledger';
import { colors, radii, spacing } from '@/theme';

import { Avatar } from './avatar';
import { lastActivity } from './use-ledger';

const AVATAR = 42;
const INSET = spacing.md;

type LedgerRowProps = {
  entry: LedgerEntry;
  first: boolean;
  last: boolean;
};

function describe(entry: LedgerEntry): { icon: IconName; text: string } {
  if (entry.status === 'closed') {
    const method = entry.payments.at(-1)?.method;
    if (method === 'link') return { icon: 'closed', text: 'Closed by link' };
    if (method === 'qr') return { icon: 'closed', text: 'Closed by QR' };
    return { icon: 'closed', text: 'Paid in full' };
  }
  if (entry.link?.status === 'sent') return { icon: 'link', text: 'Link sent' };
  if (entry.paid > 0) return { icon: 'open', text: `Paid ${formatMoney(entry.paid)}` };
  return { icon: 'open', text: 'Nothing paid yet' };
}

export function LedgerRow({ entry, first, last }: LedgerRowProps) {
  const open = entry.status === 'open';
  const { icon, text } = describe(entry);

  // Demo only: the customer pays the link, and Pari announces it like a real payment.
  const payLink =
    env.demoTools && open && entry.link?.status === 'sent'
      ? () => {
          if (process.env.EXPO_OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          simulateLinkPaid(entry.id).catch(() => {});
        }
      : undefined;

  return (
    <Pressable
      onLongPress={payLink}
      disabled={!payLink}
      style={[styles.row, first && styles.first, last && styles.last]}>
      <Avatar name={entry.customer.name} size={AVATAR} />
      <View style={styles.body}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {entry.customer.name}
        </AppText>
        <View style={styles.meta}>
          <Icon name={icon} size={13} color={open ? colors.due : colors.textTertiary} />
          <AppText variant="caption" numberOfLines={1} style={styles.metaText}>
            {`${text} · ${formatTime(lastActivity(entry))}`}
          </AppText>
        </View>
      </View>
      <View style={styles.amount}>
        <AppText variant="bodyStrong" color={open ? colors.due : colors.textSecondary} style={styles.figure}>
          {formatMoney(open ? entry.pending : entry.total)}
        </AppText>
        <AppText variant="caption" color={colors.textTertiary}>
          {open ? 'baaki' : 'paid'}
        </AppText>
      </View>
      {last ? null : <View style={styles.divider} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: INSET,
    paddingVertical: 14,
    backgroundColor: colors.surface,
  },
  first: {
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
  },
  last: {
    borderBottomLeftRadius: radii.lg,
    borderBottomRightRadius: radii.lg,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  metaText: {
    flexShrink: 1,
  },
  amount: {
    alignItems: 'flex-end',
    gap: 1,
  },
  figure: {
    fontVariant: ['tabular-nums'],
  },
  divider: {
    position: 'absolute',
    left: INSET + AVATAR + spacing.sm,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
});
