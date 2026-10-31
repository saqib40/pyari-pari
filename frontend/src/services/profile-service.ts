import type { MerchantDto } from '@/types/api';
import type { Profile } from '@/types/profile';

import { api } from './api-client';

export async function fetchProfile(signal?: AbortSignal): Promise<Profile> {
  const me = await api.get<MerchantDto>('/me', signal);
  return { id: me.id, businessName: me.name, paymentAddress: me.upiId, qrPayload: me.qrPayload };
}
