-- Same-site pages a captured link points to that look worth adding
-- (fees, dates, registration...), as [{url, text}].
alter table public.documents add column suggested_links jsonb;
