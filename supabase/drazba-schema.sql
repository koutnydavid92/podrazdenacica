-- ============================================================
-- Číča Art Fest – tichá dražba (fáze 2)
-- Stejný bezpečnostní model jako zbytek: tabulky zamčené RLS bez
-- policies, mluví s nimi výhradně backend (/api/drazba*) přes
-- přímé DB připojení. Anon klíč se k datům nedostane.
-- Aplikováno na produkci 24. 8. 2026 (záloha: Web/zalohy-db/2026-08-24).
-- ============================================================

-- Nastavení dražby: jediný řádek.
-- mode: 'test'   = vše funguje, příhozy se značí jako testovací
--       'live'   = ostrá dražba, online příhozy jen v okně opens_at–closes_at
--       'closed' = online kolo skončilo (živé příhozy přes admin dál jdou)
create table if not exists auction_settings (
    id smallint primary key default 1 check (id = 1),
    mode text not null default 'test' check (mode in ('test', 'live', 'closed')),
    opens_at timestamptz not null default '2026-08-28T15:30:00+02:00',
    closes_at timestamptz not null default '2026-08-28T20:00:00+02:00',
    updated_at timestamptz not null default now()
);
insert into auction_settings (id) values (1) on conflict do nothing;

-- Dražená díla (slug páruje řádek s katalogem na webu)
create table if not exists auction_items (
    id smallint generated always as identity primary key,
    slug text unique not null,
    title text not null,
    starting_price_czk int not null,
    charity text,
    sort int not null default 0,
    withdrawn boolean not null default false
);

insert into auction_items (slug, title, starting_price_czk, charity, sort) values
    ('balencicaga',       'Balenčičiaga',       2500,  null,                                 1),
    ('hulka',             'Podrážděná hůlka',   1800,  null,                                 2),
    ('klitty',            'Klitty s fotečkama', 1800,  null,                                 3),
    ('bad-nun',           'Bad Nun',            1000,  null,                                 4),
    ('kurwa-bober',       'Kurwa bober',        2000,  null,                                 5),
    ('sila-tisice-cecek', 'Síla tisíce cecek',  10000, '100 % pro Lymfom Help',              6),
    ('euforie',           'EUFORIE',            1500,  '50 % pro Opuštěné kočičí tlapky',    7),
    ('vaclav-havel',      'Václav Havel',       10000, '100 % pro Lymfom Help',              8),
    ('cica-broz',         'Číča brož',          1500,  '100 % pro Nadaci Veronica',          9),
    ('black-sheep',       'Black sheep',        1500,  '100 % pro Nadaci Veronica',          10)
on conflict (slug) do nothing;

-- Přihazující: e-mail se ověřuje odkazem (token), bez hesel
create table if not exists bidders (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    name text not null,
    token uuid unique not null default gen_random_uuid(),
    verified_at timestamptz,
    newsletter boolean not null default false,
    last_email_at timestamptz,
    created_at timestamptz not null default now()
);
create unique index if not exists bidders_email on bidders (lower(email));

-- Příhozy. is_test podle režimu v okamžiku příhozu - testovací data
-- se před ostrým startem smažou jedním tlačítkem v adminu.
-- Živý příhoz z pléna nemá bidder_id, jen jméno zapsané adminem.
create table if not exists bids (
    id bigint generated always as identity primary key,
    item_id smallint not null references auction_items(id),
    bidder_id uuid references bidders(id),
    live_name text,
    amount_czk int not null check (amount_czk > 0),
    source text not null default 'online' check (source in ('online', 'live')),
    is_test boolean not null default false,
    created_at timestamptz not null default now(),
    check (bidder_id is not null or live_name is not null)
);
create index if not exists bids_item_amount on bids (item_id, is_test, amount_czk desc);

alter table auction_settings enable row level security;
alter table auction_items enable row level security;
alter table bidders enable row level security;
alter table bids enable row level security;
