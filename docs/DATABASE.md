# Achichiz Database Reference

> **Generated** from `src/db/migrations/*.sql`, which is the authoritative DDL.
> Regenerate with `npm run docs:generate` — do not hand-edit.

**118 tables.** Names are as they exist in PostgreSQL (`snake_case`, plural); Drizzle
maps them to `camelCase` at the schema boundary, which is the single translation point in the codebase.

## How money and tax are stored

- **Money is `BIGINT` paise**, never `NUMERIC` and never a float. Paise fit safely inside
  `Number.MAX_SAFE_INTEGER` (₹90,071,992,547), and `node-postgres` is configured to parse
  `INT8` to a JS number with an explicit safe-integer check.
- **Percentages are integer basis points** (250 = 2.5%), so fractional slabs are expressible.
- **Catalogue prices are GST-inclusive.** Tax is back-computed per line at that line's HSN rate;
  `taxable` is derived first and `tax` taken as the remainder, so `taxable + tax = gross` holds
  by construction rather than by reconciliation.
- **Place of supply** follows s.10(1)(a) for B2C and s.10(1)(b) bill-to/ship-to for corporate
  campaigns, so a 400-recipient campaign gets one tax treatment rather than 400.
- **Document numbers** (invoices, credit notes) come from `document_number_series` under a row
  lock — gapless per financial year, as Rule 46(b) requires. Order numbers use a plain sequence,
  where gaps are acceptable.

## Objects Drizzle does not model

The TypeScript schema is not the whole picture. These live only in the SQL migration:

| Object | Why it matters |
|---|---|
| `check_order_totals()` — DEFERRABLE constraint trigger | Validates order totals against the sum of lines **at commit**. The single most important invariant in the schema, and completely invisible from the TS side. |
| `split_inclusive_tax()` | Splits a GST-inclusive amount; absorbs the odd paisa into taxable value so `cgst = sgst` stays true. |
| Domains (`mobile_in`, `gstin`, `pincode`, `hsn`, …) | Format checks enforced by the database, invisible to TypeScript. |
| `CITEXT` columns | Case-insensitive comparison in the DB; declared as `text()` in Drizzle. |
| `EXCLUDE USING gist` on `gst_rates` | Prevents overlapping rate periods for the same HSN. |
| Generated columns | `inventory_levels.available_qty`, `staff_users.avatar_initials`. |
| Partial unique indexes `WHERE deleted_at IS NULL` | Soft-deleted rows must not squat on a handle forever. |
| `set_updated_at()` triggers | On every table carrying `updated_at`. |

---


## Identity & staff

7 tables


### `roles`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `key` | `TEXT` | NOT NULL · UNIQUE |
| `name` | `TEXT` | NOT NULL · UNIQUE |
| `description` | `TEXT` |  |
| `is_system` | `BOOLEAN` | NOT NULL · default false |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `role_permissions`

| Column | Type | Notes |
|---|---|---|
| `role_id` | `UUID` | NOT NULL · → `roles` (ON DELETE CASCADE) |
| `module` | `TEXT` | NOT NULL |
| `action` | `TEXT` | NOT NULL |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (role_id, module, action)`

</details>

<details><summary>Indexes</summary>

- `idx_role_permissions_module`(module, action)

</details>


### `staff_users`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `email` | `CITEXT` | NOT NULL |
| `full_name` | `TEXT` | NOT NULL |
| `password_hash` | `TEXT` |  |
| `role_id` | `UUID` | NOT NULL · → `roles` (ON DELETE RESTRICT) |
| `phone` | `mobile_in` |  |
| `avatar_initials` | `TEXT` | GENERATED |
| `mfa_enabled` | `BOOLEAN` | NOT NULL · default false |
| `mfa_secret` | `TEXT` |  |
| `status` | `TEXT` | NOT NULL · default 'invited' |
| `last_active_at` | `TIMESTAMPTZ` |  |
| `invited_at` | `TIMESTAMPTZ` |  |
| `password_changed_at` | `TIMESTAMPTZ` |  |
| `failed_login_count` | `SMALLINT` | NOT NULL · default 0 |
| `locked_until` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT staff_active_needs_password CHECK (status <> 'active' OR password_hash IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_staff_email`(email) WHERE deleted_at IS NULL
- `idx_staff_users_role`(role_id) WHERE deleted_at IS NULL
- `idx_staff_users_status`(status) WHERE deleted_at IS NULL
- `idx_staff_users_name_trgm`USING gin (full_name gin_trgm_ops)

</details>


### `staff_user_warehouses`

| Column | Type | Notes |
|---|---|---|
| `staff_user_id` | `UUID` | NOT NULL · → `staff_users` (ON DELETE CASCADE) |
| `warehouse_id` | `UUID` | NOT NULL · → `warehouses` (ON DELETE CASCADE) |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (staff_user_id, warehouse_id)`

</details>


### `staff_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `staff_user_id` | `UUID` | NOT NULL · → `staff_users` (ON DELETE CASCADE) |
| `refresh_token_hash` | `TEXT` | NOT NULL · UNIQUE |
| `device_label` | `TEXT` |  |
| `user_agent` | `TEXT` |  |
| `ip` | `INET` |  |
| `location_label` | `TEXT` |  |
| `issued_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `last_active_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL |
| `revoked_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT staff_session_window CHECK (expires_at > issued_at)`

</details>

<details><summary>Indexes</summary>

- `idx_staff_sessions_user`(staff_user_id, last_active_at DESC) WHERE revoked_at IS NULL
- `idx_staff_sessions_expiry`(expires_at) WHERE revoked_at IS NULL

</details>


### `api_keys`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `label` | `TEXT` | NOT NULL |
| `key_prefix` | `TEXT` | NOT NULL · UNIQUE |
| `key_hash` | `TEXT` | NOT NULL |
| `environment` | `TEXT` | NOT NULL · default 'live' |
| `scopes` | `TEXT[]` | NOT NULL · default '{}' |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `last_used_at` | `TIMESTAMPTZ` |  |
| `expires_at` | `TIMESTAMPTZ` |  |
| `revoked_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_api_keys_active`(key_prefix) WHERE revoked_at IS NULL

</details>


### `otp_challenges`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `channel` | `TEXT` | NOT NULL |
| `destination` | `TEXT` | NOT NULL |
| `code_hash` | `TEXT` | NOT NULL |
| `purpose` | `TEXT` | NOT NULL |
| `attempts` | `SMALLINT` | NOT NULL · default 0 |
| `max_attempts` | `SMALLINT` | NOT NULL · default 5 |
| `consumed_at` | `TIMESTAMPTZ` |  |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_otp_dest`(destination, purpose, created_at DESC) WHERE consumed_at IS NULL

</details>


## Customers

8 tables


### `customers`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `email` | `CITEXT` |  |
| `mobile` | `mobile_in` |  |
| `full_name` | `TEXT` |  |
| `birthday` | `DATE` |  |
| `gender` | `TEXT` |  |
| `password_hash` | `TEXT` |  |
| `auth_provider_uid` | `UUID` |  |
| `email_verified_at` | `TIMESTAMPTZ` |  |
| `mobile_verified_at` | `TIMESTAMPTZ` |  |
| `marketing_opt_in` | `BOOLEAN` | NOT NULL · default false |
| `whatsapp_opt_in` | `BOOLEAN` | NOT NULL · default false |
| `segment` | `TEXT` |  |
| `corporate_account_id` | `UUID` | → `corporate_accounts` (ON DELETE SET NULL) |
| `default_billing_gstin` | `gstin` |  |
| `tags` | `TEXT[]` | NOT NULL · default '{}' |
| `accepts_cod` | `BOOLEAN` | NOT NULL · default true |
| `blocked_at` | `TIMESTAMPTZ` |  |
| `blocked_reason` | `TEXT` |  |
| `first_order_at` | `TIMESTAMPTZ` |  |
| `last_order_at` | `TIMESTAMPTZ` |  |
| `legacy_ref` | `TEXT` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT customer_needs_a_handle CHECK (email IS NOT NULL OR mobile IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_customers_email`(email) WHERE deleted_at IS NULL
- UNIQUE `uq_customers_mobile`(mobile) WHERE deleted_at IS NULL
- UNIQUE `uq_customers_auth_uid`(auth_provider_uid) WHERE auth_provider_uid IS NOT NULL AND deleted_at IS NULL
- `idx_customers_segment`(segment) WHERE deleted_at IS NULL
- `idx_customers_last_order`(last_order_at DESC NULLS LAST)
- `idx_customers_corporate`(corporate_account_id) WHERE corporate_account_id IS NOT NULL
- `idx_customers_tags`USING gin (tags)
- `idx_customers_search_trgm`USING gin ( (coalesce(full_name,'') || ' ' || coalesce(email::text,'') || ' ' || coalesce(mobile,'')) gin_trgm_ops)
- `idx_customers_legacy_ref`(legacy_ref) WHERE legacy_ref IS NOT NULL

</details>


### `customer_stats`

| Column | Type | Notes |
|---|---|---|
| `customer_id` | `UUID` | PK · → `customers` (ON DELETE CASCADE) |
| `order_count` | `INTEGER` | NOT NULL · default 0 |
| `lifetime_spend_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `aov_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `return_count` | `INTEGER` | NOT NULL · default 0 |
| `loyalty_points` | `INTEGER` | NOT NULL · default 0 |
| `computed_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `addresses`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `customer_id` | `UUID` | NOT NULL · → `customers` (ON DELETE CASCADE) |
| `label` | `TEXT` | NOT NULL · default 'Home' |
| `contact_name` | `TEXT` | NOT NULL |
| `mobile` | `mobile_in` | NOT NULL |
| `line1` | `TEXT` | NOT NULL |
| `line2` | `TEXT` |  |
| `area` | `TEXT` |  |
| `city` | `TEXT` | NOT NULL |
| `state_code` | `CHAR(2)` | NOT NULL · → `gst_states` (ON DELETE RESTRICT) |
| `pincode` | `pincode` | NOT NULL |
| `country_code` | `CHAR(2)` | NOT NULL · default 'IN' |
| `is_default` | `BOOLEAN` | NOT NULL · default false |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_one_default_address_per_customer`(customer_id) WHERE is_default AND deleted_at IS NULL
- `idx_addresses_customer`(customer_id) WHERE deleted_at IS NULL
- `idx_addresses_pincode`(pincode)

</details>


### `recipients`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `customer_id` | `UUID` | NOT NULL · → `customers` (ON DELETE CASCADE) |
| `name` | `TEXT` | NOT NULL |
| `relation` | `TEXT` |  |
| `mobile` | `mobile_in` |  |
| `address_id` | `UUID` | → `addresses` (ON DELETE SET NULL) |
| `occasion` | `TEXT` |  |
| `next_date` | `DATE` |  |
| `reminder_on` | `BOOLEAN` | NOT NULL · default true |
| `gifts_sent` | `INTEGER` | NOT NULL · default 0 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- `idx_recipients_customer`(customer_id) WHERE deleted_at IS NULL
- `idx_recipients_reminder`(next_date) WHERE reminder_on AND deleted_at IS NULL

</details>


### `customer_segments`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `name` | `TEXT` | NOT NULL · UNIQUE |
| `rule` | `JSONB` | NOT NULL |
| `rule_text` | `TEXT` |  |
| `is_dynamic` | `BOOLEAN` | NOT NULL · default true |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `member_count` | `INTEGER` | NOT NULL · default 0 |
| `revenue_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `refreshed_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `customer_segment_members`

| Column | Type | Notes |
|---|---|---|
| `segment_id` | `UUID` | NOT NULL · → `customer_segments` (ON DELETE CASCADE) |
| `customer_id` | `UUID` | NOT NULL · → `customers` (ON DELETE CASCADE) |
| `added_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (segment_id, customer_id)`

</details>

<details><summary>Indexes</summary>

- `idx_segment_members_customer`(customer_id)

</details>


### `wishlist_items`

| Column | Type | Notes |
|---|---|---|
| `customer_id` | `UUID` | NOT NULL · → `customers` (ON DELETE CASCADE) |
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `added_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (customer_id, product_id)`

</details>


### `customer_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `customer_id` | `UUID` | NOT NULL · → `customers` (ON DELETE CASCADE) |
| `refresh_token_hash` | `TEXT` | NOT NULL · UNIQUE |
| `device_label` | `TEXT` |  |
| `ip` | `INET` |  |
| `issued_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `last_active_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL |
| `revoked_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- `idx_customer_sessions`(customer_id) WHERE revoked_at IS NULL
- `idx_customer_sessions_exp`(expires_at) WHERE revoked_at IS NULL

</details>


## Catalogue

18 tables


### `designers`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `handle` | `handle` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `kind` | `TEXT` | NOT NULL · default 'brand' |
| `bio` | `TEXT` |  |
| `logo_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `commission_bp` | `percent_bp` |  |
| `contact_email` | `CITEXT` |  |
| `contact_phone` | `mobile_in` |  |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_designers_handle`(handle) WHERE deleted_at IS NULL
- UNIQUE `uq_designers_name`(name) WHERE deleted_at IS NULL
- `idx_designers_status`(status) WHERE deleted_at IS NULL

</details>


### `collections`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `handle` | `handle` | NOT NULL |
| `kind` | `TEXT` | NOT NULL |
| `parent_id` | `UUID` | → `collections` (ON DELETE SET NULL) |
| `title` | `TEXT` | NOT NULL |
| `heading` | `TEXT` |  |
| `subtext` | `TEXT` |  |
| `seo_description` | `TEXT` |  |
| `hero_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `designer_id` | `UUID` | → `designers` (ON DELETE SET NULL) |
| `curator` | `TEXT` |  |
| `sort_order` | `INTEGER` | NOT NULL · default 0 |
| `is_featured` | `BOOLEAN` | NOT NULL · default false |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `starts_on` | `TIMESTAMPTZ` |  |
| `ends_on` | `TIMESTAMPTZ` |  |
| `legacy_ref` | `TEXT` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `updated_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT collection_no_self_parent CHECK (parent_id IS DISTINCT FROM id)`
- `CONSTRAINT collection_window CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on > starts_on)`
- `CONSTRAINT collection_designer_kind CHECK (kind = 'designer' OR designer_id IS NULL)`
- `CONSTRAINT collection_scheduled_needs_start CHECK (status <> 'scheduled' OR starts_on IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_collections_handle`(handle) WHERE deleted_at IS NULL
- `idx_collections_kind`(kind, sort_order) WHERE deleted_at IS NULL
- `idx_collections_parent`(parent_id) WHERE deleted_at IS NULL
- `idx_collections_live`(status) WHERE status = 'live' AND deleted_at IS NULL
- `idx_collections_legacy_ref`(legacy_ref) WHERE legacy_ref IS NOT NULL
- `idx_collections_title_trgm`USING gin ( (title || ' ' || coalesce(heading, '')) gin_trgm_ops )

</details>


### `products`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `handle` | `handle` | NOT NULL |
| `title` | `TEXT` | NOT NULL |
| `subtitle` | `TEXT` |  |
| `description` | `TEXT` |  |
| `kind` | `TEXT` | NOT NULL · default 'single_gift' |
| `designer_id` | `UUID` | → `designers` (ON DELETE SET NULL) |
| `primary_collection_id` | `UUID` | → `collections` (ON DELETE SET NULL) |
| `hsn_code` | `hsn` | → `hsn_codes` (ON DELETE RESTRICT) |
| `is_personalisable` | `BOOLEAN` | NOT NULL · default false |
| `is_perishable` | `BOOLEAN` | NOT NULL · default false |
| `is_fragile` | `BOOLEAN` | NOT NULL · default false |
| `requires_shipping` | `BOOLEAN` | NOT NULL · default true |
| `low_stock_threshold` | `INTEGER` | NOT NULL · default 10 |
| `badge_override` | `TEXT` |  |
| `tags` | `TEXT[]` | NOT NULL · default '{}' |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `published_at` | `TIMESTAMPTZ` |  |
| `legacy_ref` | `TEXT` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `updated_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT product_active_needs_publish CHECK (status <> 'active' OR published_at IS NOT NULL)`
- `CONSTRAINT product_active_needs_hsn CHECK (status <> 'active' OR hsn_code IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_products_handle`(handle) WHERE deleted_at IS NULL
- `idx_products_status`(status, published_at DESC) WHERE deleted_at IS NULL
- `idx_products_designer`(designer_id) WHERE deleted_at IS NULL
- `idx_products_kind`(kind) WHERE deleted_at IS NULL
- `idx_products_tags`USING gin (tags)
- `idx_products_new`(published_at DESC) WHERE status = 'active' AND deleted_at IS NULL
- `idx_products_search_trgm`USING gin ( (title || ' ' || coalesce(subtitle,'')) gin_trgm_ops)
- `idx_products_fts`USING gin ( to_tsvector('english', title || ' ' || coalesce(description,'')))
- `idx_products_legacy_ref`(legacy_ref) WHERE legacy_ref IS NOT NULL
- `idx_products_fts_wide`USING gin ( to_tsvector('english', coalesce(title, '') || ' ' || coalesce(subtitle, '') || ' ' || coalesce(description, '') || ' ' || array_to_string(tags, ' ')) )
- `idx_products_title_lower_pattern`(lower(title) text_pattern_ops) WHERE status = 'active' AND deleted_at IS NULL

</details>


### `product_variants`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `sku` | `TEXT` | NOT NULL |
| `option_label` | `TEXT` | NOT NULL · default 'Standard' |
| `option_value` | `handle` | NOT NULL · default 'standard' |
| `price_paise` | `nonneg_paise` | NOT NULL |
| `compare_at_paise` | `nonneg_paise` |  |
| `cost_paise` | `nonneg_paise` |  |
| `weight_grams` | `INTEGER` |  |
| `length_mm` | `INTEGER` |  |
| `width_mm` | `INTEGER` |  |
| `height_mm` | `INTEGER` |  |
| `barcode` | `TEXT` |  |
| `is_default` | `BOOLEAN` | NOT NULL · default false |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT variant_compare_at_sane CHECK (compare_at_paise IS NULL OR compare_at_paise >= price_paise)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_variants_sku`(sku) WHERE deleted_at IS NULL
- UNIQUE `uq_variants_barcode`(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL
- UNIQUE `uq_variant_option_per_product`(product_id, option_value) WHERE deleted_at IS NULL
- UNIQUE `uq_one_default_variant_per_product`(product_id) WHERE is_default AND deleted_at IS NULL
- `idx_variants_product`(product_id, position) WHERE deleted_at IS NULL
- `idx_variants_sku_trgm`USING gin (sku gin_trgm_ops)

</details>


### `product_collections`

| Column | Type | Notes |
|---|---|---|
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `collection_id` | `UUID` | NOT NULL · → `collections` (ON DELETE CASCADE) |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `added_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (product_id, collection_id)`

</details>

<details><summary>Indexes</summary>

- `idx_product_collections_listing`(collection_id, position, product_id)

</details>


### `product_media`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE CASCADE) |
| `media_id` | `UUID` | NOT NULL · → `media_assets` (ON DELETE RESTRICT) |
| `alt_text` | `TEXT` |  |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_product_media_product`(product_id, position)
- UNIQUE `uq_product_media_once`(product_id, media_id, coalesce(variant_id,'00000000-0000-0000-0000-000000000000'::uuid))

</details>


### `product_content_items`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `body` | `TEXT` | NOT NULL |
| `position` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Indexes</summary>

- `idx_product_content_product`(product_id, position)

</details>


### `product_stats`

| Column | Type | Notes |
|---|---|---|
| `product_id` | `UUID` | PK · → `products` (ON DELETE CASCADE) |
| `rating_avg` | `NUMERIC(2,1)` |  |
| `review_count` | `INTEGER` | NOT NULL · default 0 |
| `units_sold` | `INTEGER` | NOT NULL · default 0 |
| `units_sold_30d` | `INTEGER` | NOT NULL · default 0 |
| `return_rate_bp` | `percent_bp` | NOT NULL · default 0 |
| `revenue_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `computed_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_product_stats_bestsellers`(units_sold_30d DESC)

</details>


### `hamper_items`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `sku` | `TEXT` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `supplier_id` | `UUID` | → `suppliers` (ON DELETE SET NULL) |
| `category` | `TEXT` |  |
| `cost_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `unit` | `TEXT` | NOT NULL · default 'pcs' |
| `weight_grams` | `INTEGER` |  |
| `hsn_code` | `hsn` | → `hsn_codes` (ON DELETE RESTRICT) |
| `is_perishable` | `BOOLEAN` | NOT NULL · default false |
| `shelf_life_days` | `INTEGER` |  |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_hamper_items_sku`(sku) WHERE deleted_at IS NULL
- `idx_hamper_items_supplier`(supplier_id) WHERE deleted_at IS NULL

</details>


### `product_bom_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `variant_id` | `UUID` | NOT NULL · → `product_variants` (ON DELETE CASCADE) |
| `hamper_item_id` | `UUID` | → `hamper_items` (ON DELETE RESTRICT) |
| `component_variant_id` | `UUID` | → `product_variants` (ON DELETE RESTRICT) |
| `quantity` | `NUMERIC(10,3)` | NOT NULL |
| `is_substitutable` | `BOOLEAN` | NOT NULL · default false |

<details><summary>Table constraints</summary>

- `CONSTRAINT bom_exactly_one_component CHECK ( (hamper_item_id IS NOT NULL)::int + (component_variant_id IS NOT NULL)::int = 1)`
- `CONSTRAINT bom_no_self_reference CHECK (component_variant_id IS DISTINCT FROM variant_id)`

</details>

<details><summary>Indexes</summary>

- `idx_bom_variant`(variant_id)
- `idx_bom_item`(hamper_item_id)

</details>


### `add_ons`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `code` | `handle` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `kind` | `TEXT` | NOT NULL · default 'other' |
| `price_paise` | `nonneg_paise` | NOT NULL |
| `hsn_code` | `hsn` | → `hsn_codes` (ON DELETE RESTRICT) |
| `requires_input` | `BOOLEAN` | NOT NULL · default false |
| `input_char_limit` | `INTEGER` |  |
| `lead_time_hours` | `INTEGER` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_add_ons_code`(code) WHERE deleted_at IS NULL

</details>


### `product_add_ons`

| Column | Type | Notes |
|---|---|---|
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `add_on_id` | `UUID` | NOT NULL · → `add_ons` (ON DELETE CASCADE) |
| `price_override_paise` | `nonneg_paise` |  |
| `position` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (product_id, add_on_id)`

</details>


### `personalisation_templates`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `name` | `TEXT` | NOT NULL |
| `method` | `TEXT` | NOT NULL |
| `turnaround_hours` | `INTEGER` | NOT NULL · default 24 |
| `char_limit` | `INTEGER` |  |
| `allows_image` | `BOOLEAN` | NOT NULL · default false |
| `proof_required` | `BOOLEAN` | NOT NULL · default false |
| `surcharge_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_personalisation_templates_name`(name) WHERE deleted_at IS NULL

</details>


### `product_personalisation_templates`

| Column | Type | Notes |
|---|---|---|
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `template_id` | `UUID` | NOT NULL · → `personalisation_templates` (ON DELETE CASCADE) |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (product_id, template_id)`

</details>


### `builder_templates`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `handle` | `handle` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `base_price_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `max_weight_grams` | `INTEGER` |  |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_builder_templates_handle`(handle) WHERE deleted_at IS NULL

</details>


### `builder_template_steps`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `template_id` | `UUID` | NOT NULL · → `builder_templates` (ON DELETE CASCADE) |
| `position` | `INTEGER` | NOT NULL |
| `title` | `TEXT` | NOT NULL |
| `note` | `TEXT` |  |
| `min_choices` | `INTEGER` | NOT NULL · default 0 |
| `max_choices` | `INTEGER` | NOT NULL · default 1 |
| `step_kind` | `TEXT` | NOT NULL · default 'items' |

<details><summary>Table constraints</summary>

- `CONSTRAINT builder_step_range CHECK (max_choices >= min_choices)`
- `UNIQUE (template_id, position)`

</details>


### `builder_step_options`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `step_id` | `UUID` | NOT NULL · → `builder_template_steps` (ON DELETE CASCADE) |
| `hamper_item_id` | `UUID` | → `hamper_items` (ON DELETE CASCADE) |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE CASCADE) |
| `packaging_id` | `UUID` | → `packaging_materials` (ON DELETE CASCADE) |
| `label` | `TEXT` | NOT NULL |
| `price_paise` | `nonneg_paise` | NOT NULL |
| `weight_grams` | `INTEGER` |  |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `is_available` | `BOOLEAN` | NOT NULL · default true |

<details><summary>Table constraints</summary>

- `CONSTRAINT builder_option_exactly_one_source CHECK ( (hamper_item_id IS NOT NULL)::int + (variant_id IS NOT NULL)::int + (packaging_id IS NOT NULL)::int = 1)`

</details>

<details><summary>Indexes</summary>

- `idx_builder_options_step`(step_id, position)

</details>


### `reviews`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `product_id` | `UUID` | NOT NULL · → `products` (ON DELETE CASCADE) |
| `customer_id` | `UUID` | → `customers` (ON DELETE SET NULL) |
| `order_line_id` | `UUID` | → `order_lines` (ON DELETE SET NULL) |
| `author_name` | `TEXT` | NOT NULL |
| `rating` | `SMALLINT` | NOT NULL |
| `title` | `TEXT` |  |
| `body` | `TEXT` |  |
| `is_featured` | `BOOLEAN` | NOT NULL · default false |
| `status` | `TEXT` | NOT NULL · default 'pending' |
| `moderated_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `moderated_at` | `TIMESTAMPTZ` |  |
| `submitted_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- `idx_reviews_product`(product_id, status, submitted_at DESC)
- `idx_reviews_queue`(submitted_at DESC) WHERE status = 'pending'
- UNIQUE `uq_review_one_per_line`(order_line_id) WHERE order_line_id IS NOT NULL AND deleted_at IS NULL

</details>


## Tax reference

4 tables


### `gst_states`

| Column | Type | Notes |
|---|---|---|
| `code` | `CHAR(2)` | PK |
| `name` | `TEXT` | NOT NULL · UNIQUE |
| `is_union_terr` | `BOOLEAN` | NOT NULL · default false |


### `hsn_codes`

| Column | Type | Notes |
|---|---|---|
| `code` | `hsn` | PK |
| `description` | `TEXT` | NOT NULL |
| `is_service` | `BOOLEAN` | NOT NULL · default false |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `gst_rates`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `hsn_code` | `hsn` | NOT NULL · → `hsn_codes` (ON DELETE RESTRICT) |
| `rate_bp` | `percent_bp` | NOT NULL |
| `cess_bp` | `percent_bp` | NOT NULL · default 0 |
| `effective_from` | `DATE` | NOT NULL |
| `effective_to` | `DATE` |  |
| `price_band_max_paise` | `nonneg_paise` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT gst_rate_window CHECK (effective_to IS NULL OR effective_to > effective_from)`

</details>

<details><summary>Indexes</summary>

- `idx_gst_rates_lookup`(hsn_code, effective_from DESC)

</details>


### `document_number_series`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `doc_type` | `TEXT` | NOT NULL |
| `scope_key` | `TEXT` | NOT NULL |
| `prefix` | `TEXT` | NOT NULL |
| `suffix` | `TEXT` | NOT NULL · default '' |
| `pad_width` | `SMALLINT` | NOT NULL · default 6 |
| `next_value` | `BIGINT` | NOT NULL · default 1 |
| `is_active` | `BOOLEAN` | NOT NULL · default true |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `UNIQUE (doc_type, scope_key)`

</details>


## Inventory & procurement

11 tables


### `warehouses`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `code` | `TEXT` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `line1` | `TEXT` | NOT NULL |
| `city` | `TEXT` | NOT NULL |
| `state_code` | `CHAR(2)` | NOT NULL · → `gst_states` (ON DELETE RESTRICT) |
| `pincode` | `pincode` | NOT NULL |
| `gstin` | `gstin` |  |
| `manager_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `capacity_units` | `INTEGER` |  |
| `supports_same_day` | `BOOLEAN` | NOT NULL · default false |
| `is_default` | `BOOLEAN` | NOT NULL · default false |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_warehouses_code`(code) WHERE deleted_at IS NULL
- UNIQUE `uq_warehouses_name`(name) WHERE deleted_at IS NULL
- UNIQUE `uq_one_default_warehouse`(is_default) WHERE is_default AND deleted_at IS NULL
- `idx_warehouses_state`(state_code) WHERE deleted_at IS NULL

</details>


### `inventory_levels`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE CASCADE) |
| `hamper_item_id` | `UUID` | → `hamper_items` (ON DELETE CASCADE) |
| `packaging_id` | `UUID` | → `packaging_materials` (ON DELETE CASCADE) |
| `warehouse_id` | `UUID` | NOT NULL · → `warehouses` (ON DELETE RESTRICT) |
| `on_hand_qty` | `INTEGER` | NOT NULL · default 0 |
| `reserved_qty` | `INTEGER` | NOT NULL · default 0 |
| `available_qty` | `INTEGER` | GENERATED |
| `incoming_qty` | `INTEGER` | NOT NULL · default 0 |
| `reorder_point` | `INTEGER` | NOT NULL · default 0 |
| `reorder_qty` | `INTEGER` | NOT NULL · default 0 |
| `bin_location` | `TEXT` |  |
| `last_movement_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT inventory_no_oversell CHECK (reserved_qty <= on_hand_qty)`
- `CONSTRAINT inventory_exactly_one_stockable CHECK ( (variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int + (packaging_id IS NOT NULL)::int = 1)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_inventory_variant_wh`(variant_id, warehouse_id) WHERE variant_id IS NOT NULL
- UNIQUE `uq_inventory_item_wh`(hamper_item_id, warehouse_id) WHERE hamper_item_id IS NOT NULL
- UNIQUE `uq_inventory_packaging_wh`(packaging_id, warehouse_id) WHERE packaging_id IS NOT NULL
- `idx_inventory_warehouse`(warehouse_id)
- `idx_inventory_low`(warehouse_id, available_qty) WHERE available_qty <= reorder_point

</details>


### `inventory_reservations`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `inventory_level_id` | `UUID` | NOT NULL · → `inventory_levels` (ON DELETE CASCADE) |
| `quantity` | `INTEGER` | NOT NULL |
| `cart_id` | `UUID` | → `carts` (ON DELETE CASCADE) |
| `order_id` | `UUID` | → `orders` (ON DELETE CASCADE) |
| `reason` | `TEXT` | NOT NULL · default 'cart' |
| `expires_at` | `TIMESTAMPTZ` |  |
| `released_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT reservation_has_owner CHECK ( cart_id IS NOT NULL OR order_id IS NOT NULL OR reason = 'manual_hold')`
- `CONSTRAINT reservation_cart_expires CHECK (reason <> 'cart' OR expires_at IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- `idx_reservations_expiry`(expires_at) WHERE released_at IS NULL AND expires_at IS NOT NULL
- `idx_reservations_level`(inventory_level_id) WHERE released_at IS NULL
- `idx_reservations_order`(order_id) WHERE order_id IS NOT NULL

</details>


### `stock_movements`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `inventory_level_id` | `UUID` | NOT NULL · → `inventory_levels` (ON DELETE RESTRICT) |
| `movement_type` | `TEXT` | NOT NULL |
| `quantity_delta` | `INTEGER` | NOT NULL |
| `balance_after` | `INTEGER` | NOT NULL |
| `reference_type` | `TEXT` |  |
| `reference_id` | `UUID` |  |
| `reference_label` | `TEXT` |  |
| `note` | `TEXT` |  |
| `actor_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `occurred_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_stock_movements_level`(inventory_level_id, occurred_at DESC)
- `idx_stock_movements_ref`(reference_type, reference_id)
- `idx_stock_movements_time`(occurred_at DESC)

</details>


### `suppliers`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `code` | `TEXT` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `contact_name` | `TEXT` |  |
| `email` | `CITEXT` |  |
| `mobile` | `mobile_in` |  |
| `line1` | `TEXT` |  |
| `city` | `TEXT` |  |
| `state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `pincode` | `pincode` |  |
| `gstin` | `gstin` |  |
| `pan` | `pan_in` |  |
| `category` | `TEXT` |  |
| `lead_time_days` | `INTEGER` |  |
| `payment_terms` | `TEXT` |  |
| `rating` | `NUMERIC(2,1)` |  |
| `outstanding_paise` | `money_paise` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_suppliers_code`(code) WHERE deleted_at IS NULL
- `idx_suppliers_status`(status) WHERE deleted_at IS NULL
- `idx_suppliers_search`USING gin ( (name || ' ' || coalesce(contact_name,'') || ' ' || coalesce(city,'') || ' ' || coalesce(gstin,'')) gin_trgm_ops)

</details>


### `purchase_orders`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `po_no` | `TEXT` | NOT NULL · UNIQUE |
| `supplier_id` | `UUID` | NOT NULL · → `suppliers` (ON DELETE RESTRICT) |
| `warehouse_id` | `UUID` | NOT NULL · → `warehouses` (ON DELETE RESTRICT) |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `currency` | `currency_code` | NOT NULL · default 'INR' |
| `subtotal_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `tax_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `total_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `expected_on` | `DATE` |  |
| `sent_at` | `TIMESTAMPTZ` |  |
| `closed_at` | `TIMESTAMPTZ` |  |
| `notes` | `TEXT` |  |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_po_supplier`(supplier_id, created_at DESC)
- `idx_po_status`(status, expected_on)
- `idx_po_warehouse`(warehouse_id)

</details>


### `purchase_order_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `purchase_order_id` | `UUID` | NOT NULL · → `purchase_orders` (ON DELETE CASCADE) |
| `hamper_item_id` | `UUID` | → `hamper_items` (ON DELETE RESTRICT) |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE RESTRICT) |
| `packaging_id` | `UUID` | → `packaging_materials` (ON DELETE RESTRICT) |
| `description` | `TEXT` | NOT NULL |
| `ordered_qty` | `INTEGER` | NOT NULL |
| `received_qty` | `INTEGER` | NOT NULL · default 0 |
| `unit_cost_paise` | `nonneg_paise` | NOT NULL |
| `gst_rate_bp` | `percent_bp` | NOT NULL · default 0 |
| `line_total_paise` | `nonneg_paise` | NOT NULL |
| `position` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Table constraints</summary>

- `CONSTRAINT po_line_exactly_one_item CHECK ( (hamper_item_id IS NOT NULL)::int + (variant_id IS NOT NULL)::int + (packaging_id IS NOT NULL)::int = 1)`
- `CONSTRAINT po_line_no_over_receipt CHECK (received_qty <= ordered_qty)`

</details>

<details><summary>Indexes</summary>

- `idx_po_lines_po`(purchase_order_id, position)

</details>


### `goods_receipts`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `grn_no` | `TEXT` | NOT NULL · UNIQUE |
| `purchase_order_id` | `UUID` | NOT NULL · → `purchase_orders` (ON DELETE RESTRICT) |
| `warehouse_id` | `UUID` | NOT NULL · → `warehouses` (ON DELETE RESTRICT) |
| `received_on` | `DATE` | NOT NULL · default CURRENT_DATE |
| `qc_status` | `TEXT` | NOT NULL · default 'passed' |
| `inspector_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `supplier_invoice_no` | `TEXT` |  |
| `notes` | `TEXT` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_grn_po`(purchase_order_id)

</details>


### `goods_receipt_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `goods_receipt_id` | `UUID` | NOT NULL · → `goods_receipts` (ON DELETE CASCADE) |
| `po_line_id` | `UUID` | NOT NULL · → `purchase_order_lines` (ON DELETE RESTRICT) |
| `accepted_qty` | `INTEGER` | NOT NULL · default 0 |
| `rejected_qty` | `INTEGER` | NOT NULL · default 0 |
| `rejection_reason` | `TEXT` |  |
| `batch_no` | `TEXT` |  |
| `expiry_on` | `DATE` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT grn_line_some_qty CHECK (accepted_qty + rejected_qty > 0)`
- `CONSTRAINT grn_rejection_needs_reason CHECK (rejected_qty = 0 OR rejection_reason IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- `idx_grn_lines_grn`(goods_receipt_id)
- `idx_grn_lines_expiry`(expiry_on) WHERE expiry_on IS NOT NULL

</details>


### `stock_transfers`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `transfer_no` | `TEXT` | NOT NULL · UNIQUE |
| `from_warehouse_id` | `UUID` | NOT NULL · → `warehouses` (ON DELETE RESTRICT) |
| `to_warehouse_id` | `UUID` | NOT NULL · → `warehouses` (ON DELETE RESTRICT) |
| `status` | `TEXT` | NOT NULL · default 'requested' |
| `dispatched_at` | `TIMESTAMPTZ` |  |
| `eta_on` | `DATE` |  |
| `received_at` | `TIMESTAMPTZ` |  |
| `requested_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT transfer_distinct_warehouses CHECK (from_warehouse_id <> to_warehouse_id)`

</details>

<details><summary>Indexes</summary>

- `idx_transfers_status`(status, eta_on)

</details>


### `stock_transfer_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `transfer_id` | `UUID` | NOT NULL · → `stock_transfers` (ON DELETE CASCADE) |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE RESTRICT) |
| `hamper_item_id` | `UUID` | → `hamper_items` (ON DELETE RESTRICT) |
| `sent_qty` | `INTEGER` | NOT NULL |
| `received_qty` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Table constraints</summary>

- `CONSTRAINT transfer_line_exactly_one CHECK ( (variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int = 1)`
- `CONSTRAINT transfer_line_no_over_receipt CHECK (received_qty <= sent_qty)`

</details>

<details><summary>Indexes</summary>

- `idx_transfer_lines_transfer`(transfer_id)

</details>


## Cart & orders

11 tables


### `carts`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `customer_id` | `UUID` | → `customers` (ON DELETE CASCADE) |
| `anon_token` | `TEXT` | UNIQUE |
| `currency` | `currency_code` | NOT NULL · default 'INR' |
| `coupon_code` | `TEXT` |  |
| `email` | `CITEXT` |  |
| `mobile` | `mobile_in` |  |
| `stage` | `TEXT` | NOT NULL · default 'cart' |
| `converted_order_id` | `UUID` |  |
| `abandoned_at` | `TIMESTAMPTZ` |  |
| `recovery_state` | `TEXT` | NOT NULL · default 'not_sent' |
| `recovery_sent_at` | `TIMESTAMPTZ` |  |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL · default now() + interval '30 days' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT cart_has_owner CHECK (customer_id IS NOT NULL OR anon_token IS NOT NULL)`
- `CONSTRAINT cart_converted_has_order CHECK (stage <> 'converted' OR converted_order_id IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- `idx_carts_customer`(customer_id) WHERE stage <> 'converted'
- `idx_carts_abandoned`(abandoned_at DESC) WHERE stage <> 'converted' AND abandoned_at IS NOT NULL
- `idx_carts_expiry`(expires_at) WHERE stage <> 'converted'

</details>


### `cart_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `cart_id` | `UUID` | NOT NULL · → `carts` (ON DELETE CASCADE) |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE CASCADE) |
| `builder_template_id` | `UUID` | → `builder_templates` (ON DELETE CASCADE) |
| `builder_config` | `JSONB` |  |
| `quantity` | `INTEGER` | NOT NULL |
| `unit_price_paise` | `nonneg_paise` | NOT NULL |
| `personalisation` | `JSONB` |  |
| `line_key` | `TEXT` | NOT NULL |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT cart_line_exactly_one_kind CHECK ( (variant_id IS NOT NULL)::int + (builder_template_id IS NOT NULL)::int = 1)`
- `CONSTRAINT cart_line_builder_has_config CHECK ( builder_template_id IS NULL OR builder_config IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_cart_line_key`(cart_id, line_key)
- `idx_cart_lines_cart`(cart_id)

</details>


### `cart_line_add_ons`

| Column | Type | Notes |
|---|---|---|
| `cart_line_id` | `UUID` | NOT NULL · → `cart_lines` (ON DELETE CASCADE) |
| `add_on_id` | `UUID` | NOT NULL · → `add_ons` (ON DELETE CASCADE) |
| `price_paise` | `nonneg_paise` | NOT NULL |
| `input_text` | `TEXT` |  |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (cart_line_id, add_on_id)`

</details>


### `orders`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `order_no` | `TEXT` | NOT NULL · UNIQUE |
| `customer_id` | `UUID` | → `customers` (ON DELETE RESTRICT) |
| `corporate_account_id` | `UUID` | → `corporate_accounts` (ON DELETE SET NULL) |
| `cart_id` | `UUID` | → `carts` (ON DELETE SET NULL) |
| `channel` | `TEXT` | NOT NULL · default 'website' |
| `currency` | `currency_code` | NOT NULL · default 'INR' |
| `buyer_name` | `TEXT` | NOT NULL |
| `buyer_email` | `CITEXT` |  |
| `buyer_mobile` | `mobile_in` |  |
| `recipient_name` | `TEXT` |  |
| `recipient_mobile` | `mobile_in` |  |
| `is_anonymous_gift` | `BOOLEAN` | NOT NULL · default false |
| `gift_message` | `TEXT` |  |
| `ship_line1` | `TEXT` | NOT NULL |
| `ship_line2` | `TEXT` |  |
| `ship_area` | `TEXT` |  |
| `ship_city` | `TEXT` | NOT NULL |
| `ship_state_code` | `CHAR(2)` | NOT NULL · → `gst_states` (ON DELETE RESTRICT) |
| `ship_pincode` | `pincode` | NOT NULL |
| `ship_country_code` | `CHAR(2)` | NOT NULL · default 'IN' |
| `bill_same_as_ship` | `BOOLEAN` | NOT NULL · default true |
| `bill_name` | `TEXT` |  |
| `bill_line1` | `TEXT` |  |
| `bill_city` | `TEXT` |  |
| `bill_state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `bill_pincode` | `pincode` |  |
| `bill_gstin` | `gstin` |  |
| `place_of_supply_state_code` | `CHAR(2)` | NOT NULL · → `gst_states` (ON DELETE RESTRICT) |
| `supplier_gstin` | `gstin` |  |
| `supplier_state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `is_interstate` | `BOOLEAN` | NOT NULL |
| `is_export` | `BOOLEAN` | NOT NULL · default false |
| `delivery_type` | `TEXT` | NOT NULL · default 'standard' |
| `requested_delivery_date` | `DATE` |  |
| `delivery_slot` | `TEXT` |  |
| `fulfilment_warehouse_id` | `UUID` | → `warehouses` (ON DELETE SET NULL) |
| `subtotal_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `coupon_discount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `auto_discount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `loyalty_discount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `shipping_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cod_fee_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `taxable_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `sgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `igst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cess_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `round_off_paise` | `money_paise` | NOT NULL · default 0 |
| `total_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `amount_paid_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `amount_refunded_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `coupon_code` | `TEXT` |  |
| `status` | `TEXT` | NOT NULL · default 'pending_payment' |
| `payment_status` | `TEXT` | NOT NULL · default 'pending' |
| `fulfilment_status` | `TEXT` | NOT NULL · default 'unfulfilled' |
| `priority` | `TEXT` | NOT NULL · default 'standard' |
| `tags` | `TEXT[]` | NOT NULL · default '{}' |
| `internal_notes` | `TEXT` |  |
| `placed_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `confirmed_at` | `TIMESTAMPTZ` |  |
| `shipped_at` | `TIMESTAMPTZ` |  |
| `delivered_at` | `TIMESTAMPTZ` |  |
| `cancelled_at` | `TIMESTAMPTZ` |  |
| `cancel_reason` | `TEXT` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |

<details><summary>Table constraints</summary>

- `CONSTRAINT order_tax_split_consistent CHECK ( (is_interstate AND cgst_paise = 0 AND sgst_paise = 0) OR (NOT is_interstate AND igst_paise = 0))`
- `CONSTRAINT order_cgst_equals_sgst CHECK (cgst_paise = sgst_paise)`
- `CONSTRAINT order_refund_not_over_paid CHECK (amount_refunded_paise <= amount_paid_paise)`
- `CONSTRAINT order_cancel_has_reason CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL)`
- `CONSTRAINT order_billing_complete CHECK ( bill_same_as_ship OR (bill_name IS NOT NULL AND bill_line1 IS NOT NULL AND bill_state_code IS NOT NULL))`

</details>

<details><summary>Indexes</summary>

- `idx_orders_customer`(customer_id, placed_at DESC)
- `idx_orders_status`(status, placed_at DESC)
- `idx_orders_payment`(payment_status, placed_at DESC)
- `idx_orders_placed`(placed_at DESC)
- `idx_orders_delivery`(requested_delivery_date) WHERE status NOT IN ('delivered','cancelled','refunded')
- `idx_orders_corporate`(corporate_account_id) WHERE corporate_account_id IS NOT NULL
- `idx_orders_warehouse`(fulfilment_warehouse_id, status)
- `idx_orders_channel`(channel, placed_at DESC)
- `idx_orders_tags`USING gin (tags)
- `idx_orders_priority`(priority, placed_at DESC) WHERE priority <> 'standard'
- `idx_orders_search_trgm`USING gin ( (order_no || ' ' || buyer_name || ' ' || coalesce(buyer_email::text,'') || ' ' || coalesce(buyer_mobile,'')) gin_trgm_ops)

</details>


### `order_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE CASCADE) |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE RESTRICT) |
| `builder_template_id` | `UUID` | → `builder_templates` (ON DELETE RESTRICT) |
| `builder_config` | `JSONB` |  |
| `sku_snapshot` | `TEXT` | NOT NULL |
| `title_snapshot` | `TEXT` | NOT NULL |
| `variant_label_snapshot` | `TEXT` |  |
| `image_url_snapshot` | `TEXT` |  |
| `hsn_snapshot` | `hsn` |  |
| `quantity` | `INTEGER` | NOT NULL |
| `unit_price_paise` | `nonneg_paise` | NOT NULL |
| `line_discount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `allocated_order_discount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `gross_paise` | `nonneg_paise` | NOT NULL |
| `gst_rate_bp` | `percent_bp` | NOT NULL · default 0 |
| `taxable_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `sgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `igst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cess_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `fulfilment_status` | `TEXT` | NOT NULL · default 'unfulfilled' |
| `fulfilled_qty` | `INTEGER` | NOT NULL · default 0 |
| `returned_qty` | `INTEGER` | NOT NULL · default 0 |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT order_line_exactly_one_kind CHECK ( (variant_id IS NOT NULL)::int + (builder_template_id IS NOT NULL)::int = 1)`
- `CONSTRAINT order_line_fulfil_bounds CHECK (fulfilled_qty <= quantity)`
- `CONSTRAINT order_line_return_bounds CHECK (returned_qty <= quantity)`
- `CONSTRAINT order_line_discount_bounds CHECK ( line_discount_paise + allocated_order_discount_paise <= unit_price_paise * quantity)`
- `CONSTRAINT order_line_tax_split CHECK ( (igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0))`

</details>

<details><summary>Indexes</summary>

- `idx_order_lines_order`(order_id, position)
- `idx_order_lines_variant_time`(variant_id, created_at DESC)

</details>


### `order_line_add_ons`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `order_line_id` | `UUID` | NOT NULL · → `order_lines` (ON DELETE CASCADE) |
| `add_on_id` | `UUID` | → `add_ons` (ON DELETE SET NULL) |
| `name_snapshot` | `TEXT` | NOT NULL |
| `price_paise` | `nonneg_paise` | NOT NULL |
| `quantity` | `INTEGER` | NOT NULL · default 1 |
| `input_text` | `TEXT` |  |
| `gst_rate_bp` | `percent_bp` | NOT NULL · default 0 |
| `hsn_snapshot` | `hsn` |  |

<details><summary>Indexes</summary>

- `idx_order_line_addons_line`(order_line_id)

</details>


### `order_line_personalisations`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `order_line_id` | `UUID` | NOT NULL · → `order_lines` (ON DELETE CASCADE) |
| `template_id` | `UUID` | → `personalisation_templates` (ON DELETE SET NULL) |
| `method` | `TEXT` | NOT NULL |
| `input_text` | `TEXT` |  |
| `input_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `proof_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `proof_status` | `TEXT` | NOT NULL · default 'not_required' |
| `approved_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_personalisation_queue`(proof_status) WHERE proof_status IN ('pending','sent')

</details>


### `order_timeline`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE CASCADE) |
| `occurred_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `event_type` | `TEXT` | NOT NULL |
| `label` | `TEXT` | NOT NULL |
| `note` | `TEXT` |  |
| `actor_kind` | `TEXT` | NOT NULL · default 'system' |
| `actor_staff_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `actor_label` | `TEXT` |  |
| `metadata` | `JSONB` |  |

<details><summary>Indexes</summary>

- `idx_order_timeline_order`(order_id, occurred_at)

</details>


### `returns`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `return_no` | `TEXT` | NOT NULL · UNIQUE |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `customer_id` | `UUID` | → `customers` (ON DELETE SET NULL) |
| `reason` | `TEXT` | NOT NULL |
| `reason_note` | `TEXT` |  |
| `status` | `TEXT` | NOT NULL · default 'requested' |
| `refund_mode` | `TEXT` | NOT NULL · default 'original' |
| `refund_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `restock` | `BOOLEAN` | NOT NULL · default true |
| `pickup_awb` | `TEXT` |  |
| `requested_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `resolved_at` | `TIMESTAMPTZ` |  |
| `approved_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_returns_order`(order_id)
- `idx_returns_status`(status, requested_at DESC)

</details>


### `return_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `return_id` | `UUID` | NOT NULL · → `returns` (ON DELETE CASCADE) |
| `order_line_id` | `UUID` | NOT NULL · → `order_lines` (ON DELETE RESTRICT) |
| `quantity` | `INTEGER` | NOT NULL |
| `refund_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `condition` | `TEXT` |  |

<details><summary>Table constraints</summary>

- `UNIQUE (return_id, order_line_id)`

</details>

<details><summary>Indexes</summary>

- `idx_return_lines_order_line`(order_line_id)

</details>


### `exchanges`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `exchange_no` | `TEXT` | NOT NULL · UNIQUE |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `order_line_id` | `UUID` | → `order_lines` (ON DELETE SET NULL) |
| `from_variant_id` | `UUID` | → `product_variants` (ON DELETE RESTRICT) |
| `to_variant_id` | `UUID` | → `product_variants` (ON DELETE RESTRICT) |
| `quantity` | `INTEGER` | NOT NULL · default 1 |
| `price_diff_paise` | `money_paise` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'requested' |
| `replacement_order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `requested_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `resolved_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT exchange_variants_differ CHECK (from_variant_id IS DISTINCT FROM to_variant_id)`

</details>

<details><summary>Indexes</summary>

- `idx_exchanges_order`(order_id)
- `idx_exchanges_status`(status, requested_at DESC)

</details>


## Payments & invoicing

9 tables


### `gift_cards`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `code_hash` | `TEXT` | NOT NULL · UNIQUE |
| `code_last4` | `CHAR(4)` | NOT NULL |
| `initial_value_paise` | `nonneg_paise` | NOT NULL |
| `balance_paise` | `nonneg_paise` | NOT NULL |
| `currency` | `currency_code` | NOT NULL · default 'INR' |
| `issued_to_name` | `TEXT` |  |
| `issued_to_email` | `CITEXT` |  |
| `issued_to_customer_id` | `UUID` | → `customers` (ON DELETE SET NULL) |
| `purchase_order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `issued_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `expires_on` | `DATE` |  |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT giftcard_balance_bounds CHECK (balance_paise <= initial_value_paise)`
- `CONSTRAINT giftcard_redeemed_is_zero CHECK (status <> 'redeemed' OR balance_paise = 0)`

</details>

<details><summary>Indexes</summary>

- `idx_gift_cards_status`(status, expires_on)
- `idx_gift_cards_customer`(issued_to_customer_id)

</details>


### `payments`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `gateway` | `TEXT` | NOT NULL |
| `method` | `TEXT` | NOT NULL |
| `gateway_payment_id` | `TEXT` |  |
| `gateway_order_id` | `TEXT` |  |
| `gateway_signature` | `TEXT` |  |
| `amount_paise` | `nonneg_paise` | NOT NULL |
| `fee_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `tax_on_fee_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `currency` | `currency_code` | NOT NULL · default 'INR' |
| `status` | `TEXT` | NOT NULL · default 'created' |
| `failure_code` | `TEXT` |  |
| `failure_reason` | `TEXT` |  |
| `is_settled` | `BOOLEAN` | NOT NULL · default false |
| `settled_at` | `TIMESTAMPTZ` |  |
| `settlement_ref` | `TEXT` |  |
| `authorised_at` | `TIMESTAMPTZ` |  |
| `captured_at` | `TIMESTAMPTZ` |  |
| `idempotency_key` | `TEXT` | UNIQUE |
| `gift_card_id` | `UUID` | → `gift_cards` (ON DELETE SET NULL) |
| `raw_payload` | `JSONB` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT payment_captured_has_time CHECK (status <> 'captured' OR captured_at IS NOT NULL)`
- `CONSTRAINT payment_failed_has_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL)`
- `CONSTRAINT payment_giftcard_link CHECK (method <> 'gift_card' OR gift_card_id IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_payments_gateway_id`(gateway, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL
- `idx_payments_order`(order_id, created_at DESC)
- `idx_payments_status`(status, created_at DESC)
- `idx_payments_settle`(is_settled, captured_at) WHERE status = 'captured'
- `idx_payments_gateway`(gateway, created_at DESC)

</details>


### `payment_events`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `gateway` | `TEXT` | NOT NULL |
| `gateway_event_id` | `TEXT` | NOT NULL |
| `event_type` | `TEXT` | NOT NULL |
| `payment_id` | `UUID` | → `payments` (ON DELETE SET NULL) |
| `order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `signature_valid` | `BOOLEAN` | NOT NULL · default false |
| `payload` | `JSONB` | NOT NULL |
| `processed_at` | `TIMESTAMPTZ` |  |
| `process_error` | `TEXT` |  |
| `received_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `UNIQUE (gateway, gateway_event_id)`

</details>

<details><summary>Indexes</summary>

- `idx_payment_events_unprocessed`(received_at) WHERE processed_at IS NULL

</details>


### `refunds`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `refund_no` | `TEXT` | NOT NULL · UNIQUE |
| `payment_id` | `UUID` | → `payments` (ON DELETE RESTRICT) |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `return_id` | `UUID` | → `returns` (ON DELETE SET NULL) |
| `amount_paise` | `nonneg_paise` | NOT NULL |
| `mode` | `TEXT` | NOT NULL · default 'original' |
| `gateway_refund_id` | `TEXT` |  |
| `status` | `TEXT` | NOT NULL · default 'initiated' |
| `reason` | `TEXT` | NOT NULL |
| `approved_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `initiated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `completed_at` | `TIMESTAMPTZ` |  |
| `idempotency_key` | `TEXT` | UNIQUE |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_refunds_order`(order_id)
- `idx_refunds_payment`(payment_id)
- `idx_refunds_status`(status, initiated_at DESC)

</details>


### `invoices`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `invoice_no` | `TEXT` | NOT NULL · UNIQUE |
| `series_id` | `UUID` | NOT NULL · → `document_number_series` (ON DELETE RESTRICT) |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `supplier_gstin` | `gstin` |  |
| `supplier_state_code` | `CHAR(2)` | NOT NULL · → `gst_states` (ON DELETE RESTRICT) |
| `buyer_name` | `TEXT` | NOT NULL |
| `buyer_gstin` | `gstin` |  |
| `buyer_address` | `TEXT` | NOT NULL |
| `place_of_supply_state_code` | `CHAR(2)` | NOT NULL · → `gst_states` (ON DELETE RESTRICT) |
| `is_reverse_charge` | `BOOLEAN` | NOT NULL · default false |
| `taxable_paise` | `nonneg_paise` | NOT NULL |
| `cgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `sgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `igst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cess_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `round_off_paise` | `money_paise` | NOT NULL · default 0 |
| `total_paise` | `nonneg_paise` | NOT NULL |
| `irn` | `TEXT` | UNIQUE |
| `irn_ack_no` | `TEXT` |  |
| `irn_ack_date` | `TIMESTAMPTZ` |  |
| `qr_payload` | `TEXT` |  |
| `eway_bill_no` | `TEXT` |  |
| `pdf_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `issued_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `financial_year` | `TEXT` | NOT NULL |
| `status` | `TEXT` | NOT NULL · default 'issued' |
| `cancelled_at` | `TIMESTAMPTZ` |  |
| `cancel_reason` | `TEXT` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT invoice_tax_split CHECK ( (igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0))`
- `CONSTRAINT invoice_cgst_equals_sgst CHECK (cgst_paise = sgst_paise)`
- `CONSTRAINT invoice_total_balances CHECK ( total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise + round_off_paise)`
- `CONSTRAINT invoice_cancel_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)`
- `CONSTRAINT invoice_no_max_16 CHECK (length(invoice_no) <= 16)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_invoice_per_order`(order_id) WHERE status = 'issued'
- `idx_invoices_issued`(issued_at DESC)
- `idx_invoices_fy`(financial_year, invoice_no)
- `idx_invoices_gstin`(buyer_gstin) WHERE buyer_gstin IS NOT NULL

</details>


### `invoice_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `invoice_id` | `UUID` | NOT NULL · → `invoices` (ON DELETE CASCADE) |
| `order_line_id` | `UUID` | → `order_lines` (ON DELETE SET NULL) |
| `description` | `TEXT` | NOT NULL |
| `hsn_code` | `hsn` | NOT NULL |
| `quantity` | `NUMERIC(12,3)` | NOT NULL |
| `unit` | `TEXT` | NOT NULL · default 'PCS' |
| `unit_price_paise` | `nonneg_paise` | NOT NULL |
| `discount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `taxable_paise` | `nonneg_paise` | NOT NULL |
| `gst_rate_bp` | `percent_bp` | NOT NULL |
| `cgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `sgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `igst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cess_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `line_total_paise` | `nonneg_paise` | NOT NULL |
| `position` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Indexes</summary>

- `idx_invoice_lines_invoice`(invoice_id, position)
- `idx_invoice_lines_hsn`(hsn_code)

</details>


### `credit_notes`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `credit_note_no` | `TEXT` | NOT NULL · UNIQUE |
| `series_id` | `UUID` | NOT NULL · → `document_number_series` (ON DELETE RESTRICT) |
| `invoice_id` | `UUID` | NOT NULL · → `invoices` (ON DELETE RESTRICT) |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `return_id` | `UUID` | → `returns` (ON DELETE SET NULL) |
| `reason` | `TEXT` | NOT NULL |
| `taxable_paise` | `nonneg_paise` | NOT NULL |
| `cgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `sgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `igst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cess_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `total_paise` | `nonneg_paise` | NOT NULL |
| `irn` | `TEXT` | UNIQUE |
| `financial_year` | `TEXT` | NOT NULL |
| `issued_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `issued_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `pdf_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT cn_tax_split CHECK ((igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0))`
- `CONSTRAINT cn_cgst_equals_sgst CHECK (cgst_paise = sgst_paise)`
- `CONSTRAINT cn_no_max_16 CHECK (length(credit_note_no) <= 16)`

</details>

<details><summary>Indexes</summary>

- `idx_credit_notes_invoice`(invoice_id)
- `idx_credit_notes_fy`(financial_year, credit_note_no)

</details>


### `credit_note_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `credit_note_id` | `UUID` | NOT NULL · → `credit_notes` (ON DELETE CASCADE) |
| `invoice_line_id` | `UUID` | → `invoice_lines` (ON DELETE SET NULL) |
| `description` | `TEXT` | NOT NULL |
| `hsn_code` | `hsn` | NOT NULL |
| `quantity` | `NUMERIC(12,3)` | NOT NULL |
| `taxable_paise` | `nonneg_paise` | NOT NULL |
| `gst_rate_bp` | `percent_bp` | NOT NULL |
| `cgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `sgst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `igst_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cess_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `position` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Indexes</summary>

- `idx_cn_lines_cn`(credit_note_id, position)

</details>


### `gift_card_transactions`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `gift_card_id` | `UUID` | NOT NULL · → `gift_cards` (ON DELETE RESTRICT) |
| `order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `payment_id` | `UUID` | → `payments` (ON DELETE SET NULL) |
| `delta_paise` | `money_paise` | NOT NULL |
| `balance_after` | `nonneg_paise` | NOT NULL |
| `kind` | `TEXT` | NOT NULL |
| `note` | `TEXT` |  |
| `actor_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `occurred_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_gc_txn_card`(gift_card_id, occurred_at DESC)
- UNIQUE `uq_gc_redeem_once_per_payment`(payment_id) WHERE payment_id IS NOT NULL AND kind = 'redeem'

</details>


## Corporate gifting

8 tables


### `corporate_accounts`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `account_no` | `TEXT` | NOT NULL · UNIQUE |
| `company_name` | `TEXT` | NOT NULL |
| `legal_name` | `TEXT` |  |
| `gstin` | `gstin` |  |
| `pan` | `pan_in` |  |
| `billing_line1` | `TEXT` |  |
| `billing_city` | `TEXT` |  |
| `billing_state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `billing_pincode` | `pincode` |  |
| `account_manager_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `credit_limit_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `outstanding_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `payment_terms` | `TEXT` | NOT NULL · default 'advance' |
| `discount_bp` | `percent_bp` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'prospect' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT corp_within_credit_limit CHECK ( status = 'credit_hold' OR outstanding_paise <= credit_limit_paise)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_corp_company_name`(company_name) WHERE deleted_at IS NULL
- `idx_corp_status`(status) WHERE deleted_at IS NULL
- `idx_corp_manager`(account_manager_id)
- `idx_corp_search`USING gin ( (company_name || ' ' || coalesce(gstin,'')) gin_trgm_ops)

</details>


### `corporate_leads`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `lead_no` | `TEXT` | NOT NULL · UNIQUE |
| `company_name` | `TEXT` | NOT NULL |
| `contact_name` | `TEXT` | NOT NULL |
| `email` | `CITEXT` | NOT NULL |
| `mobile` | `mobile_in` |  |
| `city` | `TEXT` |  |
| `state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `employee_count` | `INTEGER` |  |
| `quantity_needed` | `INTEGER` |  |
| `budget_paise` | `nonneg_paise` |  |
| `occasion` | `TEXT` |  |
| `brief` | `TEXT` |  |
| `source` | `TEXT` |  |
| `stage` | `TEXT` | NOT NULL · default 'new' |
| `lost_reason` | `TEXT` |  |
| `owner_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `account_id` | `UUID` | → `corporate_accounts` (ON DELETE SET NULL) |
| `next_follow_up_on` | `DATE` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT lead_lost_has_reason CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- `idx_leads_stage`(stage, created_at DESC) WHERE deleted_at IS NULL
- `idx_leads_owner`(owner_id, next_follow_up_on)
- `idx_leads_followup`(next_follow_up_on) WHERE stage NOT IN ('won','lost') AND deleted_at IS NULL
- `idx_leads_search`USING gin ( (company_name || ' ' || contact_name || ' ' || email::text) gin_trgm_ops)

</details>


### `corporate_account_contacts`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `account_id` | `UUID` | NOT NULL · → `corporate_accounts` (ON DELETE CASCADE) |
| `customer_id` | `UUID` | → `customers` (ON DELETE SET NULL) |
| `name` | `TEXT` | NOT NULL |
| `email` | `CITEXT` | NOT NULL |
| `mobile` | `mobile_in` |  |
| `designation` | `TEXT` |  |
| `is_primary` | `BOOLEAN` | NOT NULL · default false |
| `can_approve` | `BOOLEAN` | NOT NULL · default false |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- UNIQUE `uq_one_primary_contact`(account_id) WHERE is_primary
- `idx_corp_contacts_account`(account_id)

</details>


### `quotations`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `quotation_no` | `TEXT` | NOT NULL · UNIQUE |
| `account_id` | `UUID` | → `corporate_accounts` (ON DELETE SET NULL) |
| `lead_id` | `UUID` | → `corporate_leads` (ON DELETE SET NULL) |
| `company_name` | `TEXT` | NOT NULL |
| `currency` | `currency_code` | NOT NULL · default 'INR' |
| `subtotal_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `discount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `tax_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `total_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `margin_bp` | `percent_bp` |  |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `valid_till` | `DATE` |  |
| `owner_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `converted_order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `pdf_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `sent_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT quotation_lead_or_account CHECK (account_id IS NOT NULL OR lead_id IS NOT NULL)`
- `CONSTRAINT quotation_converted_has_order CHECK ( status <> 'converted' OR converted_order_id IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- `idx_quotations_status`(status, created_at DESC) WHERE deleted_at IS NULL
- `idx_quotations_account`(account_id)
- `idx_quotations_owner`(owner_id, valid_till)

</details>


### `quotation_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `quotation_id` | `UUID` | NOT NULL · → `quotations` (ON DELETE CASCADE) |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE SET NULL) |
| `builder_template_id` | `UUID` | → `builder_templates` (ON DELETE SET NULL) |
| `description` | `TEXT` | NOT NULL |
| `quantity` | `INTEGER` | NOT NULL |
| `unit_price_paise` | `nonneg_paise` | NOT NULL |
| `unit_cost_paise` | `nonneg_paise` |  |
| `discount_bp` | `percent_bp` | NOT NULL · default 0 |
| `gst_rate_bp` | `percent_bp` | NOT NULL · default 0 |
| `line_total_paise` | `nonneg_paise` | NOT NULL |
| `branding_note` | `TEXT` |  |
| `position` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Indexes</summary>

- `idx_quotation_lines_q`(quotation_id, position)

</details>


### `corporate_campaigns`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `campaign_no` | `TEXT` | NOT NULL · UNIQUE |
| `account_id` | `UUID` | NOT NULL · → `corporate_accounts` (ON DELETE RESTRICT) |
| `quotation_id` | `UUID` | → `quotations` (ON DELETE SET NULL) |
| `name` | `TEXT` | NOT NULL |
| `budget_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `window_start_on` | `DATE` |  |
| `window_end_on` | `DATE` |  |
| `status` | `TEXT` | NOT NULL · default 'planning' |
| `owner_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT campaign_window CHECK ( window_end_on IS NULL OR window_start_on IS NULL OR window_end_on >= window_start_on)`

</details>

<details><summary>Indexes</summary>

- `idx_campaigns_account`(account_id, status)

</details>


### `campaign_recipients`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `campaign_id` | `UUID` | NOT NULL · → `corporate_campaigns` (ON DELETE CASCADE) |
| `name` | `TEXT` | NOT NULL |
| `email` | `CITEXT` |  |
| `mobile` | `mobile_in` |  |
| `employee_code` | `TEXT` |  |
| `line1` | `TEXT` |  |
| `line2` | `TEXT` |  |
| `city` | `TEXT` |  |
| `state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `pincode` | `pincode` |  |
| `variant_id` | `UUID` | → `product_variants` (ON DELETE SET NULL) |
| `gift_message` | `TEXT` |  |
| `order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `status` | `TEXT` | NOT NULL · default 'uploaded' |
| `validation_error` | `TEXT` |  |
| `import_job_id` | `UUID` | → `import_jobs` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT campaign_recipient_invalid_has_error CHECK ( status <> 'invalid' OR validation_error IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- `idx_campaign_recipients`(campaign_id, status)
- `idx_campaign_recip_order`(order_id) WHERE order_id IS NOT NULL

</details>


### `approvals`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `approval_no` | `TEXT` | NOT NULL · UNIQUE |
| `kind` | `TEXT` | NOT NULL |
| `subject_table` | `TEXT` | NOT NULL |
| `subject_id` | `UUID` | NOT NULL |
| `subject_label` | `TEXT` |  |
| `amount_paise` | `money_paise` |  |
| `justification` | `TEXT` |  |
| `status` | `TEXT` | NOT NULL · default 'pending' |
| `requested_by` | `UUID` | NOT NULL · → `staff_users` (ON DELETE RESTRICT) |
| `requested_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `approver_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `decided_at` | `TIMESTAMPTZ` |  |
| `decision_note` | `TEXT` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT approval_decided_has_approver CHECK ( status IN ('pending','withdrawn') OR (approver_id IS NOT NULL AND decided_at IS NOT NULL))`
- `CONSTRAINT approval_not_self_approved CHECK (approver_id IS DISTINCT FROM requested_by)`

</details>

<details><summary>Indexes</summary>

- `idx_approvals_pending`(requested_at) WHERE status = 'pending'
- `idx_approvals_subject`(subject_table, subject_id)

</details>


## Delivery & fulfilment

10 tables


### `delivery_zones`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `code` | `TEXT` | NOT NULL · UNIQUE |
| `name` | `TEXT` | NOT NULL |
| `city` | `TEXT` |  |
| `state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `tier` | `TEXT` |  |
| `supports_same_day` | `BOOLEAN` | NOT NULL · default false |
| `supports_midnight` | `BOOLEAN` | NOT NULL · default false |
| `supports_cod` | `BOOLEAN` | NOT NULL · default true |
| `base_fee_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `same_day_cutoff` | `TIME` |  |
| `standard_tat_days` | `SMALLINT` |  |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_zones_status`(status, state_code)

</details>


### `delivery_zone_pincodes`

| Column | Type | Notes |
|---|---|---|
| `pincode` | `pincode` | PK |
| `zone_id` | `UUID` | NOT NULL · → `delivery_zones` (ON DELETE CASCADE) |
| `city` | `TEXT` |  |
| `state_code` | `CHAR(2)` | → `gst_states` (ON DELETE RESTRICT) |
| `is_serviceable` | `BOOLEAN` | NOT NULL · default true |
| `cod_allowed` | `BOOLEAN` | NOT NULL · default true |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_zone_pincodes_zone`(zone_id)

</details>


### `couriers`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `code` | `TEXT` | NOT NULL · UNIQUE |
| `name` | `TEXT` | NOT NULL · UNIQUE |
| `services` | `TEXT[]` | NOT NULL · default '{}' |
| `supports_cod` | `BOOLEAN` | NOT NULL · default true |
| `supports_international` | `BOOLEAN` | NOT NULL · default false |
| `tracking_url_template` | `TEXT` |  |
| `api_integration_id` | `UUID` | → `integrations` (ON DELETE SET NULL) |
| `base_cost_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'disconnected' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `courier_performance_daily`

| Column | Type | Notes |
|---|---|---|
| `courier_id` | `UUID` | NOT NULL · → `couriers` (ON DELETE CASCADE) |
| `day` | `DATE` | NOT NULL |
| `shipments` | `INTEGER` | NOT NULL · default 0 |
| `on_time` | `INTEGER` | NOT NULL · default 0 |
| `ndr_count` | `INTEGER` | NOT NULL · default 0 |
| `rto_count` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (courier_id, day)`

</details>


### `shipping_rules`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `name` | `TEXT` | NOT NULL |
| `priority` | `INTEGER` | NOT NULL |
| `conditions` | `JSONB` | NOT NULL |
| `condition_text` | `TEXT` |  |
| `charge_kind` | `TEXT` | NOT NULL |
| `charge_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `charge_bp` | `percent_bp` |  |
| `preferred_courier_id` | `UUID` | → `couriers` (ON DELETE SET NULL) |
| `stops_evaluation` | `BOOLEAN` | NOT NULL · default true |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- UNIQUE `uq_shipping_rule_priority`(priority) WHERE status = 'active'

</details>


### `shipments`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `shipment_no` | `TEXT` | NOT NULL · UNIQUE |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `warehouse_id` | `UUID` | NOT NULL · → `warehouses` (ON DELETE RESTRICT) |
| `courier_id` | `UUID` | → `couriers` (ON DELETE SET NULL) |
| `awb` | `TEXT` |  |
| `label_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `packaging_id` | `UUID` | → `packaging_materials` (ON DELETE SET NULL) |
| `weight_grams` | `INTEGER` |  |
| `declared_value_paise` | `nonneg_paise` |  |
| `shipping_cost_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `is_cod` | `BOOLEAN` | NOT NULL · default false |
| `cod_amount_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `cod_remitted_at` | `TIMESTAMPTZ` |  |
| `status` | `TEXT` | NOT NULL · default 'label_created' |
| `attempts` | `SMALLINT` | NOT NULL · default 0 |
| `dispatched_at` | `TIMESTAMPTZ` |  |
| `eta_on` | `DATE` |  |
| `delivered_at` | `TIMESTAMPTZ` |  |
| `delivered_to` | `TEXT` |  |
| `pod_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT shipment_cod_amount CHECK (is_cod OR cod_amount_paise = 0)`
- `CONSTRAINT shipment_delivered_has_time CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_shipments_awb`(courier_id, awb) WHERE awb IS NOT NULL
- `idx_shipments_order`(order_id)
- `idx_shipments_status`(status, dispatched_at DESC)
- `idx_shipments_awb`(awb) WHERE awb IS NOT NULL
- `idx_shipments_eta`(eta_on) WHERE status NOT IN ('delivered','cancelled','rto_delivered')

</details>


### `shipment_lines`

| Column | Type | Notes |
|---|---|---|
| `shipment_id` | `UUID` | NOT NULL · → `shipments` (ON DELETE CASCADE) |
| `order_line_id` | `UUID` | NOT NULL · → `order_lines` (ON DELETE RESTRICT) |
| `quantity` | `INTEGER` | NOT NULL |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (shipment_id, order_line_id)`

</details>


### `shipment_events`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `shipment_id` | `UUID` | NOT NULL · → `shipments` (ON DELETE CASCADE) |
| `occurred_at` | `TIMESTAMPTZ` | NOT NULL |
| `status` | `TEXT` | NOT NULL |
| `location` | `TEXT` |  |
| `description` | `TEXT` |  |
| `courier_code` | `TEXT` |  |
| `raw_payload` | `JSONB` |  |
| `received_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_shipment_events`(shipment_id, occurred_at DESC)

</details>


### `delivery_exceptions`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `exception_no` | `TEXT` | NOT NULL · UNIQUE |
| `shipment_id` | `UUID` | → `shipments` (ON DELETE CASCADE) |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE RESTRICT) |
| `kind` | `TEXT` | NOT NULL |
| `reason` | `TEXT` | NOT NULL |
| `status` | `TEXT` | NOT NULL · default 'open' |
| `owner_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `reattempt_on` | `DATE` |  |
| `raised_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `resolved_at` | `TIMESTAMPTZ` |  |
| `resolution_note` | `TEXT` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_exceptions_open`(raised_at) WHERE status NOT IN ('resolved','written_off')
- `idx_exceptions_order`(order_id)
- `idx_exceptions_owner`(owner_id, status)

</details>


### `packaging_materials`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `sku` | `TEXT` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `kind` | `TEXT` | NOT NULL |
| `length_mm` | `INTEGER` |  |
| `width_mm` | `INTEGER` |  |
| `height_mm` | `INTEGER` |  |
| `max_weight_grams` | `INTEGER` |  |
| `cost_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `supports_gift_note` | `BOOLEAN` | NOT NULL · default false |
| `supplier_id` | `UUID` | → `suppliers` (ON DELETE SET NULL) |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_packaging_sku`(sku) WHERE deleted_at IS NULL

</details>


## Promotions & loyalty

12 tables


### `coupons`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `code` | `TEXT` | NOT NULL |
| `description` | `TEXT` |  |
| `discount_type` | `TEXT` | NOT NULL |
| `discount_bp` | `percent_bp` |  |
| `discount_paise` | `nonneg_paise` |  |
| `max_discount_paise` | `nonneg_paise` |  |
| `min_order_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `bogo_buy_qty` | `SMALLINT` |  |
| `bogo_get_qty` | `SMALLINT` |  |
| `free_gift_variant_id` | `UUID` | → `product_variants` (ON DELETE SET NULL) |
| `applies_to` | `TEXT` | NOT NULL · default 'all' |
| `channels` | `TEXT[]` | NOT NULL · default '{}' |
| `max_redemptions` | `INTEGER` |  |
| `max_redemptions_per_customer` | `INTEGER` | NOT NULL · default 1 |
| `redemption_count` | `INTEGER` | NOT NULL · default 0 |
| `stackable` | `BOOLEAN` | NOT NULL · default false |
| `starts_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `ends_at` | `TIMESTAMPTZ` |  |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT coupon_within_limit CHECK ( max_redemptions IS NULL OR redemption_count <= max_redemptions)`
- `CONSTRAINT coupon_window CHECK (ends_at IS NULL OR ends_at > starts_at)`
- `CONSTRAINT coupon_percent_needs_bp CHECK (discount_type <> 'percent' OR discount_bp IS NOT NULL)`
- `CONSTRAINT coupon_flat_needs_paise CHECK (discount_type <> 'flat' OR discount_paise IS NOT NULL)`
- `CONSTRAINT coupon_bogo_needs_qty CHECK ( discount_type <> 'bogo' OR (bogo_buy_qty IS NOT NULL AND bogo_get_qty IS NOT NULL))`
- `CONSTRAINT coupon_gift_needs_variant CHECK ( discount_type <> 'free_gift' OR free_gift_variant_id IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_coupons_code`(code) WHERE deleted_at IS NULL
- `idx_coupons_status`(status, ends_at) WHERE deleted_at IS NULL
- `idx_coupons_active`(code) WHERE status = 'active' AND deleted_at IS NULL

</details>


### `coupon_scope`

| Column | Type | Notes |
|---|---|---|
| `coupon_id` | `UUID` | NOT NULL · → `coupons` (ON DELETE CASCADE) |
| `collection_id` | `UUID` | → `collections` (ON DELETE CASCADE) |
| `product_id` | `UUID` | → `products` (ON DELETE CASCADE) |
| `is_exclusion` | `BOOLEAN` | NOT NULL · default false |

<details><summary>Table constraints</summary>

- `CONSTRAINT coupon_scope_exactly_one CHECK ( (collection_id IS NOT NULL)::int + (product_id IS NOT NULL)::int = 1)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_coupon_scope_col`(coupon_id, collection_id) WHERE collection_id IS NOT NULL
- UNIQUE `uq_coupon_scope_prod`(coupon_id, product_id) WHERE product_id IS NOT NULL

</details>


### `coupon_redemptions`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `coupon_id` | `UUID` | NOT NULL · → `coupons` (ON DELETE RESTRICT) |
| `order_id` | `UUID` | NOT NULL · → `orders` (ON DELETE CASCADE) |
| `customer_id` | `UUID` | → `customers` (ON DELETE SET NULL) |
| `discount_paise` | `nonneg_paise` | NOT NULL |
| `redeemed_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `reversed_at` | `TIMESTAMPTZ` |  |
| `reversal_reason` | `TEXT` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_coupon_once_per_order`(coupon_id, order_id)
- `idx_coupon_redemptions_customer`(coupon_id, customer_id) WHERE reversed_at IS NULL

</details>


### `auto_discounts`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `name` | `TEXT` | NOT NULL |
| `rule` | `JSONB` | NOT NULL |
| `rule_text` | `TEXT` |  |
| `discount_type` | `TEXT` | NOT NULL |
| `discount_bp` | `percent_bp` |  |
| `discount_paise` | `nonneg_paise` |  |
| `priority` | `INTEGER` | NOT NULL · default 100 |
| `stackable` | `BOOLEAN` | NOT NULL · default false |
| `starts_at` | `TIMESTAMPTZ` |  |
| `ends_at` | `TIMESTAMPTZ` |  |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- `idx_auto_discounts_active`(priority) WHERE status = 'active' AND deleted_at IS NULL

</details>


### `bundles`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `handle` | `handle` | NOT NULL |
| `name` | `TEXT` | NOT NULL |
| `bundle_price_paise` | `nonneg_paise` | NOT NULL |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `starts_at` | `TIMESTAMPTZ` |  |
| `ends_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_bundles_handle`(handle) WHERE deleted_at IS NULL

</details>


### `bundle_items`

| Column | Type | Notes |
|---|---|---|
| `bundle_id` | `UUID` | NOT NULL · → `bundles` (ON DELETE CASCADE) |
| `variant_id` | `UUID` | NOT NULL · → `product_variants` (ON DELETE RESTRICT) |
| `quantity` | `INTEGER` | NOT NULL · default 1 |
| `position` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (bundle_id, variant_id)`

</details>


### `upsell_rules`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `name` | `TEXT` | NOT NULL |
| `trigger` | `JSONB` | NOT NULL |
| `trigger_text` | `TEXT` |  |
| `offer_kind` | `TEXT` | NOT NULL |
| `offer_add_on_id` | `UUID` | → `add_ons` (ON DELETE CASCADE) |
| `offer_variant_id` | `UUID` | → `product_variants` (ON DELETE CASCADE) |
| `offer_price_paise` | `nonneg_paise` |  |
| `offer_discount_bp` | `percent_bp` |  |
| `placement` | `TEXT` | NOT NULL |
| `priority` | `INTEGER` | NOT NULL · default 100 |
| `status` | `TEXT` | NOT NULL · default 'paused' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_upsell_placement`(placement, priority) WHERE status = 'active'

</details>


### `loyalty_tiers`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `name` | `TEXT` | NOT NULL · UNIQUE |
| `rank` | `SMALLINT` | NOT NULL · UNIQUE |
| `threshold_paise` | `nonneg_paise` | NOT NULL |
| `points_per_100_paise` | `NUMERIC(6,3)` | NOT NULL · default 1 |
| `perks` | `TEXT` |  |
| `is_invite_only` | `BOOLEAN` | NOT NULL · default false |
| `free_same_day` | `BOOLEAN` | NOT NULL · default false |
| `free_gift_wrap` | `BOOLEAN` | NOT NULL · default false |
| `discount_bp` | `percent_bp` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `loyalty_accounts`

| Column | Type | Notes |
|---|---|---|
| `customer_id` | `UUID` | PK · → `customers` (ON DELETE CASCADE) |
| `tier_id` | `UUID` | → `loyalty_tiers` (ON DELETE SET NULL) |
| `points_balance` | `INTEGER` | NOT NULL · default 0 |
| `points_lifetime` | `INTEGER` | NOT NULL · default 0 |
| `tier_since` | `DATE` |  |
| `tier_expires_on` | `DATE` |  |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_loyalty_tier`(tier_id)

</details>


### `loyalty_transactions`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `customer_id` | `UUID` | NOT NULL · → `customers` (ON DELETE CASCADE) |
| `order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `points_delta` | `INTEGER` | NOT NULL |
| `balance_after` | `INTEGER` | NOT NULL |
| `kind` | `TEXT` | NOT NULL |
| `note` | `TEXT` |  |
| `expires_on` | `DATE` |  |
| `occurred_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_loyalty_txn_customer`(customer_id, occurred_at DESC)
- UNIQUE `uq_loyalty_earn_per_order`(order_id) WHERE order_id IS NOT NULL AND kind = 'earn'

</details>


### `referrals`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `referrer_customer_id` | `UUID` | NOT NULL · → `customers` (ON DELETE CASCADE) |
| `code` | `TEXT` | NOT NULL · UNIQUE |
| `reward_kind` | `TEXT` | NOT NULL · default 'points' |
| `reward_value` | `INTEGER` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'active' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `referral_conversions`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `referral_id` | `UUID` | NOT NULL · → `referrals` (ON DELETE CASCADE) |
| `invited_email` | `CITEXT` |  |
| `invited_customer_id` | `UUID` | → `customers` (ON DELETE SET NULL) |
| `first_order_id` | `UUID` | → `orders` (ON DELETE SET NULL) |
| `status` | `TEXT` | NOT NULL · default 'invited' |
| `reward_issued_paise` | `nonneg_paise` | NOT NULL · default 0 |
| `invited_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `converted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_referral_invitee`(invited_customer_id) WHERE invited_customer_id IS NOT NULL
- `idx_referral_conv`(referral_id, status)

</details>


## Content & CMS

12 tables


### `media_assets`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `storage_key` | `TEXT` | NOT NULL |
| `url` | `TEXT` | NOT NULL |
| `cdn_url` | `TEXT` |  |
| `filename` | `TEXT` | NOT NULL |
| `mime_type` | `TEXT` | NOT NULL |
| `kind` | `TEXT` | NOT NULL |
| `bytes` | `BIGINT` | NOT NULL |
| `width_px` | `INTEGER` |  |
| `height_px` | `INTEGER` |  |
| `duration_ms` | `INTEGER` |  |
| `blurhash` | `TEXT` |  |
| `alt_text` | `TEXT` |  |
| `folder` | `TEXT` |  |
| `checksum_sha256` | `TEXT` |  |
| `uploaded_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_media_storage_key`(storage_key) WHERE deleted_at IS NULL
- `idx_media_kind`(kind, created_at DESC) WHERE deleted_at IS NULL
- `idx_media_folder`(folder) WHERE deleted_at IS NULL
- UNIQUE `uq_media_checksum`(checksum_sha256) WHERE checksum_sha256 IS NOT NULL AND deleted_at IS NULL

</details>


### `cms_sections`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `key` | `handle` | NOT NULL · UNIQUE |
| `page_key` | `TEXT` | NOT NULL · default 'home' |
| `title` | `TEXT` | NOT NULL |
| `layout` | `TEXT` | NOT NULL · default 'grid_4' |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `is_visible` | `BOOLEAN` | NOT NULL · default true |
| `settings` | `JSONB` | NOT NULL · default '{}' |
| `updated_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_cms_sections_page`(page_key, position) WHERE is_visible

</details>


### `cms_section_items`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `section_id` | `UUID` | NOT NULL · → `cms_sections` (ON DELETE CASCADE) |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `label` | `TEXT` |  |
| `sublabel` | `TEXT` |  |
| `media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `link_url` | `TEXT` |  |
| `collection_id` | `UUID` | → `collections` (ON DELETE CASCADE) |
| `product_id` | `UUID` | → `products` (ON DELETE CASCADE) |
| `is_visible` | `BOOLEAN` | NOT NULL · default true |

<details><summary>Indexes</summary>

- `idx_cms_items_section`(section_id, position)

</details>


### `banners`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `title` | `TEXT` | NOT NULL |
| `subtitle` | `TEXT` |  |
| `placement` | `TEXT` | NOT NULL |
| `device` | `TEXT` | NOT NULL · default 'all' |
| `media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `mobile_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `link_url` | `TEXT` |  |
| `collection_id` | `UUID` | → `collections` (ON DELETE SET NULL) |
| `cta_label` | `TEXT` |  |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `starts_at` | `TIMESTAMPTZ` |  |
| `ends_at` | `TIMESTAMPTZ` |  |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT banner_window CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)`

</details>

<details><summary>Indexes</summary>

- `idx_banners_live`(placement, position) WHERE status = 'live'

</details>


### `banner_stats_daily`

| Column | Type | Notes |
|---|---|---|
| `banner_id` | `UUID` | NOT NULL · → `banners` (ON DELETE CASCADE) |
| `day` | `DATE` | NOT NULL |
| `impressions` | `INTEGER` | NOT NULL · default 0 |
| `clicks` | `INTEGER` | NOT NULL · default 0 |

<details><summary>Table constraints</summary>

- `PRIMARY KEY (banner_id, day)`

</details>


### `content_pages`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `slug` | `handle` | NOT NULL |
| `kind` | `TEXT` | NOT NULL |
| `title` | `TEXT` | NOT NULL |
| `heading` | `TEXT` |  |
| `body_blocks` | `JSONB` | NOT NULL · default '[]' |
| `collection_id` | `UUID` | → `collections` (ON DELETE SET NULL) |
| `hero_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `published_at` | `TIMESTAMPTZ` |  |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `updated_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- UNIQUE `uq_content_pages_slug`(slug) WHERE deleted_at IS NULL
- `idx_content_pages_kind`(kind, status)

</details>


### `seo_entries`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `entity_type` | `TEXT` | NOT NULL |
| `entity_id` | `UUID` |  |
| `route_path` | `TEXT` |  |
| `meta_title` | `TEXT` |  |
| `meta_description` | `TEXT` |  |
| `canonical_url` | `TEXT` |  |
| `og_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `focus_keyword` | `TEXT` |  |
| `robots_index` | `BOOLEAN` | NOT NULL · default true |
| `robots_follow` | `BOOLEAN` | NOT NULL · default true |
| `structured_data` | `JSONB` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT seo_target CHECK ( (entity_type = 'route' AND route_path IS NOT NULL AND entity_id IS NULL) OR (entity_type <> 'route' AND entity_id IS NOT NULL))`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_seo_entity`(entity_type, entity_id) WHERE entity_id IS NOT NULL
- UNIQUE `uq_seo_route`(route_path) WHERE route_path IS NOT NULL

</details>


### `blog_posts`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `slug` | `handle` | NOT NULL |
| `title` | `TEXT` | NOT NULL |
| `excerpt` | `TEXT` |  |
| `body_blocks` | `JSONB` | NOT NULL · default '[]' |
| `category` | `TEXT` |  |
| `author_staff_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `author_name` | `TEXT` |  |
| `hero_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `read_minutes` | `SMALLINT` |  |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `published_at` | `TIMESTAMPTZ` |  |
| `view_count` | `INTEGER` | NOT NULL · default 0 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Table constraints</summary>

- `CONSTRAINT blog_published_has_date CHECK (status <> 'published' OR published_at IS NOT NULL)`
- `CONSTRAINT blog_has_author CHECK (author_staff_id IS NOT NULL OR author_name IS NOT NULL)`

</details>

<details><summary>Indexes</summary>

- UNIQUE `uq_blog_posts_slug`(slug) WHERE deleted_at IS NULL
- `idx_blog_published`(published_at DESC) WHERE status = 'published' AND deleted_at IS NULL
- `idx_blog_category`(category, published_at DESC)

</details>


### `faqs`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `question` | `TEXT` | NOT NULL |
| `answer` | `TEXT` | NOT NULL |
| `category` | `TEXT` |  |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `helpful_count` | `INTEGER` | NOT NULL · default 0 |
| `unhelpful_count` | `INTEGER` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'draft' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `deleted_at` | `TIMESTAMPTZ` |  |

<details><summary>Indexes</summary>

- `idx_faqs_category`(category, position) WHERE status = 'published'

</details>


### `testimonials`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `author_name` | `TEXT` | NOT NULL |
| `author_city` | `TEXT` |  |
| `company` | `TEXT` |  |
| `designation` | `TEXT` |  |
| `quote` | `TEXT` | NOT NULL |
| `rating` | `SMALLINT` |  |
| `media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `is_featured` | `BOOLEAN` | NOT NULL · default false |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'pending' |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_testimonials_pub`(position) WHERE status = 'published'

</details>


### `menus`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `key` | `handle` | NOT NULL · UNIQUE |
| `name` | `TEXT` | NOT NULL |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |


### `menu_items`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `menu_id` | `UUID` | NOT NULL · → `menus` (ON DELETE CASCADE) |
| `parent_id` | `UUID` | → `menu_items` (ON DELETE CASCADE) |
| `label` | `TEXT` | NOT NULL |
| `url` | `TEXT` |  |
| `collection_id` | `UUID` | → `collections` (ON DELETE CASCADE) |
| `content_page_id` | `UUID` | → `content_pages` (ON DELETE CASCADE) |
| `media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `position` | `INTEGER` | NOT NULL · default 0 |
| `is_visible` | `BOOLEAN` | NOT NULL · default true |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT menu_item_no_self_parent CHECK (parent_id IS DISTINCT FROM id)`
- `CONSTRAINT menu_item_has_target CHECK ( url IS NOT NULL OR collection_id IS NOT NULL OR content_page_id IS NOT NULL OR parent_id IS NULL)`

</details>

<details><summary>Indexes</summary>

- `idx_menu_items`(menu_id, parent_id, position) WHERE is_visible

</details>


## Platform

8 tables


### `activity_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `occurred_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `actor_kind` | `TEXT` | NOT NULL · default 'staff' |
| `actor_staff_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `actor_customer_id` | `UUID` | → `customers` (ON DELETE SET NULL) |
| `actor_api_key_id` | `UUID` | → `api_keys` (ON DELETE SET NULL) |
| `actor_label` | `TEXT` | NOT NULL |
| `actor_role` | `TEXT` |  |
| `action` | `TEXT` | NOT NULL |
| `entity_type` | `TEXT` | NOT NULL |
| `entity_id` | `UUID` |  |
| `entity_label` | `TEXT` |  |
| `before_data` | `JSONB` |  |
| `after_data` | `JSONB` |  |
| `changed_fields` | `TEXT[]` |  |
| `ip` | `INET` |  |
| `user_agent` | `TEXT` |  |
| `request_id` | `TEXT` |  |

<details><summary>Indexes</summary>

- `idx_activity_time`(occurred_at DESC)
- `idx_activity_entity`(entity_type, entity_id, occurred_at DESC)
- `idx_activity_actor`(actor_staff_id, occurred_at DESC)
- `idx_activity_action`(action, occurred_at DESC)

</details>


### `notifications`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `audience` | `TEXT` | NOT NULL · default 'staff' |
| `staff_user_id` | `UUID` | → `staff_users` (ON DELETE CASCADE) |
| `customer_id` | `UUID` | → `customers` (ON DELETE CASCADE) |
| `kind` | `TEXT` | NOT NULL |
| `priority` | `TEXT` | NOT NULL · default 'normal' |
| `title` | `TEXT` | NOT NULL |
| `body` | `TEXT` |  |
| `link_url` | `TEXT` |  |
| `entity_type` | `TEXT` |  |
| `entity_id` | `UUID` |  |
| `read_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT notification_target CHECK ( (audience = 'staff' AND customer_id IS NULL) OR (audience = 'customer' AND customer_id IS NOT NULL AND staff_user_id IS NULL))`

</details>

<details><summary>Indexes</summary>

- `idx_notifications_staff`(staff_user_id, created_at DESC) WHERE read_at IS NULL
- `idx_notifications_cust`(customer_id, created_at DESC)

</details>


### `integrations`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `key` | `handle` | NOT NULL · UNIQUE |
| `name` | `TEXT` | NOT NULL |
| `category` | `TEXT` | NOT NULL |
| `config` | `JSONB` | NOT NULL · default '{}' |
| `credentials_ref` | `TEXT` |  |
| `status` | `TEXT` | NOT NULL · default 'not_connected' |
| `last_error` | `TEXT` |  |
| `last_sync_at` | `TIMESTAMPTZ` |  |
| `event_count` | `BIGINT` | NOT NULL · default 0 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT integration_error_has_message CHECK (status <> 'error' OR last_error IS NOT NULL)`

</details>


### `webhooks`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `endpoint_url` | `TEXT` | NOT NULL |
| `description` | `TEXT` |  |
| `events` | `TEXT[]` | NOT NULL |
| `secret_hash` | `TEXT` | NOT NULL |
| `status` | `TEXT` | NOT NULL · default 'healthy' |
| `consecutive_failures` | `INTEGER` | NOT NULL · default 0 |
| `last_delivery_at` | `TIMESTAMPTZ` |  |
| `created_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_webhooks_events`USING gin (events)

</details>


### `webhook_deliveries`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `webhook_id` | `UUID` | NOT NULL · → `webhooks` (ON DELETE CASCADE) |
| `event_type` | `TEXT` | NOT NULL |
| `event_id` | `UUID` | NOT NULL |
| `payload` | `JSONB` | NOT NULL |
| `attempt` | `SMALLINT` | NOT NULL · default 1 |
| `response_status` | `SMALLINT` |  |
| `response_body` | `TEXT` |  |
| `duration_ms` | `INTEGER` |  |
| `succeeded` | `BOOLEAN` | NOT NULL · default false |
| `next_retry_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Indexes</summary>

- `idx_webhook_deliveries`(webhook_id, created_at DESC)
- `idx_webhook_retry`(next_retry_at) WHERE NOT succeeded AND next_retry_at IS NOT NULL

</details>


### `import_jobs`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | PK · default gen_random_uuid() |
| `entity` | `TEXT` | NOT NULL |
| `mode` | `TEXT` | NOT NULL · default 'upsert' |
| `source_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `filename` | `TEXT` | NOT NULL |
| `total_rows` | `INTEGER` | NOT NULL · default 0 |
| `succeeded_rows` | `INTEGER` | NOT NULL · default 0 |
| `failed_rows` | `INTEGER` | NOT NULL · default 0 |
| `status` | `TEXT` | NOT NULL · default 'queued' |
| `error_report_media_id` | `UUID` | → `media_assets` (ON DELETE SET NULL) |
| `actor_id` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `started_at` | `TIMESTAMPTZ` |  |
| `finished_at` | `TIMESTAMPTZ` |  |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · default now() |

<details><summary>Table constraints</summary>

- `CONSTRAINT import_row_math CHECK (succeeded_rows + failed_rows <= total_rows)`

</details>

<details><summary>Indexes</summary>

- `idx_import_jobs`(status, created_at DESC)

</details>


### `import_job_errors`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT` | PK · GENERATED |
| `import_job_id` | `UUID` | NOT NULL · → `import_jobs` (ON DELETE CASCADE) |
| `row_number` | `INTEGER` | NOT NULL |
| `column_name` | `TEXT` |  |
| `raw_value` | `TEXT` |  |
| `message` | `TEXT` | NOT NULL |

<details><summary>Indexes</summary>

- `idx_import_errors`(import_job_id, row_number)

</details>


### `app_settings`

| Column | Type | Notes |
|---|---|---|
| `key` | `TEXT` | PK |
| `value` | `JSONB` | NOT NULL |
| `description` | `TEXT` |  |
| `is_public` | `BOOLEAN` | NOT NULL · default false |
| `updated_by` | `UUID` | → `staff_users` (ON DELETE SET NULL) |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · default now() |
