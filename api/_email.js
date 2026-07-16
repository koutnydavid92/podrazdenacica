// Odesílání e-mailů přes Ecomail transakční API + šablona vstupenky.
const BASE_URL = 'https://www.podrazdenacica.cz';
// Odesílá se z domény ověřené v Ecomailu; odpovědi chodí na hlavní adresu.
const FROM_EMAIL = 'jsem@cicoviny.podrazdenacica.cz';
const REPLY_TO = 'jsem@podrazdenacica.cz';
const FROM_NAME = 'Podrážděná číča';
const ECOMAIL_LIST_ID = 2; // "Newsletter Číča"

async function ecomail(path, payload) {
    const res = await fetch('https://api2.ecomailapp.cz' + path, {
        method: 'POST',
        headers: {
            'key': process.env.ECOMAIL_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Ecomail ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    try { return JSON.parse(text); } catch { return text; }
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// HTML e-mailu se vstupenkami (jeden nákup = jeden mail, QR pro každou vstupenku)
// greetingName = oslovení v 5. pádě (máme jen u VIP); bez něj zdravíme neutrálně
function ticketEmailHtml({ greetingName, tickets, isVip }) {
    const greeting = greetingName ? `Čaf ${esc(greetingName)}` : 'Čaf';
    const plural = tickets.length === 1 ? 'vstupenka'
        : (tickets.length <= 4 ? 'vstupenky' : 'vstupenek');

    const ticketBlocks = tickets.map(t => `
        <div style="background:#FFFFFF;border-radius:12px;padding:24px;margin:16px 0;text-align:center;">
            <img src="${BASE_URL}/api/qr?token=${t.qr_token}" alt="QR kód vstupenky"
                 width="240" height="240" style="display:block;margin:0 auto;width:240px;height:240px;">
            <p style="color:#0D0D0D;font-size:14px;margin:12px 0 4px;font-weight:bold;">
                ${isVip ? 'VIP vstupenka' : 'Vstupenka'}${tickets.length > 1 ? ' ' + t.ticket_no + '/' + tickets.length : ''}
            </p>
            <p style="color:#555555;font-size:12px;margin:0;">
                Nejde zobrazit QR? <a href="${BASE_URL}/cica-art-fest/vstupenka?t=${t.qr_token}" style="color:#FE45E8;">Otevři vstupenku na webu</a>.
            </p>
        </div>`).join('');

    return `<!DOCTYPE html>
<html lang="cs"><body style="margin:0;padding:0;background:#0D0D0D;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:Helvetica,Arial,sans-serif;">
    <div style="text-align:center;margin-bottom:24px;">
        <img src="${BASE_URL}/images/logo.png" alt="Podrážděná číča" width="90" style="width:90px;">
    </div>
    <div style="background:#111111;border:1px solid #FE45E8;border-radius:16px;padding:32px 24px;">
        <h1 style="color:#F5F5F5;font-size:26px;margin:0 0 12px;text-align:center;">
            ${greeting}, ${isVip ? 'tady je tvůj VIP vstup' : 'máš to'}. 🖤
        </h1>
        <p style="color:#CCCCCC;font-size:15px;line-height:1.6;text-align:center;margin:0 0 8px;">
            Číča Art Fest &middot; 28. 8. 2026 &middot; co.labs_park, Kounicova 20, Brno
        </p>
        <p style="color:#CCCCCC;font-size:15px;line-height:1.6;text-align:center;margin:0 0 20px;">
            ${tickets.length > 1 ? `Uvnitř najdeš ${tickets.length} ${plural}, každou s vlastním QR kódem. Rozdej je smečce.` : ''}
            U vchodu ukážeš QR kód, dostaneš pásku a zbytek večera je na tobě.
        </p>
        ${ticketBlocks}
        <p style="color:#CCCCCC;font-size:14px;line-height:1.6;margin:20px 0 0;">
            Vernisáž kolekce Královny Brno-venkov, módní přehlídka, hudba z ženských prsou,
            standup a dražba, u které se budeš bát zvednout ruku. Program postupně odhalujeme
            na <a href="${BASE_URL}/cica-art-fest" style="color:#FE45E8;">webu</a>
            a <a href="https://www.instagram.com/podrazdena_cica/" style="color:#FE45E8;">Instagramu</a>.
        </p>
        <p style="color:#CCCCCC;font-size:14px;margin:16px 0 0;">
            Nech si mě v hlavě. Mňau ₍^. .^₎⟆
        </p>
    </div>
    <p style="color:#666666;font-size:11px;text-align:center;margin:20px 0 0;">
        Tenhle mail ti přišel, protože máš vstupenku na Číča Art Fest.
        Vstupenka je nevratná, ale přenosná.
    </p>
</div>
</body></html>`;
}

function ticketEmailText({ tickets, isVip }) {
    const lines = tickets.map(t =>
        `${isVip ? 'VIP vstupenka' : 'Vstupenka'} ${t.ticket_no}: ${BASE_URL}/cica-art-fest/vstupenka?t=${t.qr_token}`);
    return 'Tvoje vstupenka na Číča Art Fest (28. 8. 2026, co.labs_park, Brno):\n\n'
        + lines.join('\n')
        + '\n\nU vchodu ukážeš QR kód a dostaneš pásku. Mňau.';
}

// Pošle e-mail se vstupenkami. tickets: [{qr_token, ticket_no}]
// greetingName: oslovení v 5. pádě (jen VIP), name: celé jméno adresáta
async function sendTicketEmail({ to, name, greetingName, tickets, isVip }) {
    return ecomail('/transactional/send-message', {
        message: {
            subject: isVip
                ? 'Tvůj VIP vstup na Číča Art Fest 🖤'
                : 'Tvoje vstupenka na Číča Art Fest 🖤',
            from_name: FROM_NAME,
            from_email: FROM_EMAIL,
            reply_to: REPLY_TO,
            to: [{ email: to, name: name || '' }],
            html: ticketEmailHtml({ greetingName, tickets, isVip }),
            text: ticketEmailText({ tickets, isVip })
        }
    });
}

// Přihlásí kontakt do listu (jen při zaškrtnutém souhlasu)
async function subscribeToNewsletter({ email, name }) {
    const parts = String(name || '').trim().split(/\s+/);
    return ecomail(`/lists/${ECOMAIL_LIST_ID}/subscribe`, {
        subscriber_data: {
            email,
            name: parts[0] || '',
            surname: parts.slice(1).join(' ') || '',
            tags: ['cica-art-fest']
        },
        trigger_autoresponders: false,
        update_existing: true,
        resubscribe: false
    });
}

module.exports = { sendTicketEmail, subscribeToNewsletter };
