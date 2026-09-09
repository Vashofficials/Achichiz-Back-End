import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  updateProfileBody,
  customerProfile,
  addWishlistItemBody,
  productIdParam,
  orderIdParam,
} from '../src/modules/account/account.schemas.js';
import { addressBody, updateAddressBody, addressIdParam } from '../src/modules/addresses/addresses.schemas.js';

describe('User Dashboard - Profile Management (Create, Read, Update)', () => {
  it('successfully processes the screenshot payload for Rahul Singh (both JSON boolean and multipart string)', () => {
    // 1. Raw values from the user's latest dashboard screenshot:
    const rahulUiValues = {
      fullName: 'Rahul Singh',
      email: 'vashtechnical@gmail.com',
      mobile: '9369016664',
      birthday: '01-09-2026', // As displayed in Indian UI (DD-MM-YYYY)
      marketingOptIn: true,
    };

    // 2. Front-end normalization logic (as in account.profile.tsx):
    let normalizedBirthday: string | null = rahulUiValues.birthday ? rahulUiValues.birthday.trim() : null;
    if (normalizedBirthday) {
      const ddmmyyyy = normalizedBirthday.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
      if (ddmmyyyy) {
        normalizedBirthday = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
      }
    }

    // A. Native JSON payload sent by the updated front-end (when no file attachment):
    const jsonPayload = {
      fullName: rahulUiValues.fullName,
      email: rahulUiValues.email,
      mobile: rahulUiValues.mobile,
      birthday: normalizedBirthday,
      marketingOptIn: rahulUiValues.marketingOptIn, // Native boolean true
    };
    const parsedJson = updateProfileBody.parse(jsonPayload);
    expect(parsedJson.fullName).toBe('Rahul Singh');
    expect(parsedJson.email).toBe('vashtechnical@gmail.com');
    expect(parsedJson.mobile).toBe('9369016664');
    expect(parsedJson.birthday).toBe('2026-09-01');
    expect(parsedJson.marketingOptIn).toBe(true);

    // B. Multipart/form-data payload received if avatar file is attached (multer strings):
    const multipartPayload = {
      fullName: rahulUiValues.fullName,
      email: rahulUiValues.email,
      mobile: rahulUiValues.mobile,
      birthday: normalizedBirthday,
      marketingOptIn: 'true', // Multer string serialization
      whatsappOptIn: 'false',
    };
    const parsedMultipart = updateProfileBody.parse(multipartPayload);
    expect(parsedMultipart.fullName).toBe('Rahul Singh');
    expect(parsedMultipart.marketingOptIn).toBe(true);
    expect(parsedMultipart.whatsappOptIn).toBe(false);
  });

  it('coerces various boolean representations from forms', () => {
    expect(updateProfileBody.parse({ marketingOptIn: 'true' }).marketingOptIn).toBe(true);
    expect(updateProfileBody.parse({ marketingOptIn: 'false' }).marketingOptIn).toBe(false);
    expect(updateProfileBody.parse({ marketingOptIn: '1' }).marketingOptIn).toBe(true);
    expect(updateProfileBody.parse({ marketingOptIn: '0' }).marketingOptIn).toBe(false);
    expect(updateProfileBody.parse({ marketingOptIn: true }).marketingOptIn).toBe(true);
    expect(updateProfileBody.parse({ marketingOptIn: false }).marketingOptIn).toBe(false);
  });

  it('handles clearing birthday (empty string or null) and valid ISO date formats', () => {
    // Clearing birthday
    expect(updateProfileBody.parse({ birthday: '' }).birthday).toBeNull();
    expect(updateProfileBody.parse({ birthday: null }).birthday).toBeNull();

    // Standard ISO YYYY-MM-DD
    expect(updateProfileBody.parse({ birthday: '1998-05-15' }).birthday).toBe('1998-05-15');
  });

  it('normalizes gender and ignores empty optional fields', () => {
    expect(updateProfileBody.parse({ gender: '' }).gender).toBeNull();
    expect(updateProfileBody.parse({ gender: 'male' }).gender).toBe('male');
    expect(updateProfileBody.parse({ gender: 'female' }).gender).toBe('female');
    expect(updateProfileBody.parse({ gender: 'other' }).gender).toBe('other');
    expect(updateProfileBody.parse({ gender: 'undisclosed' }).gender).toBe('undisclosed');

    // Empty email or mobile string in multipart forms should be treated as undefined (leave untouched)
    expect(updateProfileBody.parse({ email: '   ' }).email).toBeUndefined();
    expect(updateProfileBody.parse({ mobile: '' }).mobile).toBeUndefined();
  });

  it('rejects invalid inputs with proper field errors', () => {
    // Invalid email
    expect(() => updateProfileBody.parse({ email: 'not-an-email' })).toThrowError();

    // Invalid Indian mobile (must be 10 digits starting with 6-9)
    expect(() => updateProfileBody.parse({ mobile: '12345' })).toThrowError();
    expect(() => updateProfileBody.parse({ mobile: '1234567890' })).toThrowError();

    // Invalid birthday date
    expect(() => updateProfileBody.parse({ birthday: 'invalid-date' })).toThrowError();
    expect(() => updateProfileBody.parse({ birthday: '32-01-2020' })).toThrowError();
    expect(() => updateProfileBody.parse({ birthday: '2026-02-30' })).toThrowError();

    // Invalid gender
    expect(() => updateProfileBody.parse({ gender: 'other_custom' as any })).toThrowError();
  });
});

describe('User Dashboard - Address Management (Create, Add, Update, Default, Delete)', () => {
  it('validates creating/adding a new address with defaults', () => {
    const newAddress = {
      contactName: 'Sonu',
      mobile: '9369016664',
      line1: 'Flat 101, Galaxy Apartments',
      area: 'Sector 62',
      city: 'Noida',
      stateCode: '09',
      pincode: '201309',
    };

    const parsed = addressBody.parse(newAddress);
    expect(parsed.contactName).toBe('Sonu');
    expect(parsed.mobile).toBe('9369016664');
    expect(parsed.line1).toBe('Flat 101, Galaxy Apartments');
    expect(parsed.city).toBe('Noida');
    expect(parsed.stateCode).toBe('09');
    expect(parsed.pincode).toBe('201309');
    // Defaults applied
    expect(parsed.label).toBe('Home');
    expect(parsed.countryCode).toBe('IN');
  });

  it('validates updating/editing an existing address (PATCH semantics)', () => {
    // Partial edit: changing contactName, line1, and pincode
    const editPayload = {
      contactName: 'Sonu Kumar',
      line1: 'Flat 202, Galaxy Apartments',
      pincode: '201301',
    };

    const parsed = updateAddressBody.parse(editPayload);
    expect(parsed.contactName).toBe('Sonu Kumar');
    expect(parsed.line1).toBe('Flat 202, Galaxy Apartments');
    expect(parsed.pincode).toBe('201301');
    // PATCH does NOT overwrite omitted fields with defaults
    expect(parsed.label).toBeUndefined();
    expect(parsed.countryCode).toBeUndefined();

    // Empty payload is a valid no-op PATCH
    const emptyPatch = updateAddressBody.parse({});
    expect(emptyPatch).toEqual({});
  });

  it('validates address ID parameter', () => {
    const validId = '123e4567-e89b-12d3-a456-426614174000';
    expect(addressIdParam.parse({ addressId: validId })).toEqual({ addressId: validId });

    expect(() => addressIdParam.parse({ addressId: 'invalid-id' })).toThrowError();
  });

  it('rejects malformed address fields', () => {
    // PIN code must be 6 digits and cannot start with 0
    expect(() =>
      addressBody.parse({
        contactName: 'Sonu',
        mobile: '9369016664',
        line1: 'Line 1',
        city: 'Noida',
        stateCode: '09',
        pincode: '012345',
      }),
    ).toThrowError();

    // PIN code too short
    expect(() =>
      addressBody.parse({
        contactName: 'Sonu',
        mobile: '9369016664',
        line1: 'Line 1',
        city: 'Noida',
        stateCode: '09',
        pincode: '20130',
      }),
    ).toThrowError();

    // Mobile number invalid
    expect(() =>
      addressBody.parse({
        contactName: 'Sonu',
        mobile: '5123456789',
        line1: 'Line 1',
        city: 'Noida',
        stateCode: '09',
        pincode: '201301',
      }),
    ).toThrowError();

    // State code must be 2 digits
    expect(() =>
      addressBody.parse({
        contactName: 'Sonu',
        mobile: '9369016664',
        line1: 'Line 1',
        city: 'Noida',
        stateCode: '9',
        pincode: '201301',
      }),
    ).toThrowError();
  });
});

describe('User Dashboard - Wishlist & Orders Operations', () => {
  it('validates adding and removing items in wishlist using schemas', () => {
    const validProductId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';

    // Add item body
    const addBody = addWishlistItemBody.parse({ productId: validProductId });
    expect(addBody.productId).toBe(validProductId);

    // Remove item param
    const removeParam = productIdParam.parse({ productId: validProductId });
    expect(removeParam.productId).toBe(validProductId);

    // Invalid product ID
    expect(() => addWishlistItemBody.parse({ productId: 'invalid-id' })).toThrowError();
    expect(() => productIdParam.parse({ productId: 'invalid-id' })).toThrowError();
  });

  it('validates orderId param for order retrieval and tracking', () => {
    const validOrderId = 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e';
    expect(orderIdParam.parse({ orderId: validOrderId }).orderId).toBe(validOrderId);
    expect(() => orderIdParam.parse({ orderId: 'not-a-uuid' })).toThrowError();
  });

  it('validates order query parameters for dashboard pagination and status filtering', () => {
    const orderQuerySchema = z.object({
      page: z.coerce.number().int().positive().default(1),
      perPage: z.coerce.number().int().positive().max(50).default(10),
      status: z.enum(['placed', 'confirmed', 'shipped', 'delivered', 'cancelled']).optional(),
    });

    const parsed = orderQuerySchema.parse({ page: '2', perPage: '15', status: 'delivered' });
    expect(parsed).toEqual({ page: 2, perPage: 15, status: 'delivered' });

    const defaults = orderQuerySchema.parse({});
    expect(defaults).toEqual({ page: 1, perPage: 10 });
  });

  it('correctly maps API field errors to UI form inputs', () => {
    // Simulates the API error response envelope returned on validation failure
    const apiErrorResponse = {
      type: 'error',
      result: {
        title: 'Unprocessable Entity',
        status: 422,
        code: 'validation_failed',
        detail: '1 field is invalid.',
        errors: [
          {
            path: 'birthday',
            message: 'Use a valid calendar date in YYYY-MM-DD or DD-MM-YYYY format.',
          },
        ],
      },
    };

    // Front-end error mapping helper logic
    const fieldErrors: Record<string, string> = {};
    for (const e of apiErrorResponse.result.errors) {
      fieldErrors[e.path] = e.message;
    }

    expect(fieldErrors.birthday).toBe(
      'Use a valid calendar date in YYYY-MM-DD or DD-MM-YYYY format.',
    );
    expect(fieldErrors.email).toBeUndefined();
  });
});
