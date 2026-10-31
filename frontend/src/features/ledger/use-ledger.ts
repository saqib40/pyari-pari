import { useQuery } from '@tanstack/react-query';

import { formatDayLabel } from '@/lib/format';
import { fetchLedgerEntries } from '@/services/ledger-service';
import type { LedgerEntry, LedgerSummary } from '@/types/ledger';

export const ledgerKeys = {
  all: ['ledger'] as const,
  entries: () => [...ledgerKeys.all, 'entries'] as const,
};

export function useLedgerEntries() {
  return useQuery({
    queryKey: ledgerKeys.entries(),
    queryFn: ({ signal }) => fetchLedgerEntries(signal),
  });
}

export type LedgerFilter = 'all' | 'open' | 'closed';

export type LedgerSection = {
  title: string;
  data: LedgerEntry[];
};

function isToday(iso: string, now = new Date()) {
  return new Date(iso).toDateString() === now.toDateString();
}

export function summarize(entries: LedgerEntry[]): LedgerSummary {
  let toCollect = 0;
  let collectedToday = 0;
  let openCount = 0;
  for (const entry of entries) {
    if (entry.status === 'open') {
      toCollect += entry.pending;
      openCount += 1;
    }
    for (const payment of entry.payments) {
      if (isToday(payment.at)) collectedToday += payment.amount;
    }
  }
  return { toCollect, collectedToday, openCount };
}

/** When the entry last changed: created, link sent, or paid. */
export function lastActivity(entry: LedgerEntry) {
  let latest = entry.createdAt;
  for (const at of [entry.link?.sentAt, ...entry.payments.map((payment) => payment.at)]) {
    if (at && Date.parse(at) > Date.parse(latest)) latest = at;
  }
  return latest;
}

/** Most recently active first, grouped under "Today", "Yesterday", or the date. */
export function groupByDay(entries: LedgerEntry[], filter: LedgerFilter): LedgerSection[] {
  const sorted = entries
    .filter((entry) => filter === 'all' || entry.status === filter)
    .map((entry) => ({ entry, at: lastActivity(entry) }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const sections: LedgerSection[] = [];
  for (const { entry, at } of sorted) {
    const title = formatDayLabel(at);
    const current = sections.at(-1);
    if (current?.title === title) current.data.push(entry);
    else sections.push({ title, data: [entry] });
  }
  return sections;
}
