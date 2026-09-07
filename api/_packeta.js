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
    packetAttributes, createPacket, cancelPacket, labelsPdf, csvFile
};
