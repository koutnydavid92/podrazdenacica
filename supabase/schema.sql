-- ============================================================
-- Číča Art Fest - schéma databáze (Supabase)
-- Bezpečnostní model: tabulky jsou pro anonymní klienty zamčené
-- (RLS bez policies). Web s nimi mluví výhradně přes RPC funkce
-- níže (SECURITY DEFINER), které pustí ven jen to, co je potřeba.
-- ============================================================

-- VIP pozvánky: jeden řádek = jeden člověk = jeden unikátní kód
create table if not exists vip_invites (
    id uuid primary key default gen_random_uuid(),
    code text unique not null,
    greeting_name text not null,          -- oslovení v 5. pádě: "Katko"
    full_name text not null,
    email text,
    status text not null default 'invited'
        check (status in ('invited', 'confirmed', 'declined')),
    responded_at timestamptz,
    created_at timestamptz not null default now()
);

-- Vstupenky: VIP (ze schválené pozvánky) i veřejné (ze Stripe)
create table if not exists tickets (
    id uuid primary key default gen_random_uuid(),
    type text not null check (type in ('vip', 'public')),
    invite_id uuid references vip_invites(id),
    name text,
    email text,
    qr_token uuid unique not null default gen_random_uuid(),
    status text not null default 'valid'
        check (status in ('valid', 'checked_in', 'cancelled')),
    stripe_session_id text,
    ticket_no int not null default 1,
    price_czk int,
    checked_in_at timestamptz,
    email_sent_at timestamptz,
    created_at timestamptz not null default now()
);

-- Jeden nákup může nést víc vstupenek (session_id + pořadové číslo)
create unique index if not exists tickets_session_ticket_no
    on tickets (stripe_session_id, ticket_no) where stripe_session_id is not null;

-- Veřejný guestlist (dobrovolný opt-in po RSVP / nákupu)
create table if not exists guestlist (
    id uuid primary key default gen_random_uuid(),
    invite_id uuid unique references vip_invites(id),
    ticket_id uuid unique references tickets(id),
    name text not null,
    role text,
    bio text check (char_length(bio) <= 200),
    visible boolean not null default true,
    newsletter boolean not null default false,
    created_at timestamptz not null default now()
);

-- Zamknout tabulky pro přímý přístup (RLS bez policies = žádný přístup)
alter table vip_invites enable row level security;
alter table tickets enable row level security;
alter table guestlist enable row level security;

-- ============================================================
-- RPC funkce (volá je web přes anon klíč)
-- ============================================================

-- Načtení pozvánky podle kódu (vrací jen oslovení a stav)
create or replace function get_invite(invite_code text)
returns json
language sql security definer set search_path = public
as $$
    select json_build_object(
        'greeting_name', greeting_name,
        'full_name', full_name,
        'email', email,
        'status', status
    )
    from vip_invites
    where upper(code) = upper(trim(invite_code));
$$;

-- Potvrzení / odmítnutí účasti; při potvrzení vznikne VIP vstupenka
create or replace function rsvp_invite(invite_code text, attending boolean)
returns json
language plpgsql security definer set search_path = public
as $$
declare
    inv vip_invites%rowtype;
begin
    select * into inv from vip_invites
    where upper(code) = upper(trim(invite_code));

    if inv.id is null then
        return json_build_object('ok', false, 'error', 'invalid_code');
    end if;

    update vip_invites
    set status = case when attending then 'confirmed' else 'declined' end,
        responded_at = now()
    where id = inv.id;

    if attending then
        insert into tickets (type, invite_id, name, email)
        values ('vip', inv.id, inv.full_name, inv.email)
        on conflict do nothing;
    else
        update tickets set status = 'cancelled'
        where invite_id = inv.id and status = 'valid';
    end if;

    return json_build_object('ok', true);
end;
$$;

-- Doplnění / oprava e-mailu na vstupenku (host ho zadá po potvrzení,
-- pokud ho admin nevyplnil u pozvánky). Zapíše se na pozvánku i na
-- ještě neodeslanou vstupenku, aby ji /api/send-ticket mohl poslat.
create or replace function set_invite_email(invite_code text, p_email text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
    inv vip_invites%rowtype;
    clean_email text;
begin
    select * into inv from vip_invites
    where upper(code) = upper(trim(invite_code));

    if inv.id is null or inv.status <> 'confirmed' then
        return json_build_object('ok', false, 'error', 'not_confirmed');
    end if;

    clean_email := nullif(trim(p_email), '');
    if clean_email is null or position('@' in clean_email) = 0 then
        return json_build_object('ok', false, 'error', 'invalid_email');
    end if;

    update vip_invites set email = clean_email where id = inv.id;
    update tickets set email = clean_email
    where invite_id = inv.id and status <> 'cancelled' and email_sent_at is null;

    return json_build_object('ok', true);
end;
$$;

-- Zápis na guestlist (VIP cesta - podle kódu pozvánky), opakované
-- odeslání přepíše předchozí zápis stejného člověka
create or replace function save_guestlist_vip(
    invite_code text,
    p_name text,
    p_role text,
    p_bio text,
    p_visible boolean,
    p_newsletter boolean
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
    inv vip_invites%rowtype;
begin
    select * into inv from vip_invites
    where upper(code) = upper(trim(invite_code));

    if inv.id is null or inv.status <> 'confirmed' then
        return json_build_object('ok', false, 'error', 'not_confirmed');
    end if;

    if p_name is null or trim(p_name) = '' then
        return json_build_object('ok', false, 'error', 'missing_name');
    end if;

    insert into guestlist (invite_id, name, role, bio, visible, newsletter)
    values (inv.id, trim(p_name), nullif(trim(p_role), ''),
            nullif(trim(left(p_bio, 200)), ''), p_visible, p_newsletter)
    on conflict (invite_id) do update
        set name = excluded.name,
            role = excluded.role,
            bio = excluded.bio,
            visible = excluded.visible,
            newsletter = excluded.newsletter;

    return json_build_object('ok', true);
end;
$$;

-- Veřejný guestlist pro web (jen viditelné záznamy, nejnovější první)
create or replace function get_guestlist()
returns json
language sql security definer set search_path = public
as $$
    select coalesce(
        json_agg(
            json_build_object('name', name, 'role', role, 'bio', bio)
            order by created_at desc
        ),
        '[]'::json
    )
    from guestlist
    where visible;
$$;

-- Počítadlo "uvnitř už je X lidí" (všechny platné vstupenky)
create or replace function get_guest_count()
returns integer
language sql security definer set search_path = public
as $$
    select count(*)::integer from tickets where status <> 'cancelled';
$$;
-- Děkovací stránka: info o nákupu podle session_id (nehádatelný, funguje jako klíč)
create or replace function get_session_tickets(p_session_id text)
returns json
language sql security definer set search_path = public
as $$
    select json_build_object(
        'name', min(name),
        'email', min(email),
        'count', count(*),
        'value', coalesce(sum(price_czk), 0)   -- skutečně zaplaceno (po slevách)
    )
    from tickets
    where stripe_session_id = p_session_id and status <> 'cancelled'
    having count(*) > 0;
$$;

-- Guestlist zápis pro veřejné kupující (podle session_id).
-- p_slot = pořadí hosta v objednávce (1..počet vstupenek): kdo koupí víc
-- lupenů, zapíše i lidi, které bere s sebou. Každá vstupenka nese vlastní
-- záznam (guestlist.ticket_id je unikátní), opakovaný zápis stejného
-- pořadí předchozí přepíše.
-- Pozn.: signatura se rozšířila o p_slot, na živé DB proto drop + create
-- v transakci a notify pgrst, 'reload schema'.
create or replace function save_guestlist_public(
    p_session_id text,
    p_name text,
    p_role text,
    p_bio text,
    p_visible boolean,
    p_newsletter boolean,
    p_slot int default 1
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
    t_id uuid;
    total int;
    slot int := greatest(coalesce(p_slot, 1), 1);
begin
    select count(*) into total from tickets
    where stripe_session_id = p_session_id and status <> 'cancelled';

    if total = 0 then
        return json_build_object('ok', false, 'error', 'not_found');
    end if;

    if slot > total then
        return json_build_object('ok', false, 'error', 'no_such_slot');
    end if;

    select id into t_id from tickets
    where stripe_session_id = p_session_id and status <> 'cancelled'
    order by ticket_no
    offset (slot - 1) limit 1;

    if p_name is null or trim(p_name) = '' then
        return json_build_object('ok', false, 'error', 'missing_name');
    end if;

    insert into guestlist (ticket_id, name, role, bio, visible, newsletter)
    values (t_id, trim(p_name), nullif(trim(p_role), ''),
            nullif(trim(left(p_bio, 200)), ''), p_visible, p_newsletter)
    on conflict (ticket_id) do update
        set name = excluded.name,
            role = excluded.role,
            bio = excluded.bio,
            visible = excluded.visible,
            newsletter = excluded.newsletter;

    -- kolik hostů z objednávky ještě může přibýt
    return json_build_object('ok', true, 'slot', slot, 'total', total,
                             'remaining', total - slot);
end;
$$;

-- Webová vstupenka: veřejné info podle QR tokenu (nehádatelný)
create or replace function get_ticket(p_qr_token uuid)
returns json
language sql security definer set search_path = public
as $$
    select json_build_object(
        'name', name,
        'type', type,
        'status', status,
        'ticket_no', ticket_no
    )
    from tickets
    where qr_token = p_qr_token;
$$;

-- Kolik míst zbývá z celkové kapacity 200 (VIP i veřejné dohromady)
create or replace function get_tickets_remaining()
returns integer
language sql security definer set search_path = public
as $$
    select 200 - count(*)::integer from tickets where status <> 'cancelled';
$$;

-- Rate limit hádání PINu (/api/admin, /api/checkin). Zapisuje jen backend
-- přes přímé DB připojení; RLS bez policy = anon klíč se k tabulce nedostane.
-- Aplikováno na produkci 23. 7. 2026 (záloha dat: Web/zalohy-db/2026-07-23).
create table if not exists pin_attempts (
    id bigint generated always as identity primary key,
    ip text not null,
    endpoint text not null,
    attempted_at timestamptz not null default now()
);
create index if not exists pin_attempts_ip_time on pin_attempts (ip, attempted_at);
create index if not exists pin_attempts_time on pin_attempts (attempted_at);
alter table pin_attempts enable row level security;

-- Zpětná vazba po festu (anonymní; jméno jen u zveřejnitelné reference)
create table if not exists caf_feedback (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    rating int check (rating between 1 and 5),
    highlights text[] not null default '{}',
    improve text,
    quote text,
    quote_public boolean not null default false,
    quote_author text,
    artist_tip text,
    come_again text check (come_again in ('ano','mozna','ne')),
    bring_who text[],
    email text,          -- nepovinný, kdo chce stránky z Onanovánek
    pin_order int,       -- ruční připnutí reference nahoru (1..N), jinak NULL
    ip inet
);

-- Stejný model jako zbytek: zamčeno RLS bez policies, čte a zapisuje
-- jen backend přes přímé DB připojení. Anon klíč se k datům nedostane.
-- (Zapnuto 31. 8. 2026 - tabulka byla omylem založena bez RLS.)
alter table caf_feedback enable row level security;

-- ============================================================
-- Týmová nástěnka zpětné vazby (/tym, api/tym.js)
-- Kartičky z dotazníku (import přes feedback_ref) + nápady týmu,
-- prioritizace srdíčky (jedno na osobu a kartu).
-- ============================================================
create table if not exists team_cards (
    id uuid primary key default gen_random_uuid(),
    kind text not null default 'napad' check (kind in ('povedlo', 'zlepsit', 'napad')),
    title text not null check (char_length(title) <= 120),
    description text check (char_length(description) <= 2000),
    author text,
    source text not null default 'tym' check (source in ('tym', 'navstevnici')),
    category text check (category in ('program', 'jidlo', 'organizace', 'prostor', 'marketing', 'jine')),
    status text not null default 'novy' check (status in ('novy', 'resime', 'hotovo', 'nedame')),
    feedback_ref text unique,
    created_at timestamptz not null default now()
);

create table if not exists team_hearts (
    card_id uuid not null references team_cards(id) on delete cascade,
    person text not null,
    created_at timestamptz not null default now(),
    primary key (card_id, person)
);

alter table team_cards enable row level security;
alter table team_hearts enable row level security;

-- Komentáře ke kartičkám týmové nástěnky
create table if not exists team_comments (
    id uuid primary key default gen_random_uuid(),
    card_id uuid not null references team_cards(id) on delete cascade,
    author text not null,
    text text not null check (char_length(text) <= 1000),
    created_at timestamptz not null default now()
);

alter table team_comments enable row level security;
