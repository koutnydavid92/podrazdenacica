-- ============================================================
-- Připomínky opuštěných košíků: spouštění každých 15 minut z databáze
-- (Supabase pg_cron + pg_net). Vercel Hobby umí vlastní cron jen jednou
-- denně, proto volá endpoint databáze. Spustit JEDNOU v Supabase SQL
-- editoru (Database -> SQL Editor) jako postgres. Opakované spuštění
-- nevadí: cron.schedule se stejným jménem úlohu jen přepíše.
--
-- Endpoint přijme volání s hlavičkou User-Agent začínající "vercel-cron"
-- (stejně jako skutečný cron Vercelu) nebo s hlavičkou x-cron-secret,
-- když je na Vercelu nastaveno CRON_SECRET. Běh navíc nic nerozbije:
-- každý košík dostane každou připomínku nejvýš jednou (api/_shop_carts.js).
-- ============================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
    'shop-cart-reminders',
    '*/15 * * * *',
    $$
    select net.http_post(
        url := 'https://www.podrazdenacica.cz/api/program-mail-followup?job=cart-reminders',
        headers := '{"Content-Type": "application/json", "User-Agent": "vercel-cron/1.0 (supabase pg_cron)"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
    )
    $$
);

-- Kontrola: naplánované úlohy a poslední běhy
-- select jobid, jobname, schedule, active from cron.job;
-- select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
-- select status_code, left(content, 200) from net._http_response order by id desc limit 5;
