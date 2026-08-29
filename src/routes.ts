import { Router } from 'express';
import { healthRouter } from './modules/health/health.routes.js';
import { catalogueRouter } from './modules/catalogue/catalogue.routes.js';
import { searchRouter } from './modules/search/search.routes.js';
import { contentRouter } from './modules/content/content.routes.js';
import { cartRouter } from './modules/cart/cart.routes.js';
import { checkoutRouter } from './modules/checkout/checkout.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { webhooksRouter } from './modules/webhooks/webhooks.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { accountRouter } from './modules/account/account.routes.js';
import { addressesRouter } from './modules/addresses/addresses.routes.js';
import { leadsRouter } from './modules/leads/leads.routes.js';
import { adminAuthRouter } from './modules/admin-auth/admin-auth.routes.js';
import { rbacRouter } from './modules/rbac/rbac.routes.js';
import { adminResourceRouter } from './modules/admin-resources/admin-resources.routes.js';
import { adminInventoryRouter } from './modules/admin-inventory/admin-inventory.routes.js';
import { adminWarehousingRouter } from './modules/admin-warehousing/admin-warehousing.routes.js';
import { adminPurchasingRouter } from './modules/admin-purchasing/admin-purchasing.routes.js';
import { adminBundlesRouter } from './modules/admin-bundles/admin-bundles.routes.js';
import { adminProductionRouter } from './modules/admin-production/admin-production.routes.js';
import { adminStockCountsRouter } from './modules/admin-stock-counts/admin-stock-counts.routes.js';
import { adminBarcodesRouter } from './modules/admin-barcodes/admin-barcodes.routes.js';
import { adminBulkOrdersRouter } from './modules/admin-bulk-orders/admin-bulk-orders.routes.js';
import { adminOrdersRouter } from './modules/admin-orders/admin-orders.routes.js';
import { mediaRouter } from './modules/media/media.routes.js';

/**
 * The single mount point.
 *
 * Every module exports one Router built entirely from `defineRoute` calls. Adding
 * a module means one import and one `use()` here — and because `defineRoute` is
 * the only way to mount a handler, the OpenAPI document gains the endpoints at
 * the same instant the server does.
 *
 * Feature modules are added below as they land. Keep them alphabetical within a
 * surface so merge conflicts are trivial to resolve.
 *
 * This router is mounted at ROOT. Every route declares its own full path
 * including the `/v1` prefix — see the note in app.ts.
 */
export const apiRouter: Router = Router();

// ── system ───────────────────────────────────────────────────────────────
apiRouter.use(healthRouter);

// ── storefront (public + customer) ───────────────────────────────────────
apiRouter.use(catalogueRouter);
apiRouter.use(contentRouter);
apiRouter.use(searchRouter);
apiRouter.use(cartRouter);
apiRouter.use(checkoutRouter);
apiRouter.use(ordersRouter);
apiRouter.use(paymentsRouter);
apiRouter.use(authRouter);
apiRouter.use(accountRouter);
apiRouter.use(addressesRouter);
apiRouter.use(leadsRouter);





import { adminReportsRouter } from './modules/admin-reports/admin-reports.routes.js';

// ── admin (staff) ────────────────────────────────────────────────────────
apiRouter.use(adminAuthRouter);
apiRouter.use(rbacRouter);
apiRouter.use(adminResourceRouter);
apiRouter.use(adminOrdersRouter);
apiRouter.use(adminInventoryRouter);
apiRouter.use(adminWarehousingRouter);
apiRouter.use(adminPurchasingRouter);
apiRouter.use(adminBundlesRouter);
apiRouter.use(adminProductionRouter);
apiRouter.use(adminStockCountsRouter);
apiRouter.use(adminBarcodesRouter);
apiRouter.use(adminBulkOrdersRouter);
apiRouter.use(adminReportsRouter);   // phase 7 — the 10 report aggregates
apiRouter.use(mediaRouter);

// ── webhooks (raw body, signature verified) ──────────────────────────────
// Mounted last: app.ts installs the raw-body parser on /v1/webhooks before the
// JSON parser, so these handlers see req.rawBody for signature verification.
apiRouter.use(webhooksRouter);
