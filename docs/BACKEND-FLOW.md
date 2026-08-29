# Achichiz Backend — complete flow diagrams

> **Scope:** this document describes the backend that is currently present in this repository. It is an implementation map, not a proposed redesign. Boxes marked **Review finding** describe behaviour identified during static review and should be treated as part of the current system until remediated.
>
> **Database note:** the database diagrams describe SQL statically. There is no live PostgreSQL integration harness in this checkout, so trigger and migration observations require confirmation against PostgreSQL 16 before deployment.

## 1. System context

```mermaid
flowchart LR
    Store[Storefront browser]
    Admin[Admin console]
    Razorpay[Razorpay API and webhooks]
    Firebase[Firebase Auth]
    SES[SES or development email sender]
    S3[S3 or S3-compatible media storage]

    subgraph Backend[Achichiz backend process]
        HTTP[Express HTTP server]
        Routes[Route declarations\n`defineRoute()`]
        Services[Domain services]
        Repositories[Drizzle repositories]
        Middleware[Auth, validation, rate limit,\nidempotency, audit, upload]
    end

    subgraph Data[Stateful infrastructure]
        PG[(PostgreSQL 16+)]
        Redis[(Redis)]
    end

    Store -->|HTTPS /v1| HTTP
    Admin -->|HTTPS /v1/admin| HTTP
    Razorpay -->|signed HTTPS webhook| HTTP
    HTTP --> Middleware
    Middleware --> Routes
    Routes --> Services
    Services --> Repositories
    Repositories --> PG
    Services --> Redis
    Services --> Razorpay
    Services --> Firebase
    Services --> SES
    Services --> S3

    classDef current fill:#e8f5e9,stroke:#2e7d32,color:#111
    classDef external fill:#e3f2fd,stroke:#1565c0,color:#111
    classDef data fill:#fff3e0,stroke:#ef6c00,color:#111
    classDef finding fill:#ffebee,stroke:#c62828,color:#111
    class Store,Admin,HTTP,Routes,Services,Repositories,Middleware current
    class Razorpay,Firebase,SES,S3 external
    class PG,Redis data
```

### Main responsibilities

| Layer | Current responsibility |
|---|---|
| `src/server.ts` | Creates the Express app, binds the HTTP port, and performs graceful shutdown. |
| `src/app.ts` | Installs request context, logging, Helmet, CORS, raw webhook parsing, JSON/form parsing, HPP, the blanket limiter, Swagger, routes, 404, and error handling. |
| `src/routes.ts` | Imports and mounts health, storefront, admin, media, and webhook routers. |
| `defineRoute()` | Registers an Express route and its OpenAPI operation from one declaration, then builds its middleware chain. |
| Middleware | Authenticates tokens, checks permissions, validates Zod input, claims idempotency keys, uploads multipart files, and records admin mutations. |
| Services | Own business rules, pricing, authorization decisions, state transitions, and transaction orchestration. |
| Repositories | Own Drizzle/PostgreSQL queries and transaction-scoped reads/writes. |
| PostgreSQL | Durable source of truth for customers, staff, catalogue, carts, orders, payments, inventory, media metadata, and audit records. |
| Redis | JWT/session denylist, refresh replay memory, rate-limit store, idempotency store, and step-up state. |
| External integrations | Razorpay payments, Firebase identity, S3 media, and email. SES production delivery is currently a stub. |

## 2. Process boot and shutdown

```mermaid
flowchart TD
    Start[node src/server.ts] --> Env[Import config/env.ts]
    Env --> Parse{Environment schema valid?}
    Parse -- no --> ExitConfig[Log all invalid variables\nprocess exits before port bind]
    Parse -- yes --> Razor[Check Razorpay variable completeness]
    Razor --> Mode[Log live/test key mode warnings]
    Mode --> App[createApp()]
    App --> Context[Request context middleware]
    Context --> Logger[pino-http]
    Logger --> Security[Helmet + CORS + HPP]
    Security --> WebhookParser[Raw body parser for /v1/webhooks]
    WebhookParser --> BodyParser[JSON + URL-encoded parsers]
    BodyParser --> DefaultLimit[Blanket /v1 rate limiter]
    DefaultLimit --> Swagger[Mount Swagger/OpenAPI]
    Swagger --> Router[Mount apiRouter at root]
    Router --> Listen[HTTP server listens on PORT]

    Listen --> Signal{SIGTERM / SIGINT?}
    Signal --> StopAccept[Stop accepting new connections]
    StopAccept --> Drain[Drain in-flight requests]
    Drain --> ClosePG[Close PostgreSQL pools]
    ClosePG --> CloseRedis[Quit Redis clients]
    CloseRedis --> Exit[Exit]

    ConfigRisk[Review finding:\nRazorpay test key in production only logs; it does not stop boot/payment use]
    ConfigRisk -.-> Mode
    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class ConfigRisk risk
```

### Database migration process

Migrations are intentionally **not** run at application boot.

```mermaid
flowchart LR
    Deploy[Deployment job or\nscripts/deploy-docker.sh] --> Migrate[npm run db:migrate\n(or dist/db/migrate.js)]
    Migrate --> Client[Standalone pg.Client]
    Client --> SchemaTable[CREATE schema_migrations IF NOT EXISTS]
    SchemaTable --> Lock[Acquire PostgreSQL advisory lock]
    Lock --> Files[Read src/dist db/migrations\nin filename order]
    Files --> Checksum[SHA-256 each SQL file]
    Checksum --> Applied{Already recorded?}
    Applied -- yes + same checksum --> Next[Next file]
    Applied -- yes + changed --> Abort[Abort: forward-only migration changed]
    Applied -- no --> Tx[BEGIN]
    Tx --> SQL[Strip outer BEGIN/COMMIT\nthen execute migration SQL]
    SQL --> Record[INSERT filename + checksum]
    Record --> Commit[COMMIT]
    Commit --> Next
    Next --> Unlock[Release advisory lock]
    Unlock --> Close[Close client]
```

**Deployment caveat:** the production Docker Compose file starts an `api` and a `worker` service, but this checkout has no `src/worker.ts`; `npm run start:worker` fails because `dist/worker.js` is absent. The worker container therefore cannot process the intended asynchronous work.

## 3. HTTP request pipeline

Every route declared with `defineRoute()` is assembled into the following pipeline. Middleware that is not applicable to a route is omitted.

```mermaid
flowchart TD
    Request[Incoming HTTP request] --> RequestId[request-context\nvalidate inbound X-Request-Id or generate ULID]
    RequestId --> AccessLog[pino-http request logging\nredacts auth/cookie/token fields]
    AccessLog --> Headers[Helmet + CORS]
    Headers --> Raw{Path starts /v1/webhooks?}
    Raw -- yes --> RawBody[Read raw JSON bytes\nattach req.rawBody\nparse JSON body]
    Raw -- no --> Parsed
    RawBody --> Parsed[express.json / urlencoded + HPP]
    Parsed --> GlobalLimit[/v1 default limiter]
    GlobalLimit --> RouteMatch{Route exists?}
    RouteMatch -- no --> NotFound[404 handler]
    RouteMatch -- yes --> NamedLimit{Named route limiter?}
    NamedLimit --> Auth{Route auth mode?}
    Auth -- public --> Permission
    Auth -- customer --> CustomerJWT[Verify customer JWT\ncheck Redis session denylist\nset req.auth + actor context]
    Auth -- staff --> StaffJWT[Verify staff JWT\ncheck Redis session denylist\nset req.auth + actor context]
    CustomerJWT --> Permission
    StaffJWT --> Permission
    Permission{Permission declared?} -- no --> Idempotency
    Permission -- yes --> RBAC[Check staff permission claim]
    RBAC --> Idempotency{Idempotent route?}
    Idempotency -- no --> Multipart
    Idempotency -- yes --> Claim[Redis GET/NX claim\nreplay or reserve key]
    Claim --> Multipart{multipart/form-data?}
    Multipart -- no --> Validate
    Multipart -- yes --> Multer[Global fileInterceptor\nparse files + upload to S3\nwrite media rows\nmap field to media id]
    Multer --> Validate[Zod params/query/body validation]
    Validate --> Audit{Admin non-GET\nand audit not skipped?}
    Audit -- yes --> AuditWrite[Best-effort activity log]
    Audit -- no --> Handler
    AuditWrite --> Handler[Route handler]
    Handler --> Service[Domain service]
    Service --> Repository[Repository / external provider]
    Repository --> Result[HTTP result helper]
    Result --> PersistIdem[Asynchronously store successful idempotent response]
    Result --> Response[JSON / 204 / raw response]

    Error[Thrown error] --> ErrorHandler[Single error handler]
    ErrorHandler --> Problem[JSON error envelope\nAppError / PG mapping / 500]

    Risk1[Review finding:\nbyUser limiter runs before auth, so req.auth is empty] -.-> NamedLimit
    Risk2[Review finding:\nRedis rate-limit failure is fail-open] -.-> NamedLimit
    Risk3[Review finding:\nX-Forwarded-For is used directly for limiter keys] -.-> NamedLimit
    Risk4[Review finding:\nmultipart upload can happen before validation] -.-> Multer

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Risk1,Risk2,Risk3,Risk4 risk
```

### Route declaration and OpenAPI flow

```mermaid
flowchart LR
    Declaration[RouteSpec in module.routes.ts] --> Register[registry.add(spec)]
    Declaration --> Chain[Build Express middleware chain]
    Chain --> Express[Express router method/path]
    Register --> Document[buildDocument(surface)]
    Document --> Committed[openapi/openapi.admin.json\nopenapi/openapi.storefront.json]
    Document --> UI[Swagger UI]
    Runtime[Live Express router stack] --> Coverage[OpenAPI coverage test]
    Register --> Coverage

    PublicUI[/docs and /docs/] --> StorefrontUI[Public Storefront Swagger UI]
    AdminUI[/docs/admin/] --> Guard[guardAdminDocs]
    Guard --> AdminDocument[Embedded Admin Swagger UI]
    AdminJSON[/openapi/admin.json] --> Guard
    StorefrontJSON[/openapi/storefront.json] --> StorefrontUI
    README[README documents\n/docs/admin + /docs/storefront] -.-> PublicUI

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Guard risk
```

**Current API documentation state:** `/docs/` and `/openapi/storefront.json` are public. `/docs/admin/` and `/openapi/admin.json` use the existing IP/staff guard; the Admin document is embedded only after the guard succeeds, so the public Storefront UI does not need to fetch it. `/docs/admin` accepts the documented short-lived `access_token` query parameter for browser navigation, while API clients may use `Authorization`. The README’s `/docs/storefront` path is an alias of the public Storefront UI, not a business API.

## 4. Route surface map

```mermaid
flowchart TB
    API[/apiRouter]
    API --> System[System\nhealth / readiness]
    API --> Store[Storefront]
    API --> Admin[Admin]
    API --> Webhooks[Webhooks]

    Store --> Catalogue[Catalogue\nproducts, collections, content]
    Store --> Search[Search\nFTS, suggestions, tracking]
    Store --> Cart[Cart\nlines, coupons, merge]
    Store --> Checkout[Checkout\nquote, create order]
    Store --> Orders[Customer orders\nlist, detail, cancel, track]
    Store --> Payments[Customer payments\nRazorpay order, verify]
    Store --> CustomerAuth[Customer auth\nsignup, login, Firebase, refresh, logout]
    Store --> Account[Account + addresses]
    Store --> Leads[Lead capture\ncontact, corporate, newsletter]
    Store --> CustomerMedia[Customer media upload]

    Admin --> AdminAuth[Staff auth\nlogin, MFA, reset, sessions, step-up]
    Admin --> RBAC[Roles + permissions]
    Admin --> Resources[Generic admin resources]
    Admin --> Inventory[Inventory + stock movements]
    Admin --> Warehousing[Warehouses, locations, transfers]
    Admin --> Purchasing[Suppliers, purchase orders, goods receipt]
    Admin --> Bundles[Bundles / availability]
    Admin --> Production[Production / BOM]
    Admin --> Counts[Stock counts]
    Admin --> Barcodes[Barcode operations]
    Admin --> Bulk[Bulk orders]
    Admin --> Reports[Reports + CSV export]
    Admin --> AdminOrders[Order operations, refunds, invoices]
    Admin --> AdminMedia[Admin media upload]

    Webhooks --> Razor[POST /v1/webhooks/razorpay]
```

## 5. Storefront browse and search flow

```mermaid
flowchart LR
    Shopper[Browser] --> CatalogRoute[Catalogue/content route]
    CatalogRoute --> CatalogService[Catalogue service]
    CatalogService --> CatalogRepo[Catalogue repository]
    CatalogRepo --> PG[(PostgreSQL)]
    PG --> CatalogRepo
    CatalogRepo --> CatalogService
    CatalogService --> Shopper

    Shopper --> SearchRoute[GET /v1/search\n/suggest\n/suggestions]
    SearchRoute --> SearchService[Search service]
    SearchService --> SearchRepo[Search repository]
    SearchRepo --> FTS[PostgreSQL FTS + trigram]
    FTS --> SearchRepo
    SearchRepo --> SearchService
    SearchService --> Shopper

    Vocabulary[search_vocabulary\nmaterialized read model] -. no discovered refresh job .-> FTS
    WideIndex[Indexed product_search_document() helper] -. repository re-spells expression .-> FTS

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Vocabulary,WideIndex risk
```

**Search review findings:**

- The three public search endpoints deliberately have no named `search` limiter because the current limiter implementation constructs Redis-backed stores too early for the OpenAPI generator. They receive only the blanket limit.
- `search_vocabulary` has no discovered refresh command/job, so suggestions can become stale.
- The repository does not call the migration's `product_search_document()` helper. Its query expression is not structurally identical to the wide FTS index expression, reducing the reliability of that index.
- Search suggestions run several database operations in parallel and have no dedicated tighter limiter, making them a scraping/database-load target.

## 6. Cart lifecycle and merge flow

```mermaid
flowchart TD
    Browser[Browser] --> Token[Cart identity\nX-Cart-Token preferred\nbody/query fallback]
    Token --> Resolve{Token present?}
    Resolve -- no --> NewCart[Create anonymous cart\nnewCartToken()]
    Resolve -- yes --> FindCart[Find cart by anon_token]
    FindCart --> Owner{Cart owned by another customer?}
    Owner -- yes --> Hide[404 to avoid ownership disclosure]
    Owner -- no --> Open{Cart converted?}
    NewCart --> LineAction
    Open -- yes --> Converted[422 cart_already_converted]
    Open -- no --> LineAction[Add / update / delete / clear / coupon]

    LineAction --> LiveRows[Read live product, variant, add-on,\nGST, collection, inventory rows]
    LiveRows --> Price[Pure pricing engine\nrecompute totals and tax]
    Price --> CartResponse[Return cart + warnings]

    Login[Successful customer login/Firebase exchange] --> Merge[mergeCart(customerId, guestToken)]
    Merge --> Existing[Find customer's open cart]
    Merge --> Guest[Find guest cart]
    Existing --> Choice{Customer cart exists?}
    Guest --> Choice
    Choice -- no --> Adopt[Adopt guest cart or create customer cart]
    Choice -- yes --> Lines[For each guest line]
    Lines --> Clash{Same line_key?}
    Clash -- yes --> Sum[Add quantities, delete guest line]
    Clash -- no --> Move[Move guest line]
    Sum --> CouponMerge[Optional coupon merge]
    Move --> CouponMerge
    Adopt --> Loaded
    CouponMerge --> DeleteGuest[Delete guest cart]
    DeleteGuest --> Loaded[Reload + reprice]
    Loaded --> Browser

    Race1[Review finding:\ncart line reads/writes are not atomic; concurrent adds can lose quantity] -.-> LineAction
    Race2[Review finding:\nmerge has no transaction/customer/cart locks] -.-> Merge
    Race3[Review finding:\nno unique active customer-cart constraint] -.-> Existing

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Race1,Race2,Race3 risk
```

### Important cart semantics

- A cart stores a live product/variant reference and a price snapshot for display only. Totals are recomputed from current catalogue rows.
- Builder hamper lines are accepted by the request schema but rejected by the service as `builder_lines_unsupported`; their bill-of-materials reservation flow is not implemented.
- `availableQtyFor()` used by cart reads does not filter inactive/deleted warehouses, while checkout inventory selection does. Cart availability can therefore overstate sellable stock before checkout rejects it.
- `X-Cart-Token` is included in both the CORS `allowedHeaders` and `exposedHeaders` lists, so an approved cross-origin storefront can use the documented preferred header.

## 7. Quote, order creation, and cart conversion

```mermaid
flowchart TD
    Customer[Authenticated customer] --> Quote[POST /v1/checkout/quote]
    Quote --> ResolveQuote[Resolve owned cart + address]
    ResolveQuote --> PriceQuote[Load live rows\nprice cart + tax + delivery]
    PriceQuote --> QuoteResponse[Quote only\nno stock hold / no coupon claim]

    Customer --> Create[POST /v1/orders\nIdempotency-Key required]
    Create --> Idem[Redis idempotency reservation]
    Idem --> Context[Resolve cart, address, zone, supply point\nload live pricing state]
    Context --> Assert[Assert sellability, delivery, COD,\nstock and pricing invariants]
    Assert --> Tx[BEGIN PostgreSQL transaction]
    Tx --> Coupon{Coupon?}
    Coupon -- yes --> CouponLock[Claim coupon with conditional UPDATE\nlock coupon row]
    Coupon -- no --> Inventory
    CouponLock --> CustomerCoupon[Check per-customer redemption limit]
    CustomerCoupon --> Inventory[Lock selected inventory levels\nin ascending id order]
    Inventory --> Reserve[Conditional reserve\non_hand - reserved >= quantity]
    Reserve --> Number[Take order number]
    Number --> Header[Insert order header]
    Header --> Lines[Insert order lines + add-ons + personalisation]
    Lines --> Reservations[Insert order reservations]
    Reservations --> Redemption[Insert coupon redemption]
    Redemption --> Timeline[Insert order timeline events]
    Timeline --> AddressSave[Optional save shipping address]
    AddressSave --> Convert[UPDATE carts\nSET stage=converted, converted_order_id=order]
    Convert --> Commit[COMMIT + deferred checks]
    Commit --> Gateway{Prepaid?}
    Gateway -- no --> CODResponse[Return confirmed / cod_due]
    Gateway -- yes --> CreateRP[Create/reuse Razorpay session AFTER commit]
    CreateRP --> PaymentResponse[Return pending_payment + payment session\nor null if gateway failed]

    Risk[Review finding:\nmarkCartConverted() updates by cart id unconditionally; concurrent submissions with different idempotency keys can create multiple orders and overwrite converted_order_id] -.-> Convert
    Risk2[Review finding:\nby-user idempotency scope is unavailable to staff and async response persistence can lose the reservation] -.-> Idem

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Risk,Risk2 risk
```

### Checkout invariant set

The service and deferred SQL trigger intend to enforce:

1. `orders.subtotal_paise = SUM(order_lines.gross_paise)`.
2. Header discount totals equal allocated line discounts.
3. `orders.total_paise = subtotal + shipping + COD fee + round-off`.
4. Header tax totals equal line tax totals.

The implementation correctly places gateway I/O after the order transaction so a slow Razorpay request does not hold inventory and numbering locks. The cart-conversion write is the missing serialization boundary: it must atomically claim the cart before creating order effects, not merely mark it converted at the end.

## 8. Payment and refund flow

### 8.1 Customer payment flow

```mermaid
sequenceDiagram
    participant C as Customer browser
    participant API as Express API
    participant DB as PostgreSQL
    participant RP as Razorpay

    C->>API: POST /v1/payments/razorpay/order
    API->>DB: Find order and outstanding balance
    API->>DB: Find open created payment session
    alt Existing session at same amount
        DB-->>API: Existing Razorpay order id
    else No reusable session
        API->>RP: Create gateway order
        RP-->>API: gateway order id
        API->>DB: Insert payment(status=created)
    end
    API-->>C: keyId, gateway order id, amount

    C->>RP: Checkout.js payment
    RP-->>C: order id, payment id, signature
    C->>API: POST /v1/payments/razorpay/verify
    API->>API: Verify checkout HMAC signature
    API->>DB: Confirm gateway order belongs to customer order
    API->>RP: Fetch payment by payment id
    RP-->>API: Payment status and captured amount
    API->>DB: applyPaymentCaptured()
    DB-->>API: Lock order, re-check payment, update ledger
    API-->>C: Current order payment state

    RP->>API: POST /v1/webhooks/razorpay
    API->>API: Verify HMAC over raw bytes
    API->>DB: Claim event by gateway event id
    API->>DB: Apply capture/failure/refund
    API-->>RP: 200 or retryable 5xx
```

### 8.2 Capture decision flow

```mermaid
flowchart TD
    Event[Payment capture event or verified hand-back] --> Known[Find payment by gateway_payment_id]
    Known --> Captured{Already captured?}
    Captured -- yes --> NoOp[Return changed=false]
    Captured -- no --> Session[Find payment session by gateway_order_id]
    Session --> Found{Known order/session?}
    Found -- no --> DeferredUnknown[Leave event for reconciliation]
    Found -- yes --> Amount[Check positive safe integer + compare session amount]
    Amount --> Tx[BEGIN transaction]
    Tx --> LockOrder[Lock order row]
    LockOrder --> Recheck[Re-read payment by gateway payment id]
    Recheck --> Replayed{Now captured?}
    Replayed -- yes --> NoOp
    Replayed -- no --> Apply[Update/insert payment captured\nadd amountPaid\nset order payment state\nappend timeline]
    Apply --> Commit[COMMIT]

    Overpay[Review finding:\namount mismatch is logged but still applied; no cap at order due/total] -.-> Amount
    Cancel[Review finding:\nterminal/cancelled order states are not rejected before capture] -.-> LockOrder
    Race[Review finding:\nsession is read before order lock and not re-read inside transaction; distinct captures can overwrite one payment row and credit multiple times] -.-> Recheck

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Overpay,Cancel,Race risk
```

### 8.3 Cancellation and refunds

```mermaid
flowchart TD
    CustomerCancel[Customer cancel request] --> Lock[Lock customer order]
    Lock --> Cancellable{Pre-shipped state?}
    Cancellable -- no --> Refuse[422 not cancellable]
    Cancellable -- yes --> Release[Release order reservations\nreverse coupon redemption]
    Release --> Paid{Amount paid?}
    Paid -- no --> Cancelled[Set status=cancelled\nappend timeline]
    Paid -- yes --> RefundState[Set status=refund_initiated\nappend timeline]
    RefundState --> Commit[COMMIT]
    Cancelled --> Response[Return order]
    Commit --> Refund[Start payments.refundOrder() after commit]

    AdminRefund[Admin refund endpoint] --> RefundService[Lock order + read captured payments\ncalculate committed refund cap]
    RefundService --> Mode{Captured Razorpay payment?}
    Mode -- yes --> RazorpayRefund[Call Razorpay refund]
    Mode -- no --> BankTransfer[Create bank-transfer refund record]
    RazorpayRefund --> RefundRow[Persist refund state / idempotency]
    BankTransfer --> RefundRow
    RefundRow --> Response

    Race[Review finding:\ncaptured payment lookup occurs before order lock, so a concurrent capture can be misclassified as bank transfer] -.-> Mode
    State[Review finding:\nrefund state is read before locking; concurrent changes can alter classification] -.-> RefundService
    Capture[Review finding:\ncapture path can accept cancelled/refund states and does not initiate compensating refund] -.-> RefundState

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Race,State,Capture risk
```

## 9. Razorpay webhook flow

```mermaid
flowchart TD
    RP[Razorpay] --> Raw[POST /v1/webhooks/razorpay]
    Raw --> Signature[Verify X-Razorpay-Signature\nagainst req.rawBody]
    Signature -- invalid --> Bad[400\nno event row written]
    Signature -- valid --> EventId[Use X-Razorpay-Event-Id\nor SHA-256 raw body fallback]
    EventId --> Claim[INSERT payment_events\nunique gateway + event id]
    Claim --> Duplicate{Already claimed?}
    Duplicate -- yes --> DupAck[200 duplicate=true]
    Duplicate -- no --> Dispatch{Event type}
    Dispatch -- payment.captured --> Capture[payments.applyPaymentCaptured]
    Dispatch -- payment.failed --> Failed[payments.applyPaymentFailed]
    Dispatch -- refund.processed --> Processed[payments.applyRefundProcessed]
    Dispatch -- refund.failed --> RefundFailed[payments.applyRefundFailed]
    Dispatch -- known ignored event --> Ack[200 no state change]
    Dispatch -- unknown event --> Ack
    Capture --> Outcome{Deferred?}
    Failed --> Outcome
    Processed --> Outcome
    RefundFailed --> Outcome
    Outcome -- no --> Mark[Mark event processed]
    Outcome -- yes --> FailedRow[Record failure/deferred reason\nleave unprocessed for reconciliation]
    Mark --> OK[200]
    FailedRow --> OK
    AnyError[Unhandled processing error] --> MarkFailed[Record failure] --> Retry[5xx\nRazorpay retries]
```

The code comments describe this as atomic, but the review found that claiming/dispatch behaviour still needs live concurrency testing. In particular, a failure/deferred row and an in-flight duplicate must be tested with two simultaneous deliveries rather than inferred from unit tests.

## 10. Customer authentication flow

### 10.1 Password signup/login and Firebase exchange

```mermaid
flowchart TD
    Signup[POST /v1/auth/signup] --> LocalChecks[Check local email/mobile uniqueness]
    LocalChecks --> CreateFB[Firebase Admin createUser]
    CreateFB -- error --> SignupError[409 or 422]
    CreateFB -- success --> InsertCustomer[Insert local customer]
    InsertCustomer --> Consent[Optional marketing consent activity log]
    Consent --> GuestMerge[Merge guest cart]
    GuestMerge --> Session[Insert opaque refresh session\nissue customer access JWT]

    Login[POST /v1/auth/login] --> Mobile{10-digit mobile?}
    Mobile -- yes --> FirebasePhone[Firebase Admin resolve phone -> email]
    Mobile -- no --> PasswordAPI[Identity Toolkit signInWithPassword]
    FirebasePhone --> PasswordAPI
    PasswordAPI --> Local[Find local customer + blocked check]
    Local --> Session

    Firebase[POST /v1/auth/firebase] --> VerifyID[Verify Firebase ID token]
    VerifyID --> Candidates[Parallel lookup:\nFirebase UID, mobile, verified email]
    Candidates --> Resolve{Resolution order}
    Resolve -- UID matches --> SignIn[Sign in existing customer]
    Resolve -- mobile matches --> LinkMobile[Attach Firebase UID\nmark mobile verified]
    Resolve -- verified email matches --> LinkEmail[Attach Firebase UID\nmark email verified]
    Resolve -- no match --> CreateLocal[Create local customer]
    SignIn --> AuthEvent[Write customer_auth_events]
    LinkMobile --> AuthEvent
    LinkEmail --> AuthEvent
    CreateLocal --> AuthEvent
    AuthEvent --> Session

    Gap1[Review finding:\nsignup ignores Firebase createUser return value; local firebase_uid remains null] -.-> InsertCustomer
    Gap2[Review finding:\nFirebase link/create is read-then-write; concurrent exchanges can conflict or last-write-wins] -.-> Resolve
    Gap3[Review finding:\nFirebase user can be created before local insert; failures leave an orphan external account] -.-> InsertCustomer

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Gap1,Gap2,Gap3 risk
```

### 10.2 Customer refresh and password reset

```mermaid
flowchart TD
    Refresh[POST /v1/auth/refresh\nhttpOnly ach_rt cookie] --> Hash[Hash presented refresh token]
    Hash --> Parallel[Parallel DB session lookup + Redis spent-token lookup]
    Parallel --> Decide{Refresh decision}
    Decide -- unknown/expired/revoked --> Reject[401]
    Decide -- spent token --> Reuse[Revoke session family\nRedis denylist + security log\n401]
    Decide -- live --> Customer[Load customer + blocked check]
    Customer --> NewToken[Generate next refresh token]
    NewToken --> Conditional[Conditional UPDATE by session id + old hash]
    Conditional --> Won{Updated?}
    Won -- no --> Race[Revoke family\n401 reuse]
    Won -- yes --> Remember[Remember old hash in Redis]
    Remember --> Access[Issue new customer access JWT\nreturn new cookie]

    Forgot[POST /v1/auth/forgot-password] --> LocalCustomer[Find local customer]
    LocalCustomer --> FirebaseReset[Firebase sendOobCode]
    FirebaseReset --> Always[Always return 204-style success]
    Reset[POST /v1/auth/reset-password] --> Confirm[Firebase resetPassword with oobCode]
    Confirm --> UpdateLocal[Mark local email verified\nrevoke all local sessions]

    Note[Customer reset token lifecycle is owned by Firebase in current code; staff reset uses otp_challenges and has a separate non-atomic consume path.] -.-> Reset
```

## 11. Staff/admin authentication and request authorization

```mermaid
flowchart TD
    AdminLogin[POST /v1/admin/auth/login] --> FindStaff[Find staff + role]
    FindStaff --> Password{Password valid?}
    Password -- no --> FailedLogin[Atomic failed count increment\nlock after threshold]
    FailedLogin --> Reject[401]
    Password -- yes --> Status{Staff active?}
    Status -- no --> Forbidden[403]
    Status -- yes --> MFA{MFA enabled?}
    MFA -- no + write-capable --> EnrolChallenge[Issue 5-min enrol challenge]
    MFA -- yes --> VerifyChallenge[Issue 5-min verify challenge]
    MFA -- no + read-only --> Permissions[Read role permissions]
    EnrolChallenge --> Setup[Generate/store TOTP secret]
    Setup --> Enable[Verify TOTP\nstore recovery-code digests\nissue session]
    VerifyChallenge --> MFAInput[POST /2fa\nTOTP or recovery code]
    MFAInput --> MFAValid{Valid?}
    MFAValid -- no --> MFAFailed[Increment failed login count]
    MFAValid -- yes --> Permissions
    Permissions --> StaffSession[Insert staff session\nissue staff access JWT with role + perms]

    Request[Admin request with Bearer JWT] --> VerifyJWT[Verify staff JWT\ncheck Redis session denylist]
    VerifyJWT --> ClaimPermission[Check permission claims in JWT]
    ClaimPermission --> Warehouse[Service reads requested warehouse ids]
    Warehouse --> Mutation[Inventory/order/resource mutation]

    Scope[Review finding:\nwarehouse scope associations are loaded but arbitrary warehouse ids are not consistently rejected] -.-> Warehouse
    Stale[Review finding:\npermissions are JWT claims; revoked grants remain usable until token expiry] -.-> ClaimPermission
    Challenge[Review finding:\nchallenge JWT can replay until expiry; successful TOTP does not consume it] -.-> VerifyChallenge
    Lock[Review finding:\nverifyTwoFactor does not check lockedUntil; an old challenge remains usable after lockout] -.-> MFAInput
    Recovery[Review finding:\nrecovery-code digest list read/rewrite is not atomic; same code can win twice] -.-> MFAInput
    RefreshRace[Review finding:\nstaff refresh rotation updates by session id without matching old hash] -.-> StaffSession

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Scope,Stale,Challenge,Lock,Recovery,RefreshRace risk
```

### Staff operations after authorization

```mermaid
flowchart LR
    JWT[Staff JWT] --> Gate[authenticate + requirePermission]
    Gate --> Service[Admin service]
    Service --> Tx[Transaction where required]
    Tx --> Inventory[(Inventory ledger)]
    Tx --> Orders[(Orders / payments / invoices)]
    Tx --> Catalogue[(Catalogue / content)]
    Tx --> Warehouses[(Warehouses / transfers)]
    Tx --> Audit[Audit middleware outside mutation transaction]

    AuditNote[Review finding:\naudit is best-effort, outside the mutation transaction, and records request intent rather than persisted before/after state] -.-> Audit
    IdemNote[Review finding:\nall staff idempotency keys use shared Redis scope `anon`] -.-> Gate

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class AuditNote,IdemNote risk
```

## 12. Inventory and warehouse flow

```mermaid
flowchart TD
    Admin[Authorized staff] --> Request[Inventory / warehouse request]
    Request --> WarehouseId[Client supplies warehouseId]
    WarehouseId --> Lookup[Find warehouse / inventory level]
    Lookup --> ScopeCheck{Staff assigned to warehouse?}
    ScopeCheck -- current implementation often no check --> Proceed[Proceed with service operation]
    ScopeCheck -- expected policy --> RejectScope[403 or 404 out of scope]
    Proceed --> Tx[BEGIN transaction]
    Tx --> LockLevels[Lock affected inventory levels\nin deterministic id order]
    LockLevels --> Conditional[Conditional UPDATE\nprotect on_hand/reserved invariants]
    Conditional --> Ledger[Append stock movement / reservation]
    Ledger --> Commit[COMMIT]

    StockCount[Stock count] --> Freeze[Freeze system quantity snapshot]
    Freeze --> CountItems[Record count items]
    CountItems --> Adjustment[Create controlled adjustment movement]
    Adjustment --> Commit

    Transfer[Stock transfer] --> Dispatch[Dispatch source stock]
    Dispatch --> Transit[Transfer in transit\nsource decremented]
    Transit --> Receive[Receive destination stock\nallow short, reject over]
    Receive --> Commit

    ScopeFinding[Review finding:\npermissions and services accept arbitrary warehouse IDs, including cross-scope transfers] -.-> ScopeCheck
    UniqueFinding[Review finding:\ngeneric warehouse/variant default edits can surface raw unique-index conflicts] -.-> Proceed

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class ScopeFinding,UniqueFinding risk
```

## 13. Media upload flow

```mermaid
flowchart TD
    Client[Multipart request] --> Route[Admin or customer media route]
    Route --> DefineRoute[defineRoute adds fileInterceptor\nbecause bodyContentType is multipart]
    DefineRoute --> GlobalMulter[Multer upload.any()]
    GlobalMulter --> Each[For each req.files entry]
    Each --> S3[Upload object to S3]
    S3 --> MediaRow[Insert media_assets row]
    MediaRow --> BodyMap[Set req.body[fieldname] = asset.id]
    BodyMap --> Validate[Later Zod validation]
    Validate --> Handler[Route handler invokes upload.single('file')]
    Handler --> SecondMulter[Second Multer parser]
    SecondMulter --> Missing{req.file present?}
    Missing -- no --> Broken[400 No file provided]
    Missing -- yes --> Service[Upload/persist again]

    Orphan[Review finding:\nfirst upload can remain in S3 + media_assets if downstream validation or a later service step fails] -.-> MediaRow
    Security[Review finding:\nMIME/extension are client-controlled; no content sniffing, file-count, or aggregate-volume cap] -.-> Each
    Ownership[Review finding:\ncustomer media has no ownership field; admin upload only requires dashboard:view] -.-> MediaRow

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Broken,Orphan,Security,Ownership risk
```

## 14. Database transaction and trigger flow

### Order creation transaction

```mermaid
sequenceDiagram
    participant S as Checkout service
    participant DB as PostgreSQL transaction
    participant C as Coupon row
    participant I as Inventory rows
    participant N as Numbering row
    participant O as Orders/cart/lines

    S->>DB: BEGIN
    S->>C: Conditional coupon claim + row lock
    S->>DB: Check customer redemption count
    S->>I: SELECT affected levels FOR UPDATE in id order
    S->>I: Conditional reserve updates
    S->>N: Lock/increment order number series
    S->>O: Insert order header
    S->>O: Insert lines, add-ons, personalisation
    S->>O: Insert order reservations and timeline
    S->>O: Mark cart converted by cart id
    S->>DB: COMMIT
    DB->>DB: Deferred order-total trigger checks I1-I4
```

### Static SQL trigger concerns

```mermaid
flowchart TD
    LineChange[INSERT/UPDATE/DELETE order_lines] --> Trigger[Deferred trg_order_totals_lines]
    HeaderChange[Watched UPDATE on orders header totals] --> TriggerHeader[Deferred trg_order_totals_header]
    Trigger --> Function[check_order_totals()]
    TriggerHeader --> Function
    Function --> Lookup[SELECT order by coalesce(NEW.order_id, NEW.id)]
    Lookup --> Totals[SUM active order-line gross/discount/tax]
    Totals --> Checks[I1 subtotal\nI2 discounts\nI3 total\nI4 tax]
    Checks --> Commit[Allow or reject COMMIT]

    Bug[Static finding:\norders trigger rows have no order_id; `NEW.order_id` is not an orders column. Requires live PostgreSQL confirmation when the header trigger fires.] -.-> Lookup
    Mismatch[Static finding:\nSQL split_inclusive_tax() and TypeScript tax logic are not identical around cess, although the application does not currently call the SQL function.] -.-> Function
    Date[Static finding:\ninvoice service uses UTC FY while SQL indian_fy() uses Asia/Kolkata] -.-> Checks

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Bug,Mismatch,Date risk
```

### Database areas

```mermaid
mindmap
  root((PostgreSQL))
    Identity
      customers
      staff_users
      sessions
      roles and permissions
      api_keys schema only
      OTP challenges
    Catalogue
      products
      variants
      collections
      add-ons
      personalisation
      builders
      media links
    Commerce
      carts
      cart lines
      orders
      order lines
      addresses
      coupons
    Payments
      payment sessions
      payment events
      refunds
      invoices
      credit notes
    Inventory
      warehouses
      locations
      inventory levels
      reservations
      stock movements
      transfers
      counts
      production
      purchasing
    Platform
      activity logs
      notifications
      webhooks
      webhook deliveries
      import jobs
      app settings
      search vocabulary
```

## 15. Background jobs and delivery flow

```mermaid
flowchart LR
    API[API request] --> DB[Persist durable state]
    DB --> Intended[Intent to enqueue async work]
    Intended --> Queue[(BullMQ / Redis)]
    Queue --> Worker[Expected src/worker.ts / dist/worker.js]
    Worker --> SES[Email]
    Worker --> Notifications[Notifications / reconciliation / refresh jobs]

    Current[Current repository] -. no worker source or dist worker .-> Worker
    Leads[Lead service currently sends email synchronously\ninside request path] -.-> SES
    SESStub[Production SES sender intentionally rejects\n(no AWS SES client implemented)] -.-> SES
    SearchRefresh[No discovered search_vocabulary refresh job] -.-> Queue

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class Current,Leads,SESStub,SearchRefresh risk
```

**Operational consequence:** a lead request can be saved successfully while its synchronous notification fails, and production password-reset/admin-reset or lead email delivery is not actually implemented unless a different sender is injected. The Compose worker cannot currently start.

## 16. Idempotency, rate limiting, audit, and failure paths

```mermaid
flowchart TD
    Request[Mutation request] --> Rate[Global + named rate limiter]
    Rate --> Key{Idempotency-Key?}
    Key -- required route --> RedisGet[GET idem:scope:key]
    RedisGet --> Existing{Existing value?}
    Existing -- stored response --> Replay[Return stored response]
    Existing -- pending --> Conflict[409 in flight]
    Existing -- none --> NX[SET pending NX EX 300]
    NX --> Handler[Run mutation]
    Handler --> Response[Send response]
    Response --> AsyncStore[Fire-and-forget Redis SET success\nor DEL failure]

    AdminMutation[Admin mutation] --> AuditWrite[Best-effort activity log]
    AuditWrite --> DomainMutation[Domain transaction]

    RedisDown[Redis store error] --> FailOpen[passOnStoreError=true\nrequest proceeds without named limit]
    Proxy[X-Forwarded-For header] --> Spoof[Client can influence IP key]
    AuthOrder[Limiter before authenticate] --> NoUser[byUser key falls back to IP]

    Scope[Current scopes:\ncustomer id for customer routes; `anon` for staff] --> Collision[Staff keys collide across users]
    AsyncStore --> Crash[Process/network failure before write\nretry can repeat side effect]
    PendingTTL[Handler active > 300s] --> Expire[Pending claim expires\nsecond request can start]

    classDef risk fill:#ffebee,stroke:#c62828,color:#111
    class FailOpen,Spoof,NoUser,Collision,Crash,Expire risk
```

## 17. Build, test, lint, and audit flow

```mermaid
flowchart TD
    Checkout[Repository checkout] --> Install[npm ci --ignore-scripts]
    Install --> Test[npm test]
    Install --> Typecheck[npm run typecheck]
    Install --> Build[npm run build]
    Install --> Lint[npm run lint]
    Install --> Audit[npm audit --omit=dev]
    Install --> OpenAPI[Expected OpenAPI/doc scripts]
    Install --> Worker[Expected worker start]

    Test --> TestResult[676/676 tests passed]
    Typecheck --> TypeResult[Passed]
    Build --> BuildResult[Passed]
    Lint --> LintResult[52 errors]
    Audit --> AuditResult[6 moderate production vulnerabilities]
    OpenAPI --> OpenAPIResult[Scripts absent:\nopenapi:generate, openapi:lint, docs:generate]
    Worker --> WorkerResult[dist/worker.js absent]

    Coverage[Passing unit tests] -.-> Gap[No real HTTP, PostgreSQL migration, Redis, S3,\nRazorpay, SES, or endpoint authorization integration coverage]
    TestResult -.-> Gap

    classDef pass fill:#e8f5e9,stroke:#2e7d32,color:#111
    classDef fail fill:#ffebee,stroke:#c62828,color:#111
    class TestResult,TypeResult,BuildResult pass
    class LintResult,AuditResult,OpenAPIResult,WorkerResult,Gap fail
```

## 18. Review priority map

| Priority | Area | Current flow impact | Main locations |
|---|---|---|---|
| **P0 / immediate** | Secret exposure | The hardcoded remote fallback has been removed from the working tree, but the exposed credential remains in repository history and must be rotated/revoked and purged from history/caches. | `drizzle.config.ts`, commit `002a74a3d9563b959cd0469246467fe0bd39b054` |
| **P0 / immediate** | Payment settlement | Captures can be applied after cancellation/refund states, captured amounts are not capped, and stale session state can double-credit or overwrite captures. | `src/modules/payments/payments.service.ts` |
| **P0 / immediate** | Staff MFA | Old challenge tokens can replay; lockout is not consulted in MFA verification; recovery-code consumption is read/rewrite rather than atomic. | `src/modules/admin-auth/admin-auth.service.ts` |
| **P1** | Checkout/cart ownership | Concurrent submissions can create multiple orders from one cart; unconditional cart conversion leaves multiple durable orders. | `src/modules/checkout/checkout.service.ts`, `checkout.repository.ts` |
| **P1** | Media upload | The dedicated double parser is removed, but the shared interceptor still persists before downstream validation; MIME/content sniffing, ownership, file limits, and S3/DB cleanup remain. | `src/middleware/file-interceptor.ts`, `src/modules/media/*` |
| **P1** | Warehouse authorization | A staff user can supply warehouse IDs outside their assigned scope in multiple inventory/transfer/report paths. | `src/modules/admin-*`, staff warehouse scope repository |
| **Done / follow-up** | Admin docs | Admin OpenAPI JSON and UI now use `guardAdminDocs`; the Storefront UI and JSON remain public. Authorized documentation access should be tested with a real staff token. | `src/lib/openapi/swagger.ts` |
| **P1** | Production operations | Worker entrypoint is absent; SES production sender is a rejecting stub; deployment does not provide the promised asynchronous processing. | `src/`, `Dockerfile`, `docker-compose.prod.yml`, `src/integrations/ses/index.ts` |
| **P2** | Auth consistency | Firebase signup does not save returned UID, Firebase linking is race-prone, and external account creation has no compensation. | `src/modules/auth/auth.service.ts`, `firebase-auth.service.ts` |
| **P2** | Refresh/idempotency | Staff refresh rotation is non-conditional; staff keys share `anon`; successful response persistence is asynchronous. | `src/modules/admin-auth/admin-auth.service.ts`, `src/middleware/idempotency.ts` |
| **P2** | Search/API delivery | Search limiter is absent and vocabulary has no refresh path. The cart token CORS allow/expose headers are now configured. | `src/modules/search/search.routes.ts`, `src/modules/cart/*`, `src/app.ts` |
| **P2** | Database correctness | Order trigger references an order row field that does not exist; invoice FY calculation uses UTC in TypeScript versus IST in SQL. | `src/db/migrations/0001_initial.sql`, `admin-orders.service.ts` |
| **P2** | Build hygiene | Lint fails, production audit has six moderate findings, and documentation scripts are missing. | `package.json`, lint output, `npm audit` |

## 19. Recommended end-to-end execution order

```mermaid
flowchart TD
    A[1. Rotate/revoke committed credential\nand purge history/caches] --> B[2. Block unsafe production startup\nDB TLS, Razorpay mode, Firebase/S3/SES readiness]
    B --> C[3. Fix payment state machine\nterminal checks, amount caps, locked re-reads]
    C --> D[4. Atomically claim carts and\nmake payment/session operations idempotent]
    D --> E[5. Fix staff MFA and refresh\nconditional consumption/rotation]
    E --> F[6. Enforce warehouse scope\nat service/repository boundary]
    F --> G[7. Finish media hardening\nvalidate/sniff/cleanup files]
    G --> H[8. Add worker + durable outbox/jobs\nimplement SES]
    H --> I[9. Add real integration tests\nPostgres, Redis, HTTP, S3, Razorpay]
    I --> J[10. Fix lint/audit and restore\nOpenAPI generation gates]
    J --> K[11. Re-run production readiness review]
```
