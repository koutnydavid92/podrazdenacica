// Oslovení v 5. pádě pro křestní jména (Kristýna -> Kristýno, Petr -> Petře).
// Pravidlový převod pro běžná česká jména; cizí a neznámá jména nechává být.
// Používá se v mailech obchodu (api/_email.js). Stejná logika je zkopírovaná
// do onanovanky-dekuji.html pro děkovací stránku - při změně upravit obě.

// Ženská jména končící souhláskou se neskloňují (Dagmar, Ingrid, Ester...)
const FEMALE_CONSONANT = new Set([
    'dagmar', 'ingrid', 'ester', 'miriam', 'karin', 'nikol', 'doris', 'ruth', 'kim',
    'ellen', 'carmen', 'lilien', 'vivien', 'elen', 'sharon', 'judit', 'edit',
    'margit', 'marlen', 'iris', 'gudrun', 'astrid', 'sigrid', 'hedvig', 'noemi',
    'naomi', 'rut', 'agnes', 'ines', 'inés', 'mercedes', 'dolores', 'karen'
]);

// Nepravidelná a častá jména, kde pravidlo nestačí
const IRREGULAR = {
    'petr': 'Petře', 'pavel': 'Pavle', 'karel': 'Karle', 'zdeněk': 'Zdeňku',
    'daniel': 'Danieli', 'gabriel': 'Gabrieli', 'samuel': 'Samueli', 'rafael': 'Rafaeli',
    'emanuel': 'Emanueli', 'jiří': 'Jiří', 'ondřej': 'Ondřeji', 'matěj': 'Matěji',
    'vojtěch': 'Vojtěchu', 'bedřich': 'Bedřichu', 'jindřich': 'Jindřichu',
    'jakub': 'Jakube', 'josef': 'Josefe', 'alexandr': 'Alexandře', 'vavřinec': 'Vavřinče',
    'mojmír': 'Mojmíre', 'vladimír': 'Vladimíre', 'lubomír': 'Lubomíre', 'jaromír': 'Jaromíre',
    'lubos': 'Luboši', 'luboš': 'Luboši', 'tomas': 'Tomáši', 'lukas': 'Lukáši', 'jiri': 'Jiří',
    'vit': 'Víte', 'stepan': 'Štěpáne', 'ondrej': 'Ondřeji', 'matej': 'Matěji', 'zdenek': 'Zdeňku',
    'marie': 'Marie', 'lucie': 'Lucie', 'julie': 'Julie', 'sofie': 'Sofie', 'natálie': 'Natálie',
    'natalie': 'Natálie', 'amálie': 'Amálie', 'rozálie': 'Rozálie', 'emílie': 'Emílie',
    'nikola': 'Nikolo', 'míša': 'Míšo', 'saša': 'Sašo', 'nikita': 'Nikito'
};

function vokativ(firstName) {
    const raw = String(firstName || '').trim().split(/\s+/)[0] || '';
    if (!raw) return '';
    const key = raw.toLowerCase();
    if (IRREGULAR[key]) return IRREGULAR[key];
    if (FEMALE_CONSONANT.has(key)) return raw;
    const last = key.slice(-1);
    const beforeLast = key.slice(-2, -1);
    const vowels = 'aeiouyáéíóúůýě';

    // -a -> -o (Jana -> Jano, Honza -> Honzo, Lenka -> Lenko)
    if (last === 'a') return raw.slice(0, -1) + 'o';
    // samohláska na konci: beze změny (Marie, René, Bruno, Jiří, Toni)
    if (vowels.includes(last)) return raw;

    // mužská jména na souhlásku
    if (key.endsWith('něk')) return raw.slice(0, -3) + 'ňku';
    if (key.endsWith('ek')) return raw.slice(0, -2) + 'ku';        // Marek -> Marku, Radek -> Radku
    if (key.endsWith('ec')) return raw.slice(0, -2) + 'če';        // Vavřinec -> Vavřinče
    if (key.endsWith('ch') || last === 'k' || last === 'h' || last === 'g') return raw + 'u';
    if (last === 'r') return vowels.includes(beforeLast) ? raw + 'e' : raw.slice(0, -1) + 'ře'; // Igor -> Igore, Petr -> Petře
    if (key.endsWith('iel') || key.endsWith('uel') || key.endsWith('ael')) return raw + 'i';
    if (key.endsWith('vel') || key.endsWith('rel')) return raw.slice(0, -2) + 'le';            // Pavel -> Pavle
    if (last === 'l') return raw + 'e';                            // Michal -> Michale, Kamil -> Kamile
    if ('šžčřjcsxz'.includes(last)) return raw + 'i';               // Lukáš -> Lukáši, Ondřej -> Ondřeji, Denis -> Denisi
    return raw + 'e';                                               // Martin -> Martine, David -> Davide, Adam -> Adame
}

module.exports = { vokativ };
