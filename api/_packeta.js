// Zásilkovna (Packeta) - zakládání zásilek a štítky přes REST API.
// Dokumentace: https://docs.packeta.com (createPacket, packetLabelPdf,
// packetsLabelsPdf). API mluví XML, odpověď má <status>ok|fault</status>.
// Heslo API je v PACKETA_API_PASSWORD (Vercel env / .env), nikdy v kódu.
//
// Volá se jen z api/admin.js (akce shop_packeta_*), soubor s podtržítkem
// Vercel nevystavuje jako endpoint.

const API_URL = 'https://www.zasilkovna.cz/api/rest';

// Označení odesílatele tak, jak je v klientské sekci (Nastavení -> Odesílatelé).
// Ověřeno 7. 9. 2026: API bere jen 'podrazdenacica.cz'.
const SENDER_LABEL = 'podrazdenacica.cz';

// Doručení na adresu = "dopravce" s vlastním ID místo výdejního místa.
// 106 = Zásilkovna domů ČR, 131 = Zásilkovna domů SK (ověřeno přes API).
const HOME_DELIVERY_CARRIER = { CZ: 106, SK: 131 };

// Hmotnost: kniha A4 na 180g papíře cca 250 g (paleta 1000 ks ~ 250 kg),
// k tomu obálka a výplň. Zaokrouhlujeme nahoru, ať nás Zásilkovna nedoúčtuje.
const WEIGHT_PER_PIECE_KG = 0.28;
const PACKAGING_KG = 0.05;

function weightKg(quantity) {
    const q = Math.max(1, parseInt(quantity, 10) || 1);
    return Math.round((q * WEIGHT_PER_PIECE_KG + PACKAGING_KG) * 100) / 100;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Katka Nováková" -> jméno + příjmení (Zásilkovna chce obojí zvlášť)
function splitName(full) {
    const parts = String(full || '').trim().replace(/\s+/g, ' ').split(' ');
    if (parts.length < 2) return { name: parts[0] || 'Zákazník', surname: parts[0] || 'Číča' };
    return { name: parts.slice(0, -1).join(' ').slice(0, 32), surname: parts[parts.length - 1].slice(0, 32) };
}

// "Veselá 5", "Rybniční 1234/56", "Nám. Svobody 12a" -> ulice + číslo
function splitStreet(line1, line2) {
    const s = [line1, line2].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const m = s.match(/^(.*?)[\s,]+(\d[\d\/a-zA-Z-]*)\s*$/);
    if (m) return { street: m[1].slice(0, 32), houseNumber: m[2].slice(0, 16) };
    return { street: s.slice(0, 32), houseNumber: '' };
}

// Atributy zásilky z objednávky (řádek shop_orders)
function packetAttributes(order) {
    const { name, surname } = splitName(order.name);
    const isHome = order.shipping_method === 'packeta_home_cz' || order.shipping_method === 'packeta_home_sk';
    const country = (order.address_country || (order.shipping_method.endsWith('_sk') ? 'SK' : 'CZ')).toUpperCase();
    const attrs = {
        number: String(order.order_no),
        name, surname,
        email: order.email || '',
        phone: order.phone || '',
        addressId: isHome ? HOME_DELIVERY_CARRIER[country] : order.packeta_point_id,
        value: order.total_czk,
        currency: 'CZK',
        weight: weightKg(order.quantity),
        eshop: SENDER_LABEL,
        adultContent: 0
        // vzkaz zákazníka záměrně neposíláme: Zásilkovna ho tiskne na štítek
        // a je určený nám, ne kurýrovi
    };
    if (isHome) {
        const { street, houseNumber } = splitStreet(order.address_line1, order.address_line2);
        attrs.street = street;
        attrs.houseNumber = houseNumber;
        attrs.city = String(order.address_city || '').slice(0, 32);
        attrs.zip = String(order.address_zip || '').replace(/\s+/g, '');
    }
    return attrs;
}

async function call(method, bodyXml) {
    const password = process.env.PACKETA_API_PASSWORD;
    if (!password) throw new Error('chybí PACKETA_API_PASSWORD');
    const xml = `<${method}><apiPassword>${esc(password)}</apiPassword>${bodyXml}</${method}>`;
    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xml
    });
    const text = await res.text();
    const status = (text.match(/<status>(\w+)<\/status>/) || [])[1];
    if (status !== 'ok') {
        const fault = (text.match(/<fault>([^<]*)<\/fault>/) || [])[1] || 'unknown';
        const msg = (text.match(/<string>([^<]*)<\/string>/) || [])[1] || '';
        // Detail chyby: <detail><attributes><fault><name>x</name><fault>text</fault></fault>...
        const details = [...text.matchAll(/<fault>\s*<name>([^<]*)<\/name>\s*<fault>([^<]*)<\/fault>\s*<\/fault>/g)]
            .map(m => m[1] + ': ' + m[2]).slice(0, 6).join('; ');
        const plain = !details ? (text.match(/<detail>([^<]*)<\/detail>/) || [])[1] : '';
        throw new Error(`Zásilkovna ${fault}: ${details || plain || msg}`);
    }
    return text;
}

// Založí zásilku. Vrací { id, barcode } - id je číslo zásilky ke sledování.
async function createPacket(order) {
    const a = packetAttributes(order);
    if (!a.addressId) throw new Error('chybí výdejní místo nebo dopravce');
    const fields = Object.entries(a)
        .filter(([, v]) => v !== '' && v != null)
        .map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
    const text = await call('createPacket', `<packetAttributes>${fields}</packetAttributes>`);
    const id = (text.match(/<id>([^<]+)<\/id>/) || [])[1];
    const barcode = (text.match(/<barcode>([^<]+)<\/barcode>/) || [])[1];
    if (!id) throw new Error('Zásilkovna nevrátila číslo zásilky');
    return { id, barcode: barcode || id };
}

// Štítky jako PDF (base64). Formáty např. "A6 on A6" (termotiskárna),
// "A6 on A4" (4 na stránku), "A7 on A4" (8 na stránku).
async function labelsPdf(packetIds, format) {
    const ids = packetIds.map(id => `<id>${esc(id)}</id>`).join('');
    const text = await call('packetsLabelsPdf',
        `<packetIds>${ids}</packetIds><format>${esc(format || 'A6 on A6')}</format><offset>0</offset>`);
    const b64 = (text.match(/<result>([^<]+)<\/result>/) || [])[1];
    if (!b64) throw new Error('Zásilkovna nevrátila PDF');
    return b64;
}

// Zruší zásilku (jen dokud nebyla podaná). Používá se u storna.
async function cancelPacket(packetId) {
    await call('cancelPacket', `<packetId>${esc(packetId)}</packetId>`);
    return true;
}

// Podací kód pro Z-BOX (v klientské sekci "Podací kód", v API consignPassword).
// Zadává se na klávesnici Z-BOXu při podání bez štítku.
async function packetConsignCode(packetId) {
    const text = await call('packetInfo', `<packetId>${esc(packetId)}</packetId>`);
    return (text.match(/<consignPassword>([^<]*)<\/consignPassword>/) || [])[1] || null;
}

// Stav zásilky. Kódy Zásilkovny: 1 data přijata (čeká na podání), 2 přijato
// na podacím místě, 3 až 6 na cestě, 5 připraveno k vyzvednutí, 7 doručeno /
// vyzvednuto, 9 vrací se, 10 vráceno odesílateli, 11 zrušeno.
async function packetStatus(packetId) {
    const text = await call('packetStatus', `<packetId>${esc(packetId)}</packetId>`);
    return {
        code: parseInt((text.match(/<statusCode>(\d+)<\/statusCode>/) || [])[1], 10) || 0,
        codeText: (text.match(/<codeText>([^<]*)<\/codeText>/) || [])[1] || '',
        statusText: (text.match(/<statusText>([^<]*)<\/statusText>/) || [])[1] || '',
        dateTime: (text.match(/<dateTime>([^<]*)<\/dateTime>/) || [])[1] || null
    };
}

const STATUS_CS = {
    1: 'čeká na podání', 2: 'přijato Zásilkovnou', 3: 'připraveno k odjezdu', 4: 'na cestě',
    5: 'připraveno k vyzvednutí', 6: 'předáno dopravci', 7: 'doručeno', 9: 'vrací se',
    10: 'vráceno odesílateli', 11: 'zrušeno', 12: 'předáno k doručení', 14: 'problém s doručením'
};

// Projde objednávky se zásilkou, které ještě nejsou doručené, a dorovná stav
// podle Zásilkovny: podání -> 'shipped' (+ mail se sledováním), doručeno ->
// 'picked_up'. Volá se z adminu při načtení a z denního cronu.
// Vrací seznam změn. Chyby u jednotlivých zásilek nezastaví ostatní.
async function syncStatuses(client, sendShippedEmail, limit) {
    if (!process.env.PACKETA_API_PASSWORD) return [];
    const { rows } = await client.query(
        `select * from shop_orders
         where packeta_tracking is not null and status in ('labeled', 'shipped')
         order by created_at desc limit $1`, [limit || 40]);
    const changes = [];
    for (const order of rows) {
        if (!order.packeta_consign_code) {
            try {
                const code = await packetConsignCode(order.packeta_tracking);
                if (code) await client.query('update shop_orders set packeta_consign_code = $2 where id = $1', [order.id, code]);
            } catch (e) { console.error('packeta consign code failed', order.order_no, e.message); }
        }
        let st;
        try { st = await packetStatus(order.packeta_tracking); }
        catch (e) { console.error('packeta status failed', order.order_no, e.message); continue; }
        const text = STATUS_CS[st.code] || st.codeText || String(st.code);
        await client.query(
            `update shop_orders set packeta_status_code = $2, packeta_status_text = $3, packeta_status_at = now() where id = $1`,
            [order.id, st.code, text]);
        if (st.code === 7 && order.status !== 'picked_up') {
            await client.query(`update shop_orders set status = 'picked_up', picked_up_at = coalesce(picked_up_at, now()),
                shipped_at = coalesce(shipped_at, now()) where id = $1`, [order.id]);
            changes.push({ order_no: order.order_no, to: 'picked_up' });
        } else if ([2, 3, 4, 5, 6, 12].includes(st.code) && order.status === 'labeled') {
            const { rows: upd } = await client.query(
                `update shop_orders set status = 'shipped', shipped_at = coalesce(shipped_at, now()) where id = $1 returning *`,
                [order.id]);
            let mailed = false;
            if (sendShippedEmail && upd[0].email && !upd[0].shipped_mail_sent_at) {
                try {
                    await sendShippedEmail({ order: upd[0] });
                    await client.query('update shop_orders set shipped_mail_sent_at = now() where id = $1', [order.id]);
                    mailed = true;
                } catch (e) { console.error('shipped mail failed', order.order_no, e.message); }
            }
            changes.push({ order_no: order.order_no, to: 'shipped', mailed });
        }
    }
    return changes;
}

// Řádek pro hromadný import CSV (šablona "version 8" z klientské sekce)
function csvRow(order) {
    const a = packetAttributes(order);
    const isHome = Boolean(a.street !== undefined);
    return [
        '',                       // Nevybráno (checkbox)
        a.number, a.name, a.surname, '', a.email, a.phone,
        '',                       // dobírka
        'CZK', a.value, a.weight,
        a.addressId,              // výdejní místo nebo dopravce
        a.eshop,
        '0',                      // obsah 18+
        '',                       // plánovaný výdej
        isHome ? a.street : '', isHome ? a.houseNumber : '', isHome ? a.city : '', isHome ? a.zip : '',
        '',                       // výdejní místo dopravce
        '', '', '',               // rozměry
        '',                       // poznámka (vzkaz zákazníka na štítek nepatří)
        '', '', '', '', '', ''    // sledování, CIF, affiliate, daň, země původu
    ];
}

function csvFile(orders) {
    const line = cells => cells.map(c => {
        const s = String(c == null ? '' : c);
        return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(';');
    // 1. řádek "version 8", 2. řádek hlavička (import ji přeskakuje), pak data
    const header = ['', 'Číslo', 'Jméno', 'Příjmení', 'Firma', 'E-mail', 'Telefon', 'Dobírka', 'Měna', 'Hodnota',
        'Hmotnost', 'Výdejní místo nebo dopravce', 'Odesílatel', 'Obsah 18+', 'Plánovaný výdej', 'Ulice',
        'Číslo popisné', 'Město', 'PSČ', 'Výdejní místo dopravce', 'Velikost X', 'Velikost Y', 'Velikost Z',
        'Poznámka', 'Povolení veřejného sledování', 'Povolení sledování uživatelů', 'CIF příjemce', 'Affiliate Id',
        'Logistická daň', 'Země původu zboží'];
    return '﻿"version 8"\n' + line(header) + '\n' + orders.map(o => line(csvRow(o))).join('\n') + '\n';
}

module.exports = {
    SENDER_LABEL, HOME_DELIVERY_CARRIER, weightKg, splitName, splitStreet,
    packetAttributes, createPacket, cancelPacket, labelsPdf, csvFile, packetStatus, packetConsignCode, syncStatuses, STATUS_CS
};
