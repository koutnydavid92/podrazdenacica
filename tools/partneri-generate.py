#!/usr/bin/env python3
"""
Generátor soukromých poděkovacích stránek pro partnery Číča Art Festu 2026.

Pro každého partnera:
  - převede jeho fotky na webp náhledy do images/partneri-fotky/<slug>/
  - zabalí originály do files/partneri/caf-2026-<slug>.zip (s README)
  - vygeneruje cica-art-fest/partneri/<slug>.html (noindex, mimo sitemapu)

Spouštět z kořene webu:  python3 tools/partneri-generate.py [slug …] [--html]
  --html  = přegeneruje jen HTML stránky z už hotových náhledů a ZIPů (změna textu/šablony),
            fotky se nezpracovávají a ZIPy se nemění (šetří čas i velikost gitu).
Zdrojové fotky bere ze složky SRC (mimo repo). Existující výstupy přepíše.
"""
import os, re, sys, glob, struct, shutil, subprocess, tempfile, html
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _imgdup import fingerprint, distance   # porovnání fotek podle obsahu (duplicity DSC vs. finální)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = ("/Users/david/Documents/Dokumenty – David – MacBook Air/Mlyko/Podrážděná číča/Web/"
       "Číča Art Fest/Fotky a videa/Adelice foto/Číča ARTFEST 2/_Partneri")
CWEBP = "/opt/homebrew/bin/cwebp"
THUMB_PX = 1000     # nejdelší strana náhledu (stačí i pro lightbox na mobilu)
THUMB_Q = 78
# Ve složkách jsou finální fotky (číslované, plné rozlišení ~10 MB) i starší DSC_* náhledy (1600 px).
# True = když složka obsahuje finální fotky, DSC_* se ignorují. Partner s `keep_dsc=True` dostane obojí
# (Melvil a JAKKO mají finálních málo, David chtěl nechat i bonusové).
PREFER_FINAL = True
# U `keep_dsc` partnerů se z DSC_* vezmou jen fotky, které mezi finálními NEJSOU (stejná fotka má jiný název).
# Otisk 32×32: duplicity mají skóre < 5, různé fotky > 25 → práh 12.
DUP_THRESHOLD = 12
# Originály ~10 MB/ks by dávaly ZIPy o stovkách MB (GitHub limit 100 MB/soubor). Do ZIPu na webu jde
# proto verze zmenšená na ZIP_MAX_PX (1600 px ≈ 0,4 MB/ks, stejná jako první várka od Adelice).
# Plné rozlišení se řeší odkazem na Drive: partner může mít v konfiguraci `drive="https://…"`.
ZIP_MAX_PX = 1600
ZIP_Q = 90
# Celé album všech fotek z festu (sdílené album Google Fotky, společné pro všechny partnery). Prázdné = tlačítko se neukáže.
DRIVE_ALBUM_URL = "https://photos.google.com/share/AF1QipO5QAUm2Muke2cL0WdX0HDKeWu9Q8bLtRem8FZVQ3DCHWXhgIlmCZTSGn0nBi-t4A?key=aDNQdV96dVhfNVZiVXZKUG5vVXZfZ05UU3BEZ0lB"

PARTNERS = [
    dict(slug="makeup-institute-prague", name="Make Up Institute Prague", folder="01 Make Up Institute Prague",
         logo="/images/partneri/makeup-institute-prague.png", square=True, web="https://www.makeupinstitute.cz/",
         role="Vaše vizážistky se postaraly o make-up všech devíti žen, které šly po mole."),
    dict(slug="furiosa", name="Furiosa", folder="02 Furiosa", exclude=["040", "386", "414"],
         logo="/images/partneri/furiosa.png", square=False, web="https://furiosa.cz/",
         role="Vaše šperky a brýle dotvořily outfity modelek na přehlídce."),
    dict(slug="stary-vrch", name="Starý vrch", folder="03 Stary vrch",
         logo="/images/partneri/stary-vrch.png", square=False, web="https://www.stary-vrch.cz/",
         role="Vaším frizzante jsme vítali každého návštěvníka u vstupu a vaše vína dělala radost účinkujícím v zákulisí."),
    dict(slug="pragers", name="Prager's", folder="04 Pragers",
         logo="/images/partneri/pragers.svg", square=False, web="https://www.pragers.cz/",
         role="Váš cider a kombucha chladili návštěvníky celé odpoledne až do noci."),
    dict(slug="amity-drinks", name="Amity Drinks", folder="05 Amity",
         logo="/images/partneri/amity-drinks.svg", square=True, web="https://amitydrinks.cz/",
         role="Vaše drinky byly na stolech po celém parku."),
    dict(slug="jakko-candles", name="JAKKO candles", folder="06 Jakko candles", keep_dsc=True,
         logo="/images/partneri/jakko-candles.png", square=False, web="https://www.jakko.cz/",
         role="Vaše svíčky měly své místo na Číča Marketu, design marketu českých značek a umělců."),
    dict(slug="hulkarna", name="Hůlkárna", folder="07 Hulkarna",
         logo="/images/partneri/hulkarna.png", square=False, web="https://www.hulkarna.cz",
         role="Vaše hole a klobouky prošly po mole na modelkách a Podrážděná hůlka, která vznikla ve spolupráci s vámi, "
              "se v benefiční aukci prodala za 2 200 Kč ve prospěch Útulku Tuláčik Brezno."),
    dict(slug="jan-melvil", name="Jan Melvil Publishing", folder="08 Jan Melvil", keep_dsc=True,
         logo="/images/partneri/melvil.png", square=False, web="https://www.melvil.cz/",
         role="Vaše knihy byly na Číča Marketu a Hana Vacková z nich četla ukázku po panelové diskuzi."),
    dict(slug="rozkosss", name="Rozkoššš", folder="09 Rozkosss",
         logo="/images/partneri/rozkosss.png", square=True, web="https://www.rozkosss.cz",
         role="Zuzana Křížová seděla v panelové diskuzi, vaše kousky šly po mole a balíček Klitty s fotečkama "
              "se v benefiční aukci prodal za 3 000 Kč ve prospěch Opuštěných kočičích tlapek."),
    dict(slug="t-shock", name="T-shock", folder="10 T-shock (tasky)",
         logo="/images/partneri/t-shock.png", square=False, web="https://www.t-shock.eu/",
         role="Dodali jste čisté dárkové tašky a my jsme si je přímo na akci sprejovali. Byl to jeden z nejlepších zážitků "
              "celého dne a lidi z toho byli nadšení."),
    dict(slug="czeska", name="CZESKA", folder="11 Czeska",
         logo="/images/partneri/czeska.png", square=True, web="https://www.czeska.cz/",
         role="Vaše autorská móda oblékla ženy na přehlídce a bylo to vidět na každém kroku po mole."),
    dict(slug="orera-bags", name="Orera Bags", folder="12 Orera bags",
         logo="/images/partneri/orera-bags.png", square=True, web="https://www.instagram.com/orera_bags/",
         role="Vaše kabelky dotvořily outfity modelek na přehlídce."),
]

def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def webp_dims(path):
    d = open(path, "rb").read()
    i = d.find(b"VP8 ")
    if i > 0:
        w, h = struct.unpack("<HH", d[i + 14:i + 18]); return w & 0x3FFF, h & 0x3FFF
    i = d.find(b"VP8L")
    if i > 0:
        n = int.from_bytes(d[i + 9:i + 13], "little"); return (n & 0x3FFF) + 1, ((n >> 14) & 0x3FFF) + 1
    i = d.find(b"VP8X")
    w = int.from_bytes(d[i + 12:i + 15], "little") + 1; h = int.from_bytes(d[i + 15:i + 18], "little") + 1
    return w, h

def logo_dims(url):
    """Rozměry loga pro atributy width/height (poměr stran). PNG z hlavičky, SVG z viewBox/width/height."""
    path = os.path.join(ROOT, url.lstrip("/"))
    if url.lower().endswith(".svg"):
        head = open(path, "r", encoding="utf-8", errors="ignore").read(4000)
        m = re.search(r'viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"', head)
        if m: return int(float(m.group(1))), int(float(m.group(2)))
        mw = re.search(r'\swidth="([\d.]+)', head); mh = re.search(r'\sheight="([\d.]+)', head)
        if mw and mh: return int(float(mw.group(1))), int(float(mh.group(1)))
        return 400, 200
    d = open(path, "rb").read(32)
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", d[16:24])
    return 400, 200

def build_photos(p):
    src_dir = os.path.join(SRC, p["folder"])
    files = sorted(f for f in os.listdir(src_dir) if f.lower().endswith((".jpg", ".jpeg")))
    # `exclude` = názvy bez přípony, které partner nechce (zdrojová složka se nemění)
    skip = set(p.get("exclude", []))
    files = [f for f in files if os.path.splitext(f)[0] not in skip]
    finals = [f for f in files if not f.upper().startswith("DSC")]
    if PREFER_FINAL and finals:
        if p.get("keep_dsc"):
            # finální + jen ty DSC_*, které nejsou duplicitou žádné finální fotky
            fin_fp = [fingerprint(os.path.join(src_dir, f)) for f in finals]
            extra, dropped = [], 0
            for f in files:
                if f in finals: continue
                fp = fingerprint(os.path.join(src_dir, f))
                if min(distance(fp, g) for g in fin_fp) < DUP_THRESHOLD: dropped += 1
                else: extra.append(f)
            print(f"  {p['slug']}: finálních {len(finals)}, bonusových DSC {len(extra)}, vyřazeno duplicit {dropped}", file=sys.stderr)
            files = sorted(finals + extra)
        else:
            files = finals
    out_dir = os.path.join(ROOT, "images", "partneri-fotky", p["slug"])
    shutil.rmtree(out_dir, ignore_errors=True); os.makedirs(out_dir)
    photos = []
    with tempfile.TemporaryDirectory() as tmp:
        for f in list(files):
            base = os.path.splitext(f)[0]
            small = os.path.join(tmp, base + ".jpg")
            out = os.path.join(out_dir, base + ".webp")
            try:
                run(["sips", "-Z", str(THUMB_PX), "-s", "format", "jpeg", os.path.join(src_dir, f), "--out", small])
                run([CWEBP, "-q", str(THUMB_Q), small, "-o", out])
                w, h = webp_dims(out)
            except Exception as ex:
                # vadný/nedokopírovaný soubor: vynechat z galerie i ZIPu a nahlásit, ale nezastavit celý běh
                print(f"  !! {p['slug']}: přeskakuji {f} ({type(ex).__name__})", file=sys.stderr)
                files.remove(f)
                if os.path.exists(out): os.remove(out)
                continue
            photos.append(dict(src=f"/images/partneri-fotky/{p['slug']}/{base}.webp", w=w, h=h, name=f))
    return photos, src_dir, files

def existing_photos(p):
    """Seznam fotek z už vygenerovaných náhledů (pro režim --html, kdy se mění jen text/šablona)."""
    out_dir = os.path.join(ROOT, "images", "partneri-fotky", p["slug"])
    photos = []
    for f in sorted(os.listdir(out_dir)):
        if not f.endswith(".webp"): continue
        w, h = webp_dims(os.path.join(out_dir, f))
        photos.append(dict(src=f"/images/partneri-fotky/{p['slug']}/{f}", w=w, h=h, name=f[:-5] + ".jpg"))
    zpath = os.path.join(ROOT, "files", "partneri", f"caf-2026-{p['slug']}.zip")
    return photos, f"/files/partneri/caf-2026-{p['slug']}.zip", round(os.path.getsize(zpath) / 1024 / 1024, 1)

def build_zip(p, src_dir, files):
    zdir = os.path.join(ROOT, "files", "partneri"); os.makedirs(zdir, exist_ok=True)
    zpath = os.path.join(zdir, f"caf-2026-{p['slug']}.zip")
    with tempfile.TemporaryDirectory() as tmp:
        pack = os.path.join(tmp, f"cica-art-fest-2026-{p['slug']}")
        os.makedirs(os.path.join(pack, "fotky"))
        for f in files:
            dst = os.path.join(pack, "fotky", f"cica-art-fest-2026-{os.path.splitext(f)[0]}.jpg")
            if ZIP_MAX_PX:
                run(["sips", "-Z", str(ZIP_MAX_PX), "-s", "format", "jpeg", "-s", "formatOptions", str(ZIP_Q),
                     os.path.join(src_dir, f), "--out", dst])
            else:
                shutil.copy2(os.path.join(src_dir, f), dst)
        with open(os.path.join(pack, "README.txt"), "w", encoding="utf-8") as fh:
            fh.write(f"""ČÍČA ART FEST 2026 — FOTKY PRO PARTNERA: {p['name'].upper()}
{'=' * (40 + len(p['name']))}

Fotografie z prvního ročníku Číča Art Festu (28. 8. 2026, CO.LABS Brno),
na kterých je vidět vaše účast. Volně je používejte na webu, sociálních
sítích i v tištěných materiálech.

Při zveřejnění prosíme uvádět kredit:
Foto: Adelice (Instagram @adelice_foto)

Budeme rádi, když k fotkám označíte @cicaartfest a @podrazdena_cica.

Kontakt: David Koutný, jsem@podrazdenacica.cz, +420 732 227 989
""")
        if os.path.exists(zpath): os.remove(zpath)
        run(["ditto", "-c", "-k", "--keepParent", pack, zpath])
    return f"/files/partneri/caf-2026-{p['slug']}.zip", round(os.path.getsize(zpath) / 1024 / 1024, 1)

def render(p, photos, zip_url, zip_mb):
    e = html.escape
    lw, lh = logo_dims(p["logo"]) if p["logo"] else (400, 200)
    logo_block = (
        f'<a class="pt-logo{" pt-logo--square" if p["square"] else ""}" href="{e(p["web"])}" target="_blank" rel="noopener">'
        f'<img src="{e(p["logo"])}" alt="{e(p["name"])}" width="{lw}" height="{lh}"></a>'
        if p["logo"] and p["web"] else
        (f'<div class="pt-logo{" pt-logo--square" if p["square"] else ""}"><img src="{e(p["logo"])}" alt="{e(p["name"])}" width="{lw}" height="{lh}"></div>'
         if p["logo"] else "")
    )
    web_line = f' · <a href="{e(p["web"])}" target="_blank" rel="noopener">{e(re.sub(r"^https?://(www\\.)?|/$", "", p["web"]))}</a>' if p["web"] else ""
    gallery = "\n".join(
        f'                <a class="pt-photo" href="{ph["src"]}" data-name="{e(ph["name"])}">'
        f'<img src="{ph["src"]}" alt="Číča Art Fest 2026, foto {i + 1}" loading="lazy" decoding="async" width="{ph["w"]}" height="{ph["h"]}"></a>'
        for i, ph in enumerate(photos))
    n = len(photos)
    fotek = "fotka" if n == 1 else ("fotky" if n < 5 else "fotek")
    mb = str(zip_mb).replace(".", ",")
    title = f"Díky, {p['name']} | Číča Art Fest 2026"
    drive_url = p.get("drive") or DRIVE_ALBUM_URL
    drive_label = "Plné rozlišení na Google Disku" if p.get("drive") else "Celé album z festu (Google Fotky)"
    drive_block = (f'<a href="{e(drive_url)}" target="_blank" rel="noopener" class="btn-secondary">{drive_label}</a>'
                   if drive_url else "")

    return f"""<!DOCTYPE html>
<html lang="cs">
<head>
    <!-- Google Tag Manager -->
    <script>(function(w,d,s,l,i){{w[l]=w[l]||[];w[l].push({{'gtm.start':
    new Date().getTime(),event:'gtm.js'}});var f=d.getElementsByTagName(s)[0],
    j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
    'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
    }})(window,document,'script','dataLayer','GTM-PBTC7F4W');</script>
    <!-- End Google Tag Manager -->
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>{e(title)}</title>
    <meta name="description" content="Poděkování partnerovi Číča Art Festu 2026, čísla festivalu a fotky ke stažení.">

    <meta property="og:title" content="{e(title)}">
    <meta property="og:description" content="Jak dopadl první ročník a vaše fotky z festu ke stažení.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://www.podrazdenacica.cz/cica-art-fest/partneri/{p['slug']}">
    <meta property="og:image" content="https://www.podrazdenacica.cz/images/og-caf-media.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">

    <link rel="icon" type="image/png" href="/podrazdenacica/my-favicon/favicon-96x96.png" sizes="96x96" />
    <link rel="icon" type="image/svg+xml" href="/podrazdenacica/my-favicon/favicon.svg" />
    <link rel="shortcut icon" href="/podrazdenacica/my-favicon/favicon.ico" />
    <link rel="apple-touch-icon" sizes="180x180" href="/podrazdenacica/my-favicon/apple-touch-icon.png" />

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=DM+Sans:wght@400;500;700&display=swap">
    <link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
    <noscript><link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet"></noscript>

    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){{dataLayer.push(arguments);}}
        function loadGA() {{
            var script = document.createElement('script');
            script.async = true;
            script.src = 'https://www.googletagmanager.com/gtag/js?id=G-R06FFJPHLK';
            document.head.appendChild(script);
            gtag('js', new Date());
            gtag('config', 'G-R06FFJPHLK');
        }}
        if (localStorage.getItem('cookieConsent') === 'accepted') {{ loadGA(); }}
    </script>

    <link rel="stylesheet" href="/css/style.css">
    <style>
        /* Odkazy v textu jednotně růžové i po navštívení */
        #main-content p a, #main-content p a:visited, #main-content figcaption a, #main-content figcaption a:visited {{
            color: var(--accent-neon); text-decoration: underline;
        }}
        .pt-lead {{ max-width: 780px; margin: 0 auto 1.2rem; font-size: 1.15rem; line-height: 1.7; color: rgba(255,255,255,0.9); }}
        .pt-lead strong {{ color: var(--accent-neon); }}
        .pt-section {{ padding: 4rem 0; }}
        .pt-note {{ max-width: 780px; margin: 0 auto; color: rgba(255,255,255,0.6); font-size: 0.95rem; }}

        /* Logo festu s bublinou ročníku (stejné jako na fest stránce, jen staticky) */
        .pt-festlogo {{ position: relative; width: 240px; margin: 0 0 1.8rem; filter: drop-shadow(0 0 26px rgba(254, 69, 232, 0.25)); }}
        .pt-festlogo img {{ width: 100%; height: auto; display: block; }}
        .pt-festlogo-tag {{
            position: absolute; right: -10px; bottom: -4px;
            background: var(--accent-neon); color: #0D0D0D; font-family: 'Archivo Black', sans-serif;
            font-size: 1.15rem; line-height: 1; padding: 9px 15px; border-radius: 999px;
            transform: rotate(-8deg); box-shadow: 0 0 18px rgba(254, 69, 232, 0.5);
        }}

        /* Reelska: náhled u nás, přehrání na Instagramu (stejné jako na tiskové stránce) */
        .reel-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 260px)); gap: 18px; justify-content: center; }}
        .reel-card {{ position: relative; display: block; border-radius: 16px; overflow: hidden; border: 1px solid var(--accent-neon);
            box-shadow: 0 0 22px rgba(254, 69, 232, 0.16); aspect-ratio: 9 / 16; background: var(--bg-card); text-decoration: none; }}
        .reel-card img {{ width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.4s ease; }}
        .reel-card:hover img {{ transform: scale(1.05); }}
        .reel-play {{ position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 62px; height: 62px; border-radius: 50%;
            background: rgba(13, 13, 13, 0.6); border: 2px solid var(--accent-neon); display: flex; align-items: center; justify-content: center;
            transition: background 0.25s ease, transform 0.25s ease; }}
        .reel-play::after {{ content: ''; margin-left: 4px; border-left: 16px solid var(--accent-neon); border-top: 10px solid transparent; border-bottom: 10px solid transparent; }}
        .reel-card:hover .reel-play {{ background: var(--accent-neon); transform: translate(-50%, -50%) scale(1.08); }}
        .reel-card:hover .reel-play::after {{ border-left-color: #0D0D0D; }}
        .reel-title {{ position: absolute; inset: auto 0 0 0; padding: 16px 14px; font-size: 0.92rem; font-weight: 700; line-height: 1.35; color: #FFFFFF;
            text-align: left; background: linear-gradient(to top, rgba(13, 13, 13, 0.94), rgba(13, 13, 13, 0)); }}

        /* Logo partnera v úvodu */
        .pt-logo {{
            display: inline-flex; align-items: center; justify-content: center;
            background: #fff; border-radius: 14px; padding: 18px 28px; margin: 0 0 1.6rem;
            transition: box-shadow 0.3s ease;
        }}
        .pt-logo:hover {{ box-shadow: 0 0 24px rgba(254, 69, 232, 0.35); }}
        .pt-logo img {{ height: 70px; width: auto; max-width: 260px; object-fit: contain; }}
        .pt-logo--square {{ padding: 12px 28px; }}
        .pt-logo--square img {{ height: 110px; }}

        /* Fakta */
        .facts-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; max-width: 1000px; margin: 0 auto; }}
        .fact-tile {{ background: rgba(255,255,255,0.04); border: 1px solid rgba(254,69,232,0.25); border-radius: 12px; padding: 1.5rem 1.2rem; text-align: center; }}
        .fact-number {{ font-family: 'Archivo Black', sans-serif; font-size: 1.9rem; color: var(--accent-neon); display: block; margin-bottom: 0.4rem; line-height: 1.1; }}
        .fact-label {{ color: rgba(255,255,255,0.75); font-size: 0.95rem; }}

        /* Citace */
        .pt-quotes {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.2rem; max-width: 1000px; margin: 2rem auto 0; }}
        .pt-quote {{ background: rgba(254,69,232,0.06); border-left: 3px solid var(--accent-neon); border-radius: 0 12px 12px 0; padding: 1.2rem 1.4rem; }}
        .pt-quote blockquote {{ font-size: 1.05rem; line-height: 1.55; color: #fff; margin-bottom: 0.5rem; }}
        .pt-quote cite {{ color: rgba(255,255,255,0.6); font-style: normal; font-size: 0.9rem; }}

        /* Galerie: jednotné dlaždice, oříznuté do 4:5, plná fotka v lightboxu a v ZIPu */
        .pt-gallery {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; max-width: 1000px; margin: 0 auto; }}
        .pt-photo {{ display: block; aspect-ratio: 4 / 5; overflow: hidden; border-radius: 10px; background: rgba(255,255,255,0.04); }}
        .pt-photo img {{ width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.35s ease; }}
        .pt-photo:hover img {{ transform: scale(1.04); }}
        .pt-download {{ max-width: 780px; margin: 2rem auto 0; text-align: center; }}
        .pt-download p {{ color: rgba(255,255,255,0.75); margin-bottom: 1rem; line-height: 1.6; }}

        /* Ročník 2027 */
        .pt-cta {{ max-width: 780px; margin: 0 auto; background: rgba(255,255,255,0.04); border: 1px solid rgba(254,69,232,0.35); border-radius: 14px; padding: 2.2rem 2rem; text-align: center; }}
        .pt-cta p {{ color: rgba(255,255,255,0.85); line-height: 1.65; margin-bottom: 1rem; }}
        .pt-cta .contact-row {{ font-size: 1.1rem; }}
        .pt-cta a {{ color: var(--accent-neon); }}

        /* Lightbox s listováním */
        .lightbox {{ position: fixed; inset: 0; background: rgba(13,13,13,0.94); display: none; align-items: center; justify-content: center; z-index: 9999; padding: 2vh 2vw; cursor: zoom-out; touch-action: pan-y; }}
        .lightbox.open {{ display: flex; }}
        .lightbox img {{ max-width: 100%; max-height: 90vh; border-radius: 8px; box-shadow: 0 20px 80px rgba(255,0,255,0.25); user-select: none; }}
        .lb-btn {{ position: absolute; top: 50%; transform: translateY(-50%); width: 52px; height: 52px; border-radius: 50%; border: 2px solid var(--accent-neon);
            background: rgba(13,13,13,0.6); color: var(--accent-neon); font-size: 1.6rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
            transition: background 0.2s ease, color 0.2s ease; }}
        .lb-btn:hover {{ background: var(--accent-neon); color: #0D0D0D; }}
        .lb-prev {{ left: 16px; }} .lb-next {{ right: 16px; }}
        .lb-close {{ top: 16px; right: 16px; transform: none; width: 44px; height: 44px; font-size: 1.3rem; }}
        .lb-count {{ position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,0.7); font-size: 0.9rem; letter-spacing: 0.06em; }}
        @media (max-width: 600px) {{ .lb-btn {{ width: 42px; height: 42px; font-size: 1.3rem; }} .lb-prev {{ left: 8px; }} .lb-next {{ right: 8px; }} }}

        @media (max-width: 600px) {{
            .fact-number {{ font-size: 1.5rem; }}
            .pt-gallery {{ grid-template-columns: repeat(2, 1fr); gap: 8px; }}
            .pt-logo img {{ height: 60px; max-width: 200px; }}
            .pt-logo--square img {{ height: 96px; }}
        }}
    </style>
</head>
<body>
    <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-PBTC7F4W" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
    <a href="#main-content" class="skip-link">Přeskočit na obsah</a>
    <header id="top">
        <div class="header-content">
            <a href="/" class="logo-link">
                <picture>
                    <source srcset="/images/logo.webp" type="image/webp">
                    <img src="/images/logo.png" alt="Podrážděná Číča" class="logo-image" width="154" height="140" fetchpriority="high">
                </picture>
            </a>
            <nav>
                <ul class="nav-links">
                    <li><a href="/#art">Art</a></li>
                    <li><a href="/hrave-nudesky">Hravé nudesky <span class="nav-badge">Hot & new</span></a></li>
                    <li><a href="/cica-art-fest">Číča Art Fest</a></li>
                    <li><a href="/#words">Slova</a></li>
                    <li><a href="/#podcast">Podcast</a></li>
                    <li><a href="/#collab">Spolupráce</a></li>
                    <li><a href="/#contact">Kontakt</a></li>
                </ul>
                <div class="social-icons">
                    <a href="https://www.instagram.com/podrazdena_cica/" target="_blank" rel="noopener" aria-label="Instagram">📷</a>
                    <a href="https://linkedin.com/in/podrazdenacica/" target="_blank" rel="noopener" aria-label="LinkedIn">💼</a>
                </div>
            </nav>
            <button class="burger" aria-label="Otevřít menu" aria-expanded="false"><span></span><span></span><span></span></button>
        </div>
    </header>
    <div class="mobile-menu" role="navigation" aria-label="Mobilní navigace">
        <ul>
            <li><a href="/#art">Art</a></li>
            <li><a href="/hrave-nudesky">Hravé nudesky <span class="nav-badge">Hot & new</span></a></li>
            <li><a href="/cica-art-fest">Číča Art Fest</a></li>
            <li><a href="/#words">Slova</a></li>
            <li><a href="/#podcast">Podcast</a></li>
            <li><a href="/#collab">Spolupráce</a></li>
            <li><a href="/#contact">Kontakt</a></li>
        </ul>
    </div>

    <main id="main-content">

    <section id="pt-hero" class="page-hero">
        <div class="container">
            <div class="hero-text">
                <div class="pt-festlogo">
                    <img src="/images/caf-logo.webp" alt="Logo Číča Art Fest" width="520" height="471">
                    <span class="pt-festlogo-tag">2026</span>
                </div>
                {logo_block}
                <h1 class="hero-title">Díky, že jste do toho šli s náma!</h1>
                <p class="pt-lead">
                    {e(p['role'])} Bez vás by první ročník nevypadal tak, jak vypadal,
                    a proto vám tady posíláme čísla, krátký report a všechny fotky, na kterých jste vidět.
                </p>
            </div>
        </div>
    </section>

    <section class="pt-section" style="background: rgba(255,255,255,0.02);">
        <div class="container">
            <h2 class="section-title reveal">Fest v číslech</h2>
            <div class="facts-grid reveal">
                <div class="fact-tile"><span class="fact-number">88 866 Kč</span><span class="fact-label">celkový výtěžek benefiční aukce</span></div>
                <div class="fact-tile"><span class="fact-number">46 666 Kč</span><span class="fact-label">cena nejdražšího díla večera</span></div>
                <div class="fact-tile"><span class="fact-number">4</span><span class="fact-label">podpořené neziskovky a útulky</span></div>
                <div class="fact-tile"><span class="fact-number">150+</span><span class="fact-label">návštěvníků prvního ročníku</span></div>
                <div class="fact-tile"><span class="fact-number">13</span><span class="fact-label">obrazů v sérii Královny Brno-venkov</span></div>
                <div class="fact-tile"><span class="fact-number">9</span><span class="fact-label">odvážných žen na mole módní přehlídky</span></div>
            </div>
        </div>
    </section>

    <section class="pt-section">
        <div class="container">
            <h2 class="section-title reveal">Jak to dopadlo</h2>
            <p class="pt-lead reveal">
                První ročník Číča Art Festu proběhl v pátek <strong>28. srpna 2026</strong> v areálu CO.LABS v Brně
                a přišlo na něj <strong>přes 150 lidí</strong>. Program spojil vernisáž první obrazové série
                Královny Brno-venkov, panelovou diskuzi o ženské psychice a sexualitě, stand-up, hudební vystoupení,
                design market českých značek a umělců, módní přehlídku devíti žen, z nichž ani jedna nebyla
                profesionální modelka, a závěrečnou show drag queen Miss Petty.
            </p>
            <p class="pt-lead reveal">
                Benefiční aukce deseti děl vynesla <strong>88 866 Kč</strong>. Na dobročinné účely putuje
                73 116 Kč, tedy <strong>82 % výtěžku</strong>, mezi pacientský spolek LYMFOM HELP, Nadaci Veronica,
                Opuštěné kočičí tlapky a Útulok Tuláčik Brezno.
            </p>
            <p class="pt-lead reveal">
                Vaše logo bylo na webu festivalu, na tištěném letáku a je i na
                <a href="/cica-art-fest/media">tiskové stránce pro média</a>, kterou jsme zaslali redakcím.
                Tam najdete i kompletní přehled děl z aukce a ohlasy vystupujících.
            </p>
            <div class="pt-quotes">
                <div class="pt-quote reveal">
                    <blockquote>„Akcička na pomezí sesterství a erotiky, která v Brně chyběla."</blockquote>
                    <cite>Olga Vlachynská, terapeutka a panelistka</cite>
                </div>
                <div class="pt-quote reveal">
                    <blockquote>„Burning man, teda vlastně Burning cat, verze Brno-venkov."</blockquote>
                    <cite>návštěvník festivalu</cite>
                </div>
                <div class="pt-quote reveal">
                    <blockquote>„Mňauózní zážitek – to se nedá popsat, to se musí zažít."</blockquote>
                    <cite>Zuzka od Rosic, návštěvnice</cite>
                </div>
            </div>
            <div class="hero-buttons reveal" style="justify-content: center; margin-top: 1.8rem;">
                <a href="/reference" class="btn-secondary">Všechny ohlasy návštěvníků a vystupujících</a>
            </div>
        </div>
    </section>

    <!-- Videoreport: tři reelsy, stejný zdroj jako tisková stránka -->
    <section id="videa" class="pt-section" style="background: rgba(255,255,255,0.02);" hidden>
        <div class="container">
            <h2 class="section-title reveal">Fest ve videích</h2>
            <p class="pt-note reveal" style="margin-bottom: 2rem; text-align: center;">
                Krátké reportáže z prvního ročníku. Přehrají se na Instagramu.
            </p>
            <div class="reel-grid" id="reelGrid"></div>
        </div>
    </section>

    <section id="fotky" class="pt-section">
        <div class="container">
            <h2 class="section-title reveal">Vaše fotky z festu</h2>
            <p class="pt-note reveal" style="text-align: center; margin-bottom: 2rem;">
                {n} {fotek}, na kterých je vidět vaše účast. Kliknutím se otevřou větší a dají se listovat. Balíček níže je ve verzi pro web a sociální sítě (1600 px).
            </p>
            <div class="pt-gallery">
{gallery}
            </div>
            <div class="pt-download reveal">
                <p>
                    Fotky můžete volně používat na webu, na sociálních sítích i v tisku. Prosíme jen o kredit
                    <strong>Foto: Adelice (<a href="https://www.instagram.com/adelice_foto/" target="_blank" rel="noopener">@adelice_foto</a>)</strong>
                    a budeme rádi za označení <a href="https://www.instagram.com/cicaartfest/" target="_blank" rel="noopener">@cicaartfest</a>.
                </p>
                <div class="hero-buttons" style="justify-content: center;">
                    <a href="{zip_url}" class="btn-primary">Stáhnout všech {n} {fotek} (ZIP, {mb} MB) 📦</a>
                    {drive_block}
                </div>
            </div>
        </div>
    </section>

    <section class="pt-section" style="background: rgba(255,255,255,0.02);">
        <div class="container">
            <h2 class="section-title reveal">Pojďme do toho znovu</h2>
            <div class="pt-cta reveal">
                <p>
                    Druhý ročník chystáme na rok 2027 a moc rádi bychom v něm měli <strong>{e(p['name'])}</strong> znovu.
                    Ozveme se s pořádným předstihem, ale kdykoli dřív stačí napsat nebo zavolat.
                </p>
                <p class="contact-row"><strong>Kristýna Mlynář Koutná &amp; David Koutný (MLYKO)</strong>, pořadatelé festivalu</p>
                <p class="contact-row">📧 <a href="mailto:jsem@podrazdenacica.cz?subject=%C4%8C%C3%AD%C4%8Da%20Art%20Fest%202027">jsem@podrazdenacica.cz</a></p>
                <p class="contact-row">📞 <a href="tel:+420732227989">+420 732 227 989</a></p>
                <p style="margin-top: 1.4rem; color: rgba(255,255,255,0.6);">
                    Ještě jednou díky. Bylo to mňauózní, mňau ₍^. .^₎⟆
                </p>
            </div>
        </div>
    </section>
    </main>

    <div class="lightbox" id="lightbox" role="dialog" aria-label="Zvětšená fotka">
        <button class="lb-btn lb-close" type="button" aria-label="Zavřít">✕</button>
        <button class="lb-btn lb-prev" type="button" aria-label="Předchozí fotka">‹</button>
        <img src="" alt="">
        <button class="lb-btn lb-next" type="button" aria-label="Další fotka">›</button>
        <span class="lb-count" aria-live="polite"></span>
    </div>

    <footer id="footer">
        <div class="footer-content">
            <div class="footer-text">© <span id="currentYear"></span> Podrážděná číča</div>
            <div class="footer-links">
                <a href="/cica-art-fest">Číča Art Fest</a>
                <a href="/podminky">Cookies</a>
                <a href="/podminky">Podmínky</a>
            </div>
            <div class="footer-tagline">Nech si mě v hlavě. Mňau.</div>
        </div>
    </footer>

    <script>
        requestAnimationFrame(() => {{
            const burger = document.querySelector('.burger');
            const mobileMenu = document.querySelector('.mobile-menu');
            burger.addEventListener('click', () => {{
                burger.classList.toggle('active'); mobileMenu.classList.toggle('active');
                const open = burger.classList.contains('active');
                burger.setAttribute('aria-expanded', open);
                burger.setAttribute('aria-label', open ? 'Zavřít menu' : 'Otevřít menu');
            }});
            document.addEventListener('click', (ev) => {{
                if (mobileMenu.classList.contains('active') && !mobileMenu.contains(ev.target) && !burger.contains(ev.target)) {{
                    burger.classList.remove('active'); mobileMenu.classList.remove('active');
                    burger.setAttribute('aria-expanded', 'false');
                }}
            }});

            const reveals = document.querySelectorAll('.reveal');
            const io = new IntersectionObserver((entries) => {{
                entries.forEach(en => {{ if (en.isIntersecting) {{ en.target.classList.add('active'); io.unobserve(en.target); }} }});
            }}, {{ threshold: 0.1, rootMargin: '0px 0px -50px 0px' }});
            reveals.forEach(el => io.observe(el));

            // Lightbox s listováním (šipky, klávesy, swipe)
            const lb = document.getElementById('lightbox'), lbImg = lb.querySelector('img'), lbCount = lb.querySelector('.lb-count');
            const photos = [...document.querySelectorAll('.pt-photo')];
            let cur = -1;
            const show = (i) => {{
                cur = (i + photos.length) % photos.length;
                const a = photos[cur];
                lbImg.src = a.getAttribute('href'); lbImg.alt = a.querySelector('img').alt;
                lbCount.textContent = (cur + 1) + ' / ' + photos.length;
                // přednačíst sousedy, ať listování nečeká
                [cur + 1, cur - 1].forEach(j => {{ const n = photos[(j + photos.length) % photos.length]; if (n) new Image().src = n.getAttribute('href'); }});
            }};
            const openLb = (i) => {{ show(i); lb.classList.add('open'); document.body.style.overflow = 'hidden'; }};
            const closeLb = () => {{ lb.classList.remove('open'); document.body.style.overflow = ''; lbImg.src = ''; cur = -1; }};
            photos.forEach((a, i) => a.addEventListener('click', (ev) => {{ ev.preventDefault(); openLb(i); }}));
            lb.querySelector('.lb-prev').addEventListener('click', (ev) => {{ ev.stopPropagation(); show(cur - 1); }});
            lb.querySelector('.lb-next').addEventListener('click', (ev) => {{ ev.stopPropagation(); show(cur + 1); }});
            lb.querySelector('.lb-close').addEventListener('click', (ev) => {{ ev.stopPropagation(); closeLb(); }});
            lbImg.addEventListener('click', (ev) => {{ ev.stopPropagation(); show(cur + 1); }});
            lb.addEventListener('click', closeLb);
            document.addEventListener('keydown', (ev) => {{
                if (!lb.classList.contains('open')) return;
                if (ev.key === 'Escape') closeLb();
                else if (ev.key === 'ArrowRight') show(cur + 1);
                else if (ev.key === 'ArrowLeft') show(cur - 1);
            }});
            let tx = null;
            lb.addEventListener('touchstart', (ev) => {{ tx = ev.touches[0].clientX; }}, {{ passive: true }});
            lb.addEventListener('touchend', (ev) => {{
                if (tx === null) return; const dx = ev.changedTouches[0].clientX - tx; tx = null;
                if (Math.abs(dx) > 40) show(cur + (dx < 0 ? 1 : -1));
            }}, {{ passive: true }});

            // Reelska z Instagramu: stejný zdroj jako tisková stránka
            fetch('/api/instagram').then(r => r.json()).then(d => {{
                const reels = (d && d.reels) || [];
                if (!reels.length) return;
                const grid = document.getElementById('reelGrid');
                for (const r of reels) {{
                    const a = document.createElement('a');
                    a.className = 'reel-card'; a.href = r.permalink; a.target = '_blank'; a.rel = 'noopener';
                    const img = document.createElement('img'); img.src = r.image; img.loading = 'lazy'; img.alt = r.caption || 'Video z Číča Art Festu';
                    const play = document.createElement('span'); play.className = 'reel-play';
                    const t = document.createElement('span'); t.className = 'reel-title'; t.textContent = r.title;
                    a.append(img, play, t); grid.append(a);
                }}
                document.getElementById('videa').hidden = false;
            }}).catch(() => {{}});

            document.getElementById('currentYear').textContent = new Date().getFullYear();
        }});
    </script>
</body>
</html>
"""

def main():
    out_dir = os.path.join(ROOT, "cica-art-fest", "partneri"); os.makedirs(out_dir, exist_ok=True)
    args = sys.argv[1:]
    html_only = "--html" in args           # jen HTML z hotových náhledů/ZIPů (změna textu či šablony)
    only = set(a for a in args if not a.startswith("--"))
    for p in PARTNERS:
        if only and p["slug"] not in only: continue
        if html_only:
            photos, zip_url, zip_mb = existing_photos(p)
        else:
            photos, src_dir, files = build_photos(p)
            zip_url, zip_mb = build_zip(p, src_dir, files)
        with open(os.path.join(out_dir, p["slug"] + ".html"), "w", encoding="utf-8") as fh:
            fh.write(render(p, photos, zip_url, zip_mb))
        print(f"{p['slug']:<26} {len(photos):>3} fotek  ZIP {zip_mb} MB")

if __name__ == "__main__":
    main()
