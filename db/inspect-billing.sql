-- Read-only ledger snapshot for Neon SQL Editor. References match the billing runtime logs.
SELECT current_database() AS database_name, current_schema() AS schema_name,
       jsonb_build_object(
  'billing_wallets', jsonb_build_object(
    'rows', (SELECT count(*) FROM billing_wallets),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
      SELECT left(encode(sha256(convert_to(id::text, 'UTF8')), 'hex'), 12) AS wallet_ref,
             free_used, paid_balance, used_analyses, purchased_credits, updated_at
      FROM billing_wallets ORDER BY updated_at DESC LIMIT 20
    ) r), '[]'::jsonb)
  ),
  'billing_reservations', jsonb_build_object(
    'rows', (SELECT count(*) FROM billing_reservations),
    'active', (SELECT count(*) FROM billing_reservations WHERE expires_at > now()),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
      SELECT left(encode(sha256(convert_to(wallet_id::text, 'UTF8')), 'hex'), 12) AS wallet_ref,
             left(encode(sha256(convert_to(id::text, 'UTF8')), 'hex'), 12) AS reservation_ref,
             CASE WHEN network_id IS NULL THEN 'paid' ELSE 'free' END AS source, expires_at
      FROM billing_reservations ORDER BY expires_at DESC LIMIT 20
    ) r), '[]'::jsonb)
  ),
  'billing_daily', jsonb_build_object(
    'rows', (SELECT count(*) FROM billing_daily),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
      SELECT day, attempts, free_attempts FROM billing_daily ORDER BY day DESC LIMIT 14
    ) r), '[]'::jsonb)
  ),
  'billing_purchases', jsonb_build_object(
    'rows', (SELECT count(*) FROM billing_purchases),
    'credited', (SELECT count(*) FROM billing_purchases WHERE credited_at IS NOT NULL),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
      SELECT left(encode(sha256(convert_to(wallet_id::text, 'UTF8')), 'hex'), 12) AS wallet_ref,
             pack_id, credits, credited_at
      FROM billing_purchases ORDER BY credited_at DESC NULLS LAST, session_id DESC LIMIT 20
    ) r), '[]'::jsonb)
  ),
  'billing_networks', jsonb_build_object(
    'rows', (SELECT count(*) FROM billing_networks),
    'sample', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
      SELECT left(encode(sha256(convert_to(id, 'UTF8')), 'hex'), 12) AS network_ref, free_used
      FROM billing_networks ORDER BY free_used DESC, id LIMIT 20
    ) r), '[]'::jsonb)
  )
) AS billing_audit;
