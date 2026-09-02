import { z } from 'zod';

// Base API error schema for OpenAPI responses
export const apiError = z.object({
  type: z.literal('error'),
  result: z.object({
    title: z.string(),
    status: z.number(),
    code: z.string(),
    detail: z.string(),
    instance: z.string(),
    requestId: z.string(),
  }),
});

/* ------------------------------------------------------------- Business */
export const businessSettingsSchema = z.object({
  brandIdentity: z.object({
    storeName: z.string(),
    legalEntity: z.string(),
    supportEmail: z.string().email(),
    supportPhone: z.string(),
    tagline: z.string(),
  }).optional(),
  registeredAddress: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    pincode: z.string(),
  }).optional(),
  cin: z.string().optional(),
  operationsDefaults: z.object({
    currency: z.string().default('INR'),
  }).optional(),
  storefrontSwitches: z.object({
    acceptNewOrders: z.boolean().default(true),
  }).optional(),
});

export const updateBusinessSettingsBody = businessSettingsSchema;

/* ------------------------------------------------------------------ Tax */
export const taxSettingsSchema = z.object({
  registration: z.object({
    gstin: z.string().optional(),
    pan: z.string().optional(),
    defaultPlaceOfSupply: z.string().optional(),
    invoiceSeries: z.string().optional(),
  }).optional(),
  calculationRules: z.object({
    pricesIncludeGst: z.boolean().default(true),
    chargeGstOnShipping: z.boolean().default(true),
    chargeGstOnGiftWrap: z.boolean().default(true),
    autoIgstForInterState: z.boolean().default(true),
    reverseChargeForCorporate: z.boolean().default(false),
  }).optional(),
});

export const updateTaxSettingsBody = taxSettingsSchema;

/* ------------------------------------------------------------- Payments */
export const paymentSettingsSchema = z.object({
  gateways: z.object({
    razorpay: z.object({
      enabled: z.boolean(),
      keyId: z.string().optional(),
      keySecret: z.string().optional(), // In the response, we might mask this
    }).optional(),
    payu: z.object({
      enabled: z.boolean(),
    }).optional(),
    cashfree: z.object({
      enabled: z.boolean(),
    }).optional(),
  }).optional(),
  cashOnDelivery: z.object({
    enabled: z.boolean().default(true),
    maxOrderValue: z.number().int().nonnegative().optional(), // in paise
  }).optional(),
  refundsAndCredit: z.object({
    refundWindowDays: z.number().int().nonnegative().default(7),
    defaultCorporateTerms: z.string().default('net_30'),
  }).optional(),
});

export const updatePaymentSettingsBody = paymentSettingsSchema;

/* -------------------------------------------------------- Notifications */
export const notificationSettingsSchema = z.object({
  customerNotifications: z.object({
    order_placed: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    payment_received: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    order_confirmed: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    personalisation_approved: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    order_packed: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    shipped: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    out_for_delivery: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    delivered: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    delivery_failed: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    refund_processed: z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
  }).optional(),
});

export const updateNotificationSettingsBody = notificationSettingsSchema;

// Reusable wrapper schemas
export const settingsResponse = <T extends z.ZodTypeAny>(schema: T) => z.object({
  type: z.literal('success'),
  result: schema,
});

export type BusinessSettings = z.infer<typeof businessSettingsSchema>;
export type TaxSettings = z.infer<typeof taxSettingsSchema>;
export type PaymentSettings = z.infer<typeof paymentSettingsSchema>;
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
/* ------------------------------------------------------------- Security */
export const securitySettingsSchema = z.object({
  accessPolicy: z.object({
    enforce2fa: z.boolean().default(false),
    singleSession: z.boolean().default(true),
    requireReauthForRefunds: z.boolean().default(false),
    restrictToOfficeIp: z.boolean().default(false),
  }).optional(),
  passwordPolicy: z.object({
    minLength: z.number().default(12),
    expiryDays: z.number().default(90),
    idleTimeoutMinutes: z.number().default(30),
  }).optional(),
});

export const updateSecuritySettingsBody = securitySettingsSchema;
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;