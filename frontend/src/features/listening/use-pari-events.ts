import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { ledgerKeys } from '@/features/ledger/use-ledger';
import { qrPaymentKeys } from '@/features/qr/use-qr-payments';
import { subscribeToPariEvents } from '@/services/events-service';
import { toLedgerEntry } from '@/services/ledger-service';

import { announce, showTurn } from './conversation-store';

/** Keeps every tab current as entries change and payments arrive, and lets Pari speak up from any tab. */
export function usePariEvents() {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToPariEvents((event) => {
        void queryClient.invalidateQueries({ queryKey: ledgerKeys.all });
        void queryClient.invalidateQueries({ queryKey: qrPaymentKeys.all });
        switch (event.type) {
          case 'pari.prompt':
            showTurn({ state: event.state, reply: event.line });
            break;
          case 'payment.received':
            announce(event.line, event.entry && toLedgerEntry(event.entry));
            break;
          case 'pari.announce':
            announce(event.line);
            break;
        }
      }),
    [queryClient],
  );
}
