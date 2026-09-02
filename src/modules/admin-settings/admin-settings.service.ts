import * as repo from './admin-settings.repository.js';
import { encryptString, decryptString } from '../../lib/encryption.js';
import type { BusinessSettings, TaxSettings, PaymentSettings, NotificationSettings, SecuritySettings } from './admin-settings.schemas.js';

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
