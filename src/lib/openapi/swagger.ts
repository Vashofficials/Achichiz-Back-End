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
 * Gate for the admin spec and UI.
 *
 * A browser loading `/docs/admin` cannot send an Authorization header, so a
 * staff token is also accepted as `?access_token=` for that navigation. That is
 * a deliberate, documented trade-off: the token lands in the URL (and therefore
 * in proxy logs and browser history), which is why it is a 10-minute staff token
 * and why the IP allowlist exists. In production, prefer putting `/docs/admin`
 * behind your VPN or reverse-proxy auth and leaving DOCS_ADMIN_REQUIRE_AUTH on
 * as defence in depth.
 */
async function guardAdminDocs(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!ipAllowed(req)) {
    logger.warn({ ip: clientIp(req), path: req.path }, 'admin docs blocked by ip allowlist');
    next(new ForbiddenError('Admin API documentation is not available from this network.'));
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
  explorer: true,
  swaggerOptions: {
    urls: [
      { url: '/openapi/storefront.json', name: '1-Storefront-API' },
      { url: '/openapi/admin.json', name: '2-Admin-API' }
    ],
    persistAuthorization: true,
    tryItOutEnabled: true,
    displayRequestDuration: true,
    docExpansion: 'none',
    filter: true,
    defaultModelsExpandDepth: 1,
    requestInterceptor: (req: any) => {
      // If an access_token is in the URL, append it to the spec fetch so it can pass guardAdminDocs
      if (typeof (globalThis as any).window !== 'undefined' && req.url.includes('/openapi/admin.json')) {
        const urlParams = new (globalThis as any).URLSearchParams((globalThis as any).window.location.search);
        const token = urlParams.get('access_token');
        if (token) {
          req.url += (req.url.includes('?') ? '&' : '?') + 'access_token=' + token;
        }
      }
      return req;
    },
  },
};

export function mountSwagger(app: Express): void {
  const storefrontDoc = buildDocument('storefront');
  const adminDoc = buildDocument('admin');

  // ---- specs -----------------------------------------------------------
  app.get('/openapi/storefront.json', (_req, res) => {
    res.set('X-Robots-Tag', 'noindex').json(storefrontDoc);
  });

  app.get('/openapi/admin.json', guardAdminDocs, (_req, res) => {
    res.set('X-Robots-Tag', 'noindex').json(adminDoc);
  });

  // ---- UIs -------------------------------------------------------------
  // We use the `urls` option in Swagger UI to provide a topbar dropdown.
  // The specs are fetched via XHR from the /openapi/*.json endpoints above.
  app.use(
    '/docs',
    (_req: Request, res: Response, next: NextFunction) => {
      res.set('X-Robots-Tag', 'noindex');
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      ...UI_OPTIONS,
      customSiteTitle: 'Achichiz API',
    }),
  );

  logger.info('swagger mounted at /docs with topbar dropdown');
}
