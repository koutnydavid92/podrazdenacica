// GET /api/instagram - devět posledních příspěvků z @cicaartfest pro mřížku
// na stránce festu.
//
// Proč přes server: token nesmí do prohlížeče a Instagram má limity na počet
// dotazů. Odpověď se proto cachuje na CDN Vercelu (viz Cache-Control níže),
// takže Instagram se ptáme nanejvýš jednou za 10 minut, ať web nebrzdí.
//
// Obrázkové adresy z Instagramu po čase vyprší, proto se ukládá jen krátce
// a klient dostává pokaždé čerstvé odkazy.

const IG_USER_ID = '17841442684710513'; // @cicaartfest
const API_VERSION = 'v21.0';
const LIMIT = 9;

// Posty, které na web nepatří, i když na Instagramu zůstávají.
// Instagram vrací příspěvky čistě podle data a o připnutí na profilu neví,
// takže pořadí z profilu se sem přenést nedá - dá se jen něco vynechat.
// ID příspěvku zjistíš z Graph API, nebo o vynechání řekni Claudovi.
const SKRYTE_POSTY = [
    // "Girl math... early číča cena" - cena po 14. 8. 2026 už neplatí
    '18107013845152440'
];

// Bereme s rezervou, ať po vynechání zbyde plných devět
const FETCH_LIMIT = LIMIT + SKRYTE_POSTY.length + 3;

module.exports = async (req, res) => {
    const token = process.env.META_IG_TOKEN;
    if (!token) {
        console.warn('Instagram: chybí META_IG_TOKEN, feed se nenačte');
        res.status(200).json({ posts: [] });
        return;
    }

    const fields = 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp';
    const url = `https://graph.facebook.com/${API_VERSION}/${IG_USER_ID}/media`
        + `?fields=${fields}&limit=${FETCH_LIMIT}&access_token=${encodeURIComponent(token)}`;

    try {
        // Časový strop, ať stránka nečeká, kdyby Instagram neodpovídal
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 6000);
        let r;
        try {
            r = await fetch(url, { signal: abort.signal });
        } finally {
            clearTimeout(timer);
        }

        const data = await r.json();
        if (!r.ok || data.error) {
            console.error('Instagram: feed se nenačetl,',
                (data.error && data.error.message) || ('HTTP ' + r.status));
            // Prázdný seznam, ne chyba: mřížka se prostě neukáže
            // a zbytek stránky funguje dál.
            res.status(200).json({ posts: [] });
            return;
        }

        // Ven pouštíme jen to, co mřížka potřebuje. Videa a alba mají náhled
        // v thumbnail_url, obyčejné fotky v media_url.
        const posts = (data.data || [])
            .filter(p => !SKRYTE_POSTY.includes(p.id))
            .slice(0, LIMIT)
            .map(p => ({
            id: p.id,
            image: p.thumbnail_url || p.media_url || null,
            permalink: p.permalink,
            // Popisek slouží jen jako alt text, delší nemá smysl posílat
            caption: (p.caption || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            isVideo: p.media_type === 'VIDEO',
            isAlbum: p.media_type === 'CAROUSEL_ALBUM'
        })).filter(p => p.image && p.permalink);

        // 10 minut čerstvé, další hodinu smí CDN servírovat starou verzi,
        // zatímco si na pozadí stahuje novou. Návštěvník tak nikdy nečeká.
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        res.status(200).json({ posts });
    } catch (e) {
        console.error('Instagram: feed se nenačetl:', e.message);
        res.status(200).json({ posts: [] });
    }
};
