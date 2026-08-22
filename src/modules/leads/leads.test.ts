import { describe, expect, it } from 'vitest';
import { addressOf, companyNameFor, normaliseIndianMobile } from './leads.service.js';
import { contactEnquiryBody, corporateBriefBody, newsletterBody } from './leads.schemas.js';

/**
 * Pure tests over lead normalisation and the three form contracts.
 *
 * The normalisers matter more than they look: `corporate_leads.mobile` is the
 * `mobile_in` DOMAIN, which the *database* enforces. Writing a raw
 * `+91 98200 12345` through raises a constraint violation and loses an enquiry
 * that took a customer two minutes to type — which is the exact failure mode this
 * whole module exists to end.
 */

describe('normaliseIndianMobile', () => {
  it('accepts a plain ten-digit number', () => {
    expect(normaliseIndianMobile('9820012345')).toBe('9820012345');
  });

  it('strips the formatting people actually type', () => {
    expect(normaliseIndianMobile('+91 98200 12345')).toBe('9820012345');
    expect(normaliseIndianMobile('098200-12345')).toBe('9820012345');
    expect(normaliseIndianMobile('(+91) 9820-012-345')).toBe('9820012345');
    expect(normaliseIndianMobile('91 9820012345')).toBe('9820012345');
  });

  it('returns null for anything that is not an Indian mobile', () => {
    // A landline or a foreign number is still a lead worth keeping — it is stored
    // in the enquiry text and simply not written to the `mobile_in` column.
    expect(normaliseIndianMobile('022 2640 1234')).toBeNull();
    expect(normaliseIndianMobile('5820012345')).toBeNull();
    expect(normaliseIndianMobile('982001234')).toBeNull();
    expect(normaliseIndianMobile('not a number')).toBeNull();
    expect(normaliseIndianMobile(undefined)).toBeNull();
    expect(normaliseIndianMobile('')).toBeNull();
  });

  it('takes the last ten digits, not the first', () => {
    // `+919820012345` has a country code in front; slicing from the left would
    // produce `9198200123`, a plausible-looking number that belongs to nobody.
    expect(normaliseIndianMobile('00919820012345')).toBe('9820012345');
  });
});

describe('companyNameFor', () => {
  it('uses the company when one was given', () => {
    expect(companyNameFor('Tata Elxsi', 'Arjun Mehta')).toBe('Tata Elxsi');
  });

  it('falls back to the person for a B2C enquiry', () => {
    // `corporate_leads.company_name` is NOT NULL. A placeholder like "Individual"
    // would make every B2C enquiry collide in `idx_leads_search` and read as one
    // anonymous blob on the admin's lead board.
    expect(companyNameFor(undefined, 'Arjun Mehta')).toBe('Arjun Mehta');
    expect(companyNameFor('', 'Arjun Mehta')).toBe('Arjun Mehta');
    expect(companyNameFor('   ', 'Arjun Mehta')).toBe('Arjun Mehta');
  });
});

describe('addressOf', () => {
  it('extracts the address from a display-name From header', () => {
    expect(addressOf('Achichiz <connect@achiachi.in>')).toBe('connect@achiachi.in');
  });

  it('passes a bare address through', () => {
    expect(addressOf('connect@achiachi.in')).toBe('connect@achiachi.in');
  });
});

describe('contact enquiry contract', () => {
  const valid = {
    name: 'Arjun Mehta',
    email: 'arjun@example.com',
    message: 'Do you ship engraved diaries to Pune by Friday?',
  };

  it('accepts the storefront form’s exact fields', () => {
    expect(contactEnquiryBody.safeParse(valid).success).toBe(true);
  });

  it('requires a message with something in it', () => {
    expect(contactEnquiryBody.safeParse({ ...valid, message: 'hi' }).success).toBe(false);
  });

  it('accepts a landline in the phone field', () => {
    expect(contactEnquiryBody.safeParse({ ...valid, phone: '022 2640 1234' }).success).toBe(true);
  });

  it('rejects a phone field carrying something other than a number', () => {
    expect(contactEnquiryBody.safeParse({ ...valid, phone: 'call me maybe' }).success).toBe(false);
  });
});

describe('corporate gifting contract', () => {
  const valid = {
    name: 'Arjun Mehta',
    company: 'Tata Elxsi',
    workEmail: 'arjun@tataelxsi.com',
    quantity: 250,
    brief: 'Diwali hampers for the Bangalore office, budget ₹2,500 per box, branded sleeve.',
  };

  it('accepts a well-formed brief', () => {
    expect(corporateBriefBody.safeParse(valid).success).toBe(true);
  });

  it('enforces the 25-unit minimum server-side, at the boundary', () => {
    // The storefront expresses this as `min={25}` on an `<input>`, which any
    // direct API call ignores. A brief for three mugs entering the corporate
    // pipeline costs a salesperson an afternoon.
    expect(corporateBriefBody.safeParse({ ...valid, quantity: 24 }).success).toBe(false);
    expect(corporateBriefBody.safeParse({ ...valid, quantity: 25 }).success).toBe(true);
  });

  it('rejects a fractional or negative quantity', () => {
    expect(corporateBriefBody.safeParse({ ...valid, quantity: 30.5 }).success).toBe(false);
    expect(corporateBriefBody.safeParse({ ...valid, quantity: -100 }).success).toBe(false);
  });

  it('rejects a malformed work email', () => {
    expect(corporateBriefBody.safeParse({ ...valid, workEmail: 'arjun@' }).success).toBe(false);
  });

  it('leaves the optional enrichment fields optional', () => {
    const parsed = corporateBriefBody.parse(valid);
    expect(parsed.mobile).toBeUndefined();
    expect(parsed.employeeCount).toBeUndefined();
    expect(parsed.city).toBeUndefined();
    expect(parsed.occasion).toBeUndefined();
  });
});

describe('newsletter contract', () => {
  it('defaults the consent source to the footer form', () => {
    // Consent needs provenance: "which control did they use" is part of the
    // record, so it cannot be left undefined.
    expect(newsletterBody.parse({ email: 'arjun@example.com' }).source).toBe('footer');
  });

  it('accepts the other opt-in points', () => {
    for (const source of ['profile', 'checkout', 'popup']) {
      expect(newsletterBody.safeParse({ email: 'a@b.com', source }).success).toBe(true);
    }
  });

  it('rejects an unknown source rather than recording a free-text one', () => {
    expect(newsletterBody.safeParse({ email: 'a@b.com', source: 'wherever' }).success).toBe(false);
  });

  it('rejects a malformed address', () => {
    expect(newsletterBody.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});
