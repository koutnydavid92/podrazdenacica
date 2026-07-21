// Sdílená logika pro Číča Art Fest API (soubory s podtržítkem
// Vercel nevystavuje jako endpointy).
const { Client } = require('pg');

const CAPACITY = 250;
const PRICE_CZK = 666;          // early bird
const PRICE_LATE_CZK = 777;     // od 15. 8. 2026
const EARLY_BIRD_UNTIL = new Date('2026-08-15T00:00:00+02:00');

// Aktuální cena vstupenky podle data
function currentPriceCzk() {
    return new Date() < EARLY_BIRD_UNTIL ? PRICE_CZK : PRICE_LATE_CZK;
}

async function withDb(fn) {
    const client = new Client({
        connectionString: process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false }
    });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end().catch(() => {});
    }
}

// Kolik míst zbývá z celkové kapacity (VIP i veřejné dohromady)
async function remainingPublic(client) {
    const { rows } = await client.query(
        "select count(*)::int as taken from tickets where status <> 'cancelled'"
    );
    return CAPACITY - rows[0].taken;
}

// Vytvoří vstupenky po zaplacení. Idempotentní: když už pro session
// vstupenky existují (webhook přišel dvakrát), nic dalšího nevznikne.
async function fulfillSession(client, session, quantity) {
    const { rows } = await client.query(
        'select count(*)::int as n from tickets where stripe_session_id = $1',
        [session.id]
    );
    if (rows[0].n > 0) return { created: 0, already: rows[0].n };

    const name = (session.customer_details && session.customer_details.name) || null;
    const email = (session.customer_details && session.customer_details.email) || null;
    // skutečně zaplacená cena za kus (haléře -> Kč)
    const unitPrice = session.amount_total
        ? Math.round(session.amount_total / 100 / quantity)
        : null;
    for (let i = 1; i <= quantity; i++) {
        await client.query(
            "insert into tickets (type, name, email, stripe_session_id, ticket_no, price_czk) values ('public', $1, $2, $3, $4, $5)",
            [name, email, session.id, i, unitPrice]
        );
    }
    return { created: quantity, already: 0 };
}

module.exports = { CAPACITY, PRICE_CZK, PRICE_LATE_CZK, currentPriceCzk, withDb, remainingPublic, fulfillSession };
