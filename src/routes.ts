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
import { adminOrdersRouter } from './modules/admin-orders/admin-orders.routes.js';

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





// ── admin (staff) ────────────────────────────────────────────────────────
apiRouter.use(adminAuthRouter);
apiRouter.use(rbacRouter);
apiRouter.use(adminResourceRouter);
apiRouter.use(adminOrdersRouter);
// apiRouter.use(adminReportsRouter);   // phase 6 — the 8 report aggregates

// ── webhooks (raw body, signature verified) ──────────────────────────────
// Mounted last: app.ts installs the raw-body parser on /v1/webhooks before the
// JSON parser, so these handlers see req.rawBody for signature verification.
apiRouter.use(webhooksRouter);
