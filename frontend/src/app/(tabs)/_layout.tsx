import { Tabs } from 'expo-router/js-tabs';

import { TabBar } from '@/components/navigation/tab-bar';
import { Icon } from '@/components/ui/icon';
import { usePariEvents } from '@/features/listening/use-pari-events';
import { useQrPayments } from '@/features/qr/use-qr-payments';
import { colors } from '@/theme';

export default function TabsLayout() {
  usePariEvents();
  const toMatch = useQrPayments().data?.length ?? 0;

  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        animation: 'fade',
        sceneStyle: { backgroundColor: colors.background },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Listen',
          tabBarIcon: ({ focused, color, size }) => (
            <Icon name={focused ? 'listenFilled' : 'listen'} size={size} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="qr"
        options={{
          title: 'QR',
          tabBarBadge: toMatch > 0 ? toMatch : undefined,
          tabBarAccessibilityLabel:
            toMatch > 0 ? `QR, ${toMatch} ${toMatch === 1 ? 'payment' : 'payments'} to match` : 'QR',
          tabBarIcon: ({ color, size }) => <Icon name="qr" size={size} color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="ledger"
        options={{
          title: 'Ledger',
          tabBarIcon: ({ focused, color, size }) => (
            <Icon name={focused ? 'ledgerFilled' : 'ledger'} size={size} color={String(color)} />
          ),
        }}
      />
    </Tabs>
  );
}
