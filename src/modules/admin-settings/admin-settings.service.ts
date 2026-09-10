import * as repo from './admin-settings.repository.js';
import { encryptString, decryptString } from '../../lib/encryption.js';
import type { BusinessSettings, TaxSettings, PaymentSettings, NotificationSettings, SecuritySettings, DeliveryMethods } from './admin-settings.schemas.js';

export async function getBusinessSettings(): Promise<BusinessSettings> {
  return await repo.getSettingsGroup('business');
}

export async function updateBusinessSettings(payload: BusinessSettings, actorId: string): Promise<BusinessSettings> {
  return (await repo.upsertSettingsGroup('business', payload, actorId)) as BusinessSettings;
}

export async function getTaxSettings(): Promise<TaxSettings> {
  return await repo.getSettingsGroup('tax');
}

export async function updateTaxSettings(payload: TaxSettings, actorId: string): Promise<TaxSettings> {
  return (await repo.upsertSettingsGroup('tax', payload, actorId)) as TaxSettings;
}

export async function getPaymentSettings(): Promise<PaymentSettings> {
  const settings = (await repo.getSettingsGroup('payments')) as PaymentSettings;
  
  // Decrypt Razorpay keySecret if it exists
  if (settings?.gateways?.razorpay?.keySecret) {
    settings.gateways.razorpay.keySecret = decryptString(settings.gateways.razorpay.keySecret);
  }
  
  return settings;
}

export async function updatePaymentSettings(payload: PaymentSettings, actorId: string): Promise<PaymentSettings> {
  // We want to encrypt the Razorpay keySecret before saving
  if (payload?.gateways?.razorpay?.keySecret) {
    // Check if it's already encrypted (i.e. if the frontend passed back the masked/encrypted string unchanged)
    // For safety, we only encrypt if it doesn't look like our encrypted format
    if (!payload.gateways.razorpay.keySecret.includes(':')) {
      payload.gateways.razorpay.keySecret = encryptString(payload.gateways.razorpay.keySecret);
    }
  }
  
  const updated = (await repo.upsertSettingsGroup('payments', payload, actorId)) as PaymentSettings;
  
  // Return the decrypted format back to the client immediately after save
  if (updated?.gateways?.razorpay?.keySecret) {
    updated.gateways.razorpay.keySecret = decryptString(updated.gateways.razorpay.keySecret);
  }
  
  return updated;
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  return await repo.getSettingsGroup('notifications');
}

export async function updateNotificationSettings(payload: NotificationSettings, actorId: string): Promise<NotificationSettings> {
  return (await repo.upsertSettingsGroup('notifications', payload, actorId)) as NotificationSettings;
}

export async function getSecuritySettings(): Promise<SecuritySettings> {
  return await repo.getSettingsGroup('security');
}

export async function updateSecuritySettings(payload: SecuritySettings, actorId: string): Promise<SecuritySettings> {
  return (await repo.upsertSettingsGroup('security', payload, actorId)) as SecuritySettings;
}

/* -------------------------------------------------------- Delivery Methods */
export const DEFAULT_DELIVERY_METHODS: DeliveryMethods = [
  {
    id: 'standard',
    apiValue: 'standard',
    label: 'Standard delivery (Lucknow)',
    eta: '1–3 working days',
    pricePaise: 0,
    price: 0,
    enabled: true,
    sortOrder: 1,
  },
  {
    id: 'express',
    apiValue: 'scheduled',
    label: 'Express delivery (Lucknow)',
    eta: 'Next working day',
    pricePaise: 24_900,
    price: 249,
    enabled: true,
    sortOrder: 2,
  },
  {
    id: 'same-day',
    apiValue: 'same_day',
    label: 'Same-day (across Lucknow)',
    eta: 'Today, before 9 PM',
    pricePaise: 49_900,
    price: 499,
    enabled: true,
    sortOrder: 3,
  },
  {
    id: 'midnight',
    apiValue: 'midnight',
    label: 'Midnight delivery (Lucknow)',
    eta: 'Tonight, 11 PM – 12 AM',
    pricePaise: 49_900,
    price: 499,
    enabled: false,
    sortOrder: 4,
  },
];

export async function getDeliveryMethodsSettings(onlyEnabled = false): Promise<DeliveryMethods> {
  try {
    const raw = await repo.getSettingsGroup('storefront.delivery_methods');
    const list: DeliveryMethods =
      Array.isArray(raw) && raw.length > 0 ? (raw as DeliveryMethods) : DEFAULT_DELIVERY_METHODS;

    const normalized = list.map((item) => ({
      ...item,
      price: item.price !== undefined ? item.price : Math.round(item.pricePaise / 100),
    }));

    const filtered = onlyEnabled ? normalized.filter((m) => m.enabled) : normalized;
    return filtered.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  } catch {
    const filtered = onlyEnabled
      ? DEFAULT_DELIVERY_METHODS.filter((m) => m.enabled)
      : DEFAULT_DELIVERY_METHODS;
    return filtered;
  }
}

export async function updateDeliveryMethodsSettings(
  payload: DeliveryMethods,
  actorId: string,
): Promise<DeliveryMethods> {
  const normalized = payload.map((item, index) => {
    const pricePaise = item.pricePaise !== undefined ? item.pricePaise : (item.price ?? 0) * 100;
    return {
      ...item,
      pricePaise,
      price: Math.round(pricePaise / 100),
      sortOrder: item.sortOrder ?? index + 1,
    };
  });

  await repo.upsertSettingsGroup('storefront.delivery_methods', normalized, actorId, true);
  return normalized;
}

export async function getDeliverySurchargesMap(): Promise<Record<string, number>> {
  const methods = await getDeliveryMethodsSettings(false);
  const map: Record<string, number> = {
    standard: 0,
    scheduled: 24_900,
    same_day: 49_900,
    midnight: 49_900,
    international: 0,
  };

  for (const m of methods) {
    if (m.apiValue) {
      map[m.apiValue] = m.pricePaise;
    }
  }

  // Standard fulfillment is always free (0 paise surcharge)
  map.standard = 0;

  return map;
}

