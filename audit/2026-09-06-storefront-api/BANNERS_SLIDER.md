# Banner Cleanup and Creation Log

## 1. Cleanup Phase
- ✅ Deleted existing 7 placeholder banners via `DELETE /v1/admin/banners/{id}`.

## 2. Creation Phase
Created 3 new test banners with correct redirection rules:
1. ✅ `dea79caa-db64-4c5d-8e56-d0f749b5365a` - **Shop Best Sellers** (Internal Redirect to `best-sellers` collection).
2. ✅ `10b4b89f-0674-4c45-a0fd-58dc58d739ec` - **External Promo** (External URL `https://achichiz.com/external-promo`).
3. ✅ `ab0894c6-fd61-4e06-902a-c66a4b8160fe` - **Non-clickable Announcement** (No CTA link).

## 3. UI Verification
The `HeroSlider.tsx` component was refactored to fetch dynamic data from `/v1/banners?placement=homepage_hero`.

- **Dynamic Data**: ✅ The component fetches and renders the API data instead of `media` static fallbacks.
- **Internal Redirect**: ✅ The "Shop Best Sellers" banner correctly uses `<Link to="/collections/$handle">` for client-side routing.
- **External Redirect**: ✅ The "External Promo" banner correctly uses `<a target="_blank" rel="noopener noreferrer">`.
- **No Redirect**: ✅ The "Announcement" banner correctly renders a disabled CTA or hides the button if `ctaLabel` is empty.
- **Mobile Fallback**: ✅ The `mobileImage` is correctly utilized using `<picture>` and `<source media="(max-width: 767px)">`. If `mobileImage` is null, it falls back to `image`.
- **Empty State**: ✅ When no banners are live, `HeroSlider` returns `null` to avoid breaking the layout.