import type { ContentPageDetail } from './content.schemas.js';

export type PolicySlug = 'shipping' | 'returns' | 'privacy' | 'terms' | 'cookies';

export const POLICY_ALIAS_MAP: Record<string, PolicySlug> = {
  shipping: 'shipping',
  'shipping-policy': 'shipping',
  delivery: 'shipping',
  'shipping-and-delivery': 'shipping',

  returns: 'returns',
  'returns-and-refunds': 'returns',
  'returns-refunds': 'returns',
  refunds: 'returns',
  'refund-policy': 'returns',
  'cancellations-and-refunds': 'returns',

  privacy: 'privacy',
  'privacy-policy': 'privacy',
  data: 'privacy',

  terms: 'terms',
  'terms-of-service': 'terms',
  'terms-and-conditions': 'terms',
  tos: 'terms',

  cookies: 'cookies',
  'cookie-policy': 'cookies',
};

export function normalizePolicySlug(slug: string): PolicySlug | null {
  const normalized = slug.trim().toLowerCase();
  return POLICY_ALIAS_MAP[normalized] ?? null;
}

export const CANONICAL_POLICIES: Record<PolicySlug, ContentPageDetail> = {
  shipping: {
    id: 'b1000000-0000-4000-8000-000000000001',
    slug: 'shipping',
    kind: 'policy',
    title: 'Shipping Policy',
    heading: 'Shipping & Delivery Policy',
    heroImage: null,
    collectionHandle: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    body: [
      {
        type: 'paragraph',
        text: 'At Achichiz (HARIVON ENTERPRISES PRIVATE LIMITED), every handcrafted piece is created with love and packed with sustainable, earth-conscious materials. We are committed to delivering your orders safely, promptly, and responsibly across Lucknow and throughout India.',
      },
      {
        type: 'heading',
        text: 'Dispatch & Delivery Timelines',
      },
      {
        type: 'paragraph',
        text: 'Because our items are handcrafted in small batches, orders are prepared and dispatched from our Lucknow studio within 24 to 48 hours of confirmation (excluding Sundays and national holidays). Personalised and custom-engraved orders require 1 to 2 additional business days.',
      },
      {
        type: 'list',
        items: [
          'Lucknow Local Deliveries: Delivered within 24 hours of dispatch via local studio couriers.',
          'Metro Cities (Delhi NCR, Mumbai, Bengaluru, Kolkata, Chennai, Hyderabad): 2 to 4 business days.',
          'Rest of India (Tier 2 & 3 Cities, Regional Towns): 4 to 7 business days.',
          'Remote Locations & Special Pin Codes (J&K, North-East, Island Territories): 7 to 10 business days.',
        ],
      },
      {
        type: 'heading',
        text: 'Shipping Charges & Thresholds',
      },
      {
        type: 'list',
        items: [
          'Standard Delivery across India is completely FREE on all prepaid and COD orders valued at ₹999 or above.',
          'For orders below ₹999, a nominal flat shipping fee of ₹79 is applied at checkout.',
          'Express same-day delivery service within Lucknow city limits is available for ₹149 on orders placed before 1:00 PM.',
        ],
      },
      {
        type: 'heading',
        text: 'Zero-Plastic Eco Packaging',
      },
      {
        type: 'paragraph',
        text: 'We take pride in our zero-plastic packaging philosophy. Your fragile drinkware, delicate jewellery, and soy candles are wrapped in honeycomb kraft paper, cushioned with natural wood wool or shredded recycled carton, and sealed in corrugated boxes with biodegradable paper tape.',
      },
      {
        type: 'heading',
        text: 'Real-Time Order Tracking',
      },
      {
        type: 'paragraph',
        text: 'The moment your package is dispatched, we send you an SMS, WhatsApp message, and email containing your unique Tracking ID / AWB number along with a direct tracking link. You can also visit our Track Order page at any time to monitor your shipment status.',
      },
      {
        type: 'heading',
        text: 'Delivery Attempts & Address Accuracy',
      },
      {
        type: 'paragraph',
        text: 'Our logistics partners (Blue Dart, Delhivery, DTDC) will attempt delivery up to three times. Please ensure complete and accurate shipping details, including nearby landmarks and a working 10-digit mobile number, to prevent delays or return to origin (RTO).',
      },
    ],
    seo: {
      metaTitle: 'Shipping & Delivery Policy | Achichiz Lucknow',
      metaDescription:
        'Read about Achichiz shipping timelines, free delivery thresholds across India, local Lucknow same-day delivery, and eco-friendly packaging standards.',
      canonicalUrl: 'https://achichiz.com/policies/shipping',
      focusKeyword: 'Achichiz shipping policy',
      robotsIndex: true,
      robotsFollow: true,
      ogImageUrl: null,
      structuredData: null,
    },
  },

  returns: {
    id: 'b1000000-0000-4000-8000-000000000002',
    slug: 'returns',
    kind: 'policy',
    title: 'Returns & Refunds',
    heading: 'Returns, Exchanges & Refund Policy',
    heroImage: null,
    collectionHandle: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    body: [
      {
        type: 'paragraph',
        text: 'We want you to be delighted with your Achichiz handcrafted purchases. If an item does not meet your expectations, our dedicated team is here to provide a clear, hassle-free return and exchange process.',
      },
      {
        type: 'heading',
        text: '7-Day Return Window',
      },
      {
        type: 'paragraph',
        text: 'You may request a return or replacement for eligible products within 7 calendar days of confirmed delivery. Requests initiated after 7 days cannot be processed.',
      },
      {
        type: 'heading',
        text: 'Eligibility Requirements',
      },
      {
        type: 'list',
        items: [
          'The item must be unused, unwashed, undamaged, and in the original condition in which you received it.',
          'All original tags, authenticity cards, and eco-packaging materials must be intact.',
          'Proof of purchase, such as your Order ID or tax invoice, must accompany the request.',
        ],
      },
      {
        type: 'heading',
        text: 'Non-Returnable Items',
      },
      {
        type: 'paragraph',
        text: 'To protect artisan livelihoods and maintain strict hygiene standards, the following items are non-returnable:',
      },
      {
        type: 'list',
        items: [
          'Customised, engraved, or personalised gifts (e.g., custom name-engraved bamboo flasks or custom corporate sets).',
          'Gift hampers containing perishable items (such as chocolates, artisanal tea, or organic snacks).',
          'Soy candles with burnt or trimmed wicks, or opened home fragrance essentials.',
          'Items marked as Clearance, Final Sale, or Sample Sale.',
        ],
      },
      {
        type: 'heading',
        text: 'Transit Damage & Defective Products',
      },
      {
        type: 'paragraph',
        text: 'Every order is inspected prior to dispatch. However, if your order arrives damaged or broken during transit, please notify us within 48 hours of delivery. Please email clear photos or an unboxing video to connect@achiachi.in or WhatsApp us at +91 8840741202. We will dispatch an immediate replacement at no cost or issue a 100% refund.',
      },
      {
        type: 'heading',
        text: 'Reverse Pickup & Processing',
      },
      {
        type: 'paragraph',
        text: 'Once approved, we will arrange a reverse courier pickup from your address. If reverse pickup is unserviceable at your location, we will request you to ship the parcel back to our studio and reimburse reasonable courier charges upon receipt.',
      },
      {
        type: 'heading',
        text: 'Refund Timelines',
      },
      {
        type: 'list',
        items: [
          'Prepaid Orders: Refunds are processed back to the original payment source (Card, UPI, Net Banking) within 5 to 7 business days following quality verification.',
          'Cash on Delivery (COD) Orders: Refunds are transferred to your verified bank account via NEFT/IMPS or UPI ID provided during the return request.',
          'Store Credit: You may opt for immediate Store Credit with an added 5% bonus balance, valid for 12 months on any collection.',
        ],
      },
    ],
    seo: {
      metaTitle: 'Returns & Refunds Policy | Achichiz',
      metaDescription:
        'Understand the 7-day hassle-free returns, replacement terms for damaged items, and refund timelines at Achichiz.',
      canonicalUrl: 'https://achichiz.com/policies/returns',
      focusKeyword: 'Achichiz return policy',
      robotsIndex: true,
      robotsFollow: true,
      ogImageUrl: null,
      structuredData: null,
    },
  },

  privacy: {
    id: 'b1000000-0000-4000-8000-000000000003',
    slug: 'privacy',
    kind: 'policy',
    title: 'Privacy Policy',
    heading: 'Privacy Policy & Data Protection',
    heroImage: null,
    collectionHandle: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    body: [
      {
        type: 'paragraph',
        text: 'HARIVON ENTERPRISES PRIVATE LIMITED ("Achichiz", "we", "our", or "us") is committed to protecting your personal privacy. This Privacy Policy details how we collect, use, disclose, and protect your personal information in compliance with the Information Technology Act, 2000 and the Digital Personal Data Protection Act, 2023.',
      },
      {
        type: 'heading',
        text: 'Information We Collect',
      },
      {
        type: 'paragraph',
        text: 'We collect information necessary to fulfill orders, process transactions, and provide an intuitive shopping journey:',
      },
      {
        type: 'list',
        items: [
          'Contact Details: Name, email address, phone number, delivery address, and billing address.',
          'Account Data: Login credentials, profile preferences, saved addresses, and wishlist items.',
          'Transaction Data: Purchase history, payment status, and order totals. Note that payment credentials (credit/debit card numbers) are securely encrypted and processed by RBI-licensed gateways like Razorpay; we never store your payment card numbers or CVVs on our servers.',
          'Device & Usage Data: IP address, browser type, operating system, and browsing activity collected via cookies and log files.',
          'Corporate Gifting Details: Company name, GSTIN, brand identity assets, and delivery rosters for corporate hampers.',
        ],
      },
      {
        type: 'heading',
        text: 'How We Use Your Data',
      },
      {
        type: 'list',
        items: [
          'Processing, fulfilling, and dispatching your orders.',
          'Sending automated order confirmations, shipping updates, and tracking alerts via SMS, email, and WhatsApp.',
          'Assisting with customer support, returns, exchanges, and feedback.',
          'Preventing unauthorized transactions, fraud, and system abuse.',
          'Sending curated newsletter updates and seasonal festive collection alerts when you have opted in.',
        ],
      },
      {
        type: 'heading',
        text: 'Data Sharing & Third Parties',
      },
      {
        type: 'paragraph',
        text: 'We strictly DO NOT sell, rent, or monetize your personal data. We only share essential data with trusted service providers who adhere to strict data security standards:',
      },
      {
        type: 'list',
        items: [
          'Courier and fulfillment partners (Blue Dart, Delhivery, DTDC) to deliver packages to your doorstep.',
          'Payment service providers (Razorpay) to securely process card, net banking, and UPI payments.',
          'Cloud infrastructure and communications providers (AWS, Firebase) for reliable hosting and transactional messages.',
        ],
      },
      {
        type: 'heading',
        text: 'Your Privacy Rights',
      },
      {
        type: 'paragraph',
        text: 'You have the right to access, review, modify, or request the deletion of your personal data stored with us. You can also opt out of marketing communications at any time by clicking the "Unsubscribe" link in any promotional email or contacting us directly.',
      },
      {
        type: 'heading',
        text: 'Grievance Officer & Support',
      },
      {
        type: 'paragraph',
        text: 'For any inquiries, data deletion requests, or grievances regarding our privacy practices, please contact our Grievance Officer at HARIVON ENTERPRISES PRIVATE LIMITED, B-002, I.M.T Estate-II, Wing-B, Aliganj, New Hyderabad, Lucknow – 226007, Uttar Pradesh. Email: connect@achiachi.in / achichizofficial@gmail.com.',
      },
    ],
    seo: {
      metaTitle: 'Privacy Policy | Achichiz Lucknow',
      metaDescription:
        'Discover how Achichiz protects your personal data, secure payment processing, and your rights under Indian privacy regulations.',
      canonicalUrl: 'https://achichiz.com/policies/privacy',
      focusKeyword: 'Achichiz privacy policy',
      robotsIndex: true,
      robotsFollow: true,
      ogImageUrl: null,
      structuredData: null,
    },
  },

  terms: {
    id: 'b1000000-0000-4000-8000-000000000004',
    slug: 'terms',
    kind: 'policy',
    title: 'Terms of Service',
    heading: 'Terms of Service & User Agreement',
    heroImage: null,
    collectionHandle: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    body: [
      {
        type: 'paragraph',
        text: 'Welcome to Achichiz. These Terms of Service ("Terms") govern your access to and use of the website achichiz.com and all related services, products, and features provided by HARIVON ENTERPRISES PRIVATE LIMITED ("Company", "we", "our"). By browsing or purchasing from our platform, you agree to comply with and be bound by these Terms.',
      },
      {
        type: 'heading',
        text: 'Eligibility & User Account',
      },
      {
        type: 'paragraph',
        text: 'By using our site, you represent that you are at least 18 years of age or accessing under the supervision of a parent or legal guardian. You are responsible for safeguarding your account credentials and password, and you accept liability for all activities that occur under your account.',
      },
      {
        type: 'heading',
        text: 'Handcrafted Artistry & Natural Variations',
      },
      {
        type: 'paragraph',
        text: 'Achichiz celebrates natural, artisanal craftsmanship. Our products feature genuine natural bamboo, natural cork, pure soy wax, and handcrafted brass or metals. Because these materials are inherently organic, subtle variations in wood grain, cork density, wax texture, and hand-finished colors are unique characteristics of the craft, not defects.',
      },
      {
        type: 'heading',
        text: 'Pricing, GST & Payments',
      },
      {
        type: 'list',
        items: [
          'All prices are listed in Indian Rupees (INR) and are inclusive of applicable Goods and Services Tax (GST).',
          'We reserve the right to revise product prices, promotional discounts, and availability without prior notice.',
          'In the event of an inadvertent technical pricing error, we reserve the right to cancel the order and issue an immediate full refund before dispatch.',
        ],
      },
      {
        type: 'heading',
        text: 'Order Acceptance & Cancellation',
      },
      {
        type: 'paragraph',
        text: 'Receipt of an order confirmation does not signify our final acceptance. We reserve the right to decline or cancel any order for reasons including inventory shortage, unserviceable pin code, or suspected fraudulent activity. You may cancel non-customised orders anytime before they are dispatched.',
      },
      {
        type: 'heading',
        text: 'Intellectual Property',
      },
      {
        type: 'paragraph',
        text: 'All trademarks, logos, brand names, product designs, packaging illustrations, photography, and written text on this site are the exclusive property of HARIVON ENTERPRISES PRIVATE LIMITED. Any unauthorized reproduction, commercial distribution, or imitation is strictly prohibited.',
      },
      {
        type: 'heading',
        text: 'Limitation of Liability & Jurisdiction',
      },
      {
        type: 'paragraph',
        text: 'To the maximum extent permitted by applicable law, HARIVON ENTERPRISES PRIVATE LIMITED shall not be liable for indirect, incidental, or consequential damages arising from the use of our products. Any legal disputes shall be subject to the exclusive jurisdiction of the courts located in Lucknow, Uttar Pradesh, India.',
      },
    ],
    seo: {
      metaTitle: 'Terms of Service | Achichiz',
      metaDescription:
        'Review the legal terms, store guidelines, and conditions governing the use of the Achichiz website and purchases.',
      canonicalUrl: 'https://achichiz.com/policies/terms',
      focusKeyword: 'Achichiz terms of service',
      robotsIndex: true,
      robotsFollow: true,
      ogImageUrl: null,
      structuredData: null,
    },
  },

  cookies: {
    id: 'b1000000-0000-4000-8000-000000000005',
    slug: 'cookies',
    kind: 'policy',
    title: 'Cookie Policy',
    heading: 'Cookie Policy & Tracking Technologies',
    heroImage: null,
    collectionHandle: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    body: [
      {
        type: 'paragraph',
        text: 'This Cookie Policy explains how HARIVON ENTERPRISES PRIVATE LIMITED ("Achichiz") utilizes cookies, local storage, and similar web tracking technologies when you browse our website. We believe in transparency and want you to know how and why these technologies are used.',
      },
      {
        type: 'heading',
        text: 'What Are Cookies?',
      },
      {
        type: 'paragraph',
        text: 'Cookies are small text files stored on your browser or mobile device by websites you visit. They enable the website to recognize your device, remember preferences across browsing sessions, maintain your shopping cart items, and provide a fast, personalized experience.',
      },
      {
        type: 'heading',
        text: 'Types of Cookies We Use',
      },
      {
        type: 'list',
        items: [
          'Strictly Necessary Cookies: Required for core site functionality, including authentication, shopping cart persistence, and secure checkout navigation.',
          'Functionality & Preference Cookies: Remember your site preferences, such as delivery pin codes, dismissed notification banners, and recently viewed products.',
          'Analytics & Performance Cookies: Collect anonymous statistical insights on site speed, traffic flow, and page popularity to help us optimize user experience.',
          'Marketing Cookies: Help us deliver relevant seasonal gift collections and festive announcements on social platforms without spamming.',
        ],
      },
      {
        type: 'heading',
        text: 'Third-Party Services',
      },
      {
        type: 'paragraph',
        text: 'Some third-party tools integrate with our storefront to ensure smooth operations. For example, our payment gateway partner (Razorpay) uses security tokens to prevent fraudulent charges, and web analytics tools monitor site reliability.',
      },
      {
        type: 'heading',
        text: 'Managing Cookie Preferences',
      },
      {
        type: 'paragraph',
        text: 'You have full control over cookies. You can adjust your browser settings to decline or delete cookies at any time. Please note that disabling essential cookies may impact checkout functionality or require re-entering your cart items.',
      },
      {
        type: 'heading',
        text: 'Contact & Updates',
      },
      {
        type: 'paragraph',
        text: 'We may update this policy occasionally to align with technical improvements or legal standards. If you have questions about how cookies are used, please reach out to us at connect@achiachi.in.',
      },
    ],
    seo: {
      metaTitle: 'Cookie Policy | Achichiz',
      metaDescription:
        'Understand how Achichiz uses cookies, tracking tools, and session storage to optimize your sustainable gifting shopping experience.',
      canonicalUrl: 'https://achichiz.com/policies/cookies',
      focusKeyword: 'Achichiz cookie policy',
      robotsIndex: true,
      robotsFollow: true,
      ogImageUrl: null,
      structuredData: null,
    },
  },
};
