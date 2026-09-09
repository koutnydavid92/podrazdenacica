-- ============================================================
-- Obchod: Onanovánky (/onanovanky, api/checkout.js, api/stripe-webhook.js,
-- api/admin.js akce shop_*). Stejný bezpečnostní model jako zbytek:
-- tabulky zamčené RLS bez policies, čte a zapisuje jen backend přes
-- přímé DB připojení. Prohlížeč vidí jen RPC níže (SECURITY DEFINER).
-- Aplikovat v Supabase SQL editoru. Záloha dat před změnou:
-- Web/zalohy-db/2026-09-06.
-- ============================================================

-- Objednávky: jeden řádek = jedna zaplacená Stripe Checkout session.
create table if not exists shop_orders (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    order_no bigint generated always as identity,        -- lidské číslo objednávky
    stripe_session_id text not null unique,
    stripe_payment_intent text,
    product text not null default 'onanovanky',
    quantity int not null check (quantity between 1 and 20),
    unit_price_czk int not null,
    shipping_method text not null check (shipping_method in (
        'pickup_atelier', 'packeta_point_cz', 'packeta_point_sk',
        'packeta_home_cz', 'packeta_home_sk')),
    shipping_price_czk int not null default 0,
    total_czk int not null,                                -- skutečně zaplaceno
    gift_bag boolean not null default false,               -- taška zdarma od 999 Kč
    name text,
    email text,
    phone text,
    -- doručovací adresa (jen u doručení na adresu)
    address_line1 text,
    address_line2 text,
    address_city text,
    address_zip text,
    address_country text,                                  -- 'CZ' | 'SK'
    -- výdejní místo Zásilkovny (jen u výdejního místa / Z-BOXu)
    packeta_point_id text,
    packeta_point_name text,
    packeta_point_address text,
    note text,                                             -- vzkaz zákazníka
    -- paid -> labeled (zásilka založená v Zásilkovně, štítek) -> shipped (podáno)
    status text not null default 'paid' check (status in (
        'paid', 'labeled', 'shipped', 'picked_up', 'cancelled', 'refunded')),
    packeta_tracking text,                                 -- číslo zásilky (Z...)
    labeled_at timestamptz,                                -- založení zásilky (9. 9. 2026 přidáno)
    shipped_at timestamptz,
    picked_up_at timestamptz,
    confirmation_sent_at timestamptz,
    shipped_mail_sent_at timestamptz,
    ga_client_id text,
    ga_session_id text
);
create index if not exists shop_orders_status on shop_orders (status, created_at);
alter table shop_orders enable row level security;

-- Sklad: jeden řádek na produkt. Kolik kusů je k dispozici a kolik se
-- prodalo. Webhook odečítá při zaplacení, admin může upravit ručně
-- (dotisk, prodej na akci, partneři).
create table if not exists shop_stock (
    product text primary key,
    stock int not null default 0,          -- kusů skladem k prodeji online
    sold int not null default 0,           -- prodáno online (informativní)
    updated_at timestamptz not null default now()
);
alter table shop_stock enable row level security;
insert into shop_stock (product, stock) values ('onanovanky', 900)
on conflict (product) do nothing;

-- Zájem o ukázku (5 stránek na mail). Pro přehled v adminu; do Ecomailu
-- jde kontakt zvlášť se štítkem onanovanky-ukazka.
create table if not exists shop_samples (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    email text not null,
    ip inet,
    sent_at timestamptz
);
create index if not exists shop_samples_email on shop_samples (email);
alter table shop_samples enable row level security;

-- Děkovací stránka: souhrn objednávky podle session_id (neuhodnutelné,
-- Stripe ho pošle v success_url). Ven jde jen to, co stránka ukazuje.
create or replace function get_shop_order(p_session_id text)
returns json
language sql security definer set search_path = public
as $$
    select json_build_object(
        'order_no', order_no,
        'name', name,
        'email', email,
        'quantity', quantity,
        'unit_price_czk', unit_price_czk,
        'shipping_method', shipping_method,
        'shipping_price_czk', shipping_price_czk,
        'total_czk', total_czk,
        'gift_bag', gift_bag,
        'packeta_point_name', packeta_point_name,
        'packeta_point_address', packeta_point_address,
        'status', status
    )
    from shop_orders
    where stripe_session_id = p_session_id;
$$;

-- Stránka obchodu: je co prodávat? (bez čísel, jen ano/ne)
create or replace function get_shop_available(p_product text)
returns boolean
language sql security definer set search_path = public
as $$
    select coalesce((select stock > 0 from shop_stock where product = p_product), false);
$$;

-- PostgREST musí po přidání funkcí načíst schéma znovu:
notify pgrst, 'reload schema';
