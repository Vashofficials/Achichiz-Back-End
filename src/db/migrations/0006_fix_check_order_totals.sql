-- Migration 0006: Fix check_order_totals() trigger function to safely extract target order ID
-- from either 'orders' (id) or 'order_lines' (order_id), supporting INSERT, UPDATE, and DELETE.

CREATE OR REPLACE FUNCTION check_order_totals() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
  o RECORD;
  s RECORD;
  target_id UUID;
  row_data JSONB;
BEGIN
  row_data := to_jsonb(COALESCE(NEW, OLD));
  IF row_data ? 'order_id' THEN
    target_id := (row_data->>'order_id')::uuid;
  ELSE
    target_id := (row_data->>'id')::uuid;
  END IF;

  SELECT * INTO o FROM orders WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- order deleted in this txn

  SELECT coalesce(sum(gross_paise),0)                    AS gross,
         coalesce(sum(allocated_order_discount_paise),0) AS alloc,
         coalesce(sum(taxable_paise),0)                  AS taxable,
         coalesce(sum(cgst_paise),0)                     AS cgst,
         coalesce(sum(sgst_paise),0)                     AS sgst,
         coalesce(sum(igst_paise),0)                     AS igst,
         coalesce(sum(cess_paise),0)                     AS cess
    INTO s
    FROM order_lines
   WHERE order_id = o.id AND fulfilment_status <> 'cancelled';

  IF o.subtotal_paise <> s.gross THEN
    RAISE EXCEPTION 'order % subtotal %, lines sum to % (I1)',
      o.order_no, o.subtotal_paise, s.gross;
  END IF;

  IF o.coupon_discount_paise + o.auto_discount_paise
     + o.loyalty_discount_paise <> s.alloc THEN
    RAISE EXCEPTION 'order % header discounts % <> allocated % (I2)',
      o.order_no,
      o.coupon_discount_paise + o.auto_discount_paise + o.loyalty_discount_paise,
      s.alloc;
  END IF;

  IF o.total_paise <> o.subtotal_paise + o.shipping_paise
                      + o.cod_fee_paise + o.round_off_paise THEN
    RAISE EXCEPTION 'order % total % does not reconcile (I3)',
      o.order_no, o.total_paise;
  END IF;

  IF o.taxable_paise + o.cgst_paise + o.sgst_paise + o.igst_paise + o.cess_paise
     <> s.taxable + s.cgst + s.sgst + s.igst + s.cess THEN
    RAISE EXCEPTION 'order % tax rollup does not match lines (I4)', o.order_no;
  END IF;

  RETURN NULL;
END $fn$;
