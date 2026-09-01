# Achichiz Back-End Rules

Always follow the `achichiz-backend` skill guidelines when working in this codebase:
- Mount all endpoints using `defineRoute` in `src/lib/openapi/define-route.js`.
- Adhere to the 4-layer pattern: `*.routes.ts`, `*.service.ts`, `*.repository.ts`, `*.schemas.ts`.
- Standard response envelopes: `{ type: 'success', result: T }` and `{ type: 'success', result: T[], meta: PageMeta }`. The `data` key is prohibited.
- All monetary values are integer paise (`Paise = number`, `149900 = ₹1,499.00`). Percentages are integer basis points (`percent_bp`).
- Database schemas are imported ONLY from `src/db/schema/index.js`.
- Status fields use `text()` with `check()` constraint and `as const` union type (zero `pgEnum`).
- `NodeNext` ESM imports must use `.js` extension.
