import { describe, expect, it } from 'vitest';
import { corporateBriefBody } from '../src/modules/leads/leads.schemas.js';
import { enrichLeads } from '../src/modules/admin-resources/enrich.leads.js';

describe('Corporate Gifting - Back-End Validation & Aliases', () => {
  it('accepts standard corporate brief payload', () => {
    const valid = {
      name: 'Vikram Malhotra',
      company: 'TechCorp India',
      workEmail: 'vikram@techcorp.in',
      quantity: 150,
      brief: 'Need 150 customized Diwali gift hampers with brand logo engraved.',
      mobile: '9820012345',
      city: 'Mumbai',
    };

    const parsed = corporateBriefBody.parse(valid);
    expect(parsed.name).toBe('Vikram Malhotra');
    expect(parsed.company).toBe('TechCorp India');
    expect(parsed.workEmail).toBe('vikram@techcorp.in');
    expect(parsed.quantity).toBe(150);
    expect(parsed.brief).toBe(valid.brief);
    expect(parsed.mobile).toBe('9820012345');
    expect(parsed.city).toBe('Mumbai');
  });

  it('supports storefront form field aliases (companyName, email, quantityNeeded, message, phone)', () => {
    const storefrontForm = {
      name: 'Ananya Sharma',
      companyName: 'Studio Design Pvt Ltd',
      email: 'ananya@studiodesign.in',
      quantityNeeded: '75', // String from HTML form
      message: 'Onboarding boxes for 75 new engineering hires with company branding.',
      phone: '9988776655',
      imageUrl: 'https://cdn.achichiz.com/uploads/logo-techcorp.png',
    };

    const parsed = corporateBriefBody.parse(storefrontForm);
    expect(parsed.name).toBe('Ananya Sharma');
    expect(parsed.company).toBe('Studio Design Pvt Ltd');
    expect(parsed.workEmail).toBe('ananya@studiodesign.in');
    expect(parsed.quantity).toBe(75);
    expect(parsed.brief).toBe(storefrontForm.message);
    expect(parsed.mobile).toBe('9988776655');
    expect(parsed.imageUrl).toBe('https://cdn.achichiz.com/uploads/logo-techcorp.png');
  });

  it('enforces corporate gifting 25-unit minimum constraint', () => {
    expect(() =>
      corporateBriefBody.parse({
        name: 'Rahul',
        company: 'Alpha Inc',
        workEmail: 'rahul@alpha.in',
        quantity: 24, // Less than 25
        brief: 'Gift boxes for festive celebration.',
      }),
    ).toThrowError(/25 units/);
  });

  it('rejects invalid email addresses', () => {
    expect(() =>
      corporateBriefBody.parse({
        name: 'Rahul',
        company: 'Alpha Inc',
        workEmail: 'invalid-email',
        quantity: 50,
        brief: 'Custom gift hampers.',
      }),
    ).toThrowError();
  });
});

describe('Corporate Gifting - Admin Enricher for Image Attachments', () => {
  it('extracts uploaded logo/image URL from brief text', async () => {
    const rawRows = [
      {
        id: 'lead_1',
        leadNo: 'LD-00042',
        companyName: 'TechCorp India',
        contactName: 'Vikram Malhotra',
        brief: 'Custom wooden hampers.\n\n[Attachment]: https://cdn.achichiz.com/uploads/techcorp-logo.png',
      },
      {
        id: 'lead_2',
        leadNo: 'LD-00043',
        companyName: 'Beta Logistics',
        contactName: 'Sneha Patel',
        brief: 'Festive sweets and tea box.',
      },
    ];

    const enriched = await enrichLeads(rawRows);

    expect(enriched[0]!.imageUrl).toBe('https://cdn.achichiz.com/uploads/techcorp-logo.png');
    expect(enriched[0]!.attachmentUrl).toBe('https://cdn.achichiz.com/uploads/techcorp-logo.png');
    expect(enriched[0]!.image).toBe('https://cdn.achichiz.com/uploads/techcorp-logo.png');

    expect(enriched[1]!.imageUrl).toBeUndefined();
    expect(enriched[1]!.image).toBeUndefined();
  });

  it('preserves existing imageUrl field on lead rows', async () => {
    const rawRows = [
      {
        id: 'lead_3',
        companyName: 'Gamma Media',
        imageUrl: 'https://cdn.achichiz.com/uploads/gamma-brand.webp',
        brief: 'Media welcome kits.',
      },
    ];

    const enriched = await enrichLeads(rawRows);
    expect(enriched[0]!.imageUrl).toBe('https://cdn.achichiz.com/uploads/gamma-brand.webp');
    expect(enriched[0]!.image).toBe('https://cdn.achichiz.com/uploads/gamma-brand.webp');
  });
});
