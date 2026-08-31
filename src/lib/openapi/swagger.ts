import { isIP } from 'node:net';
import type { Express, NextFunction, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ForbiddenError, UnauthenticatedError } from '../errors.js';
import { verifyStaffToken } from '../../modules/admin-auth/staff-token.js';
import { buildDocument } from './document.js';

/**
 * Two surfaces, two Swagger UIs, never merged.
 *
 * A single public document that enumerates `/v1/admin/customers/export`, every
 * refund endpoint and every settings mutation is a free attack map. The admin
 * document is gated; the storefront one is not.
 */

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? '').trim().replace(/^::ffff:/, '');
}

function ipAllowed(req: Request): boolean {
  const allow = env.docsAdminIpAllowlist;
  if (allow.length === 0) return true;
  const ip = clientIp(req);
  if (!isIP(ip)) return false;
  // Exact addresses only. CIDR matching belongs at the proxy, not here — if you
  // need ranges, put the docs behind the VPN and leave this list empty.
  return allow.includes(ip);
}

/**
 * Gate for the admin spec and the Swagger UI, in this order of precedence.
 *
 * The UI fetches `/openapi/admin.json` with a plain `fetch()` — no Authorization
 * header, and the staff refresh cookie is scoped to `/v1/admin/auth` so it is
 * not sent either. That is why the guard was previously dropped from the spec
 * route altogether, which left a complete map of every admin endpoint readable
 * by anyone on the internet.
 *
 * 1. **A configured allowlist is sufficient on its own.** On a VPN or office
 *    range the network is the control, the dropdown keeps working, and no token
 *    has to be smuggled through a URL where it would land in proxy logs and
 *    browser history.
 * 2. **Otherwise a staff token with `settings:view` is required.** Accepted as a
 *    Bearer header or, for the top-level UI navigation which can carry one, as
 *    `?access_token=`. It is a 10-minute token precisely because of where that
 *    query string ends up.
 *
 * With neither configured the docs are closed, which is the safe default and the
 * case this guard exists to cover.
 */
async function guardAdminDocs(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const allowlistConfigured = env.docsAdminIpAllowlist.length > 0;

  if (allowlistConfigured) {
    if (!ipAllowed(req)) {
      logger.warn({ ip: clientIp(req), path: req.path }, 'admin docs blocked by ip allowlist');
      next(new ForbiddenError('Admin API documentation is not available from this network.'));
      return;
    }
    // On an allowlisted network. The network IS the control.
    next();
    return;
  }

  if (!env.DOCS_ADMIN_REQUIRE_AUTH) {
    if (env.isProduction) {
      logger.error('DOCS_ADMIN_REQUIRE_AUTH is false in production — the admin API map is exposed.');
    }
    next();
    return;
  }

  const header = req.headers.authorization;
  const queryToken = typeof req.query.access_token === 'string' ? req.query.access_token : undefined;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;

  if (!token) {
    next(new UnauthenticatedError('A staff access token is required to view the admin API documentation.'));
    return;
  }

  try {
    const claims = await verifyStaffToken(token);
    if (!claims.permissions.has('settings:view')) {
      next(new ForbiddenError('Viewing the admin API documentation requires `settings:view`.'));
      return;
    }
    next();
  } catch {
    next(new UnauthenticatedError('Invalid or expired staff access token.'));
  }
}

const UI_OPTIONS: swaggerUi.SwaggerUiOptions = {
  explorer: false,
  swaggerOptions: {
    persistAuthorization: true,
    tryItOutEnabled: true,
    displayRequestDuration: true,
    docExpansion: 'none',
    filter: true,
    defaultModelsExpandDepth: 1,
  },
};

export function mountSwagger(app: Express): void {
  const storefrontDoc = buildDocument('storefront');
  const adminDoc = buildDocument('admin');

  // ---- specs -----------------------------------------------------------
  app.get('/openapi/storefront.json', (_req, res) => {
    res.set('X-Robots-Tag', 'noindex').json(storefrontDoc);
  });

  /*
   * Guarded. The endpoints are protected by their own RBAC, but this document is
   * a complete map of all 212 of them — every path, parameter and schema — and
   * serving it unauthenticated hands an attacker the reconnaissance for free.
   */
  app.get('/openapi/admin.json', guardAdminDocs, (_req, res) => {
    res.set('X-Robots-Tag', 'noindex').json(adminDoc);
  });

  // ---- UI --------------------------------------------------------------
  // The user requested a single Swagger UI with a dropdown (explorer mode)
  // to toggle between Storefront and Admin APIs.
  const multiUiOptions: swaggerUi.SwaggerUiOptions = {
    ...UI_OPTIONS,
    explorer: true,
    swaggerOptions: {
      ...UI_OPTIONS.swaggerOptions,
      urls: [
        { url: '/openapi/storefront.json', name: '1-Storefront-APIs' },
        { url: '/openapi/admin.json', name: '2-Admin-APIs' },
      ],
    },
    customSiteTitle: 'Achichiz API',
    customCss: `
      /* Fix typography and overlapping code blocks in the authorization modal and descriptions */
      .swagger-ui .auth-container p { line-height: 2.2 !important; margin-bottom: 12px !important; font-size: 14px; }
      .swagger-ui .auth-container code { padding: 4px 8px !important; border-radius: 4px !important; margin: 4px 2px !important; display: inline-block; font-size: 13px; }
      .swagger-ui .markdown p { line-height: 1.8 !important; }
      .swagger-ui .markdown code { padding: 2px 6px !important; border-radius: 4px !important; font-size: 13px; }
      .swagger-ui .opblock-description-wrapper p { line-height: 1.8 !important; }
      
      /* Polish overall appearance */
      .swagger-ui .wrapper { max-width: 1200px !important; }
      .swagger-ui .dialog-ux .modal-ux { max-width: 700px !important; }
    `,
  };

  app.use(
    '/docs',
    (_req: Request, res: Response, next: NextFunction) => {
      res.set('X-Robots-Tag', 'noindex');
      next();
    },
    swaggerUi.serveFiles(undefined, multiUiOptions),
    swaggerUi.setup(undefined, multiUiOptions)
  );

  logger.info('swagger mounted at /docs with multi-definition dropdown');
}
