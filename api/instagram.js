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

// Vybraná reelska pro sekci na stránce festu - pořadí tady určuje pořadí
// na webu. Titulek je náš vlastní (popisky z Instagramu jsou na kartu dlouhé);
// když ho necháš prázdný, vezme se začátek popisku z Instagramu.
// ID reelu zjistíš z Graph API, nebo o přidání řekni Claudovi.
// Dva tvary zápisu:
//   { id: '...', titulek: '...' }                     - reel z našeho účtu (náhled z Instagramu)
//   { permalink: '...', cover: '/images/...', titulek: '...' }
//        - reel z cizího účtu (spolupráce). Instagram nám k cizím médiím náhled
//          nedá, proto se obrázek uloží k nám do images/ a servíruje se z webu.
const VYBRANA_REELS = [
    { id: '17901296379561167', titulek: 'Když ti na večičírek dovalí tvořiví lidi' },
    {
        permalink: 'https://www.instagram.com/reel/Dcs0p0tMu3j/',
        cover: '/images/reel-niftyminds.webp',
        titulek: 'První ČAF očima @niftyminds.cz'
    },
    {
        permalink: 'https://www.instagram.com/reel/DcspsLLsiK0/',
        cover: '/images/reel-hulkarna.webp',
        titulek: 'Hůlkárna na ČAF: a byla to jízda'
    }
];

// Bereme s rezervou, ať po vynechání zbyde plných devět
// a ať se ve výběru najdou i starší reelska
const FETCH_LIMIT = Math.max(LIMIT + SKRYTE_POSTY.length + 3, 60);

module.exports = async (req, res) => {
    const token = process.env.META_IG_TOKEN;
    if (!token) {
        console.warn('Instagram: chybí META_IG_TOKEN, feed se nenačte');
        res.status(200).json({ posts: [], reels: [] });
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
            res.status(200).json({ posts: [], reels: [] });
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

        // Vybraná reelska v pořadí podle VYBRANA_REELS (co se nenajde, přeskočíme -
        // třeba když se reel na Instagramu smaže, sekce se prostě zkrátí).
        const podleId = new Map((data.data || []).map(p => [p.id, p]));
        const reels = VYBRANA_REELS.map(v => {
            // Cizí reel s vlastním náhledem: Instagram se na nic ptát nemusíme
            if (v.permalink && v.cover) {
                return {
                    id: v.permalink,
                    image: v.cover,
                    permalink: v.permalink,
                    title: v.titulek || '',
                    caption: v.titulek || ''
                };
            }
            const p = podleId.get(v.id);
            if (!p || !p.permalink) return null;
            const popisek = (p.caption || '').replace(/\s+/g, ' ').trim();
            return {
                id: p.id,
                image: p.thumbnail_url || p.media_url || null,
                permalink: p.permalink,
                title: v.titulek || popisek.slice(0, 70),
                caption: popisek.slice(0, 160)
            };
        }).filter(r => r && r.image);

        // 3 minuty čerstvé, dalších 10 minut smí CDN servírovat starou verzi,
        // zatímco si na pozadí stahuje novou. Návštěvník tak nikdy nečeká
        // a nový příspěvek se na webu objeví do pár minut. Instagram to unese:
        // i při plném provozu je to nanejvýš 20 dotazů za hodinu.
        res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
        res.status(200).json({ posts, reels });
    } catch (e) {
        console.error('Instagram: feed se nenačetl:', e.message);
        res.status(200).json({ posts: [], reels: [] });
    }
};
