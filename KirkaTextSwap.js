// ==UserScript==
// @name         Kirka Texture Swapper (Minimal)
// @version      1.3.1
// @description  Skin-only texture swapper. Ctrl+O menu.
// @author       npa
// @connect      raw.githubusercontent.com
// @connect      kirka.io
// @connect      kirka.lukeskywalk.com
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.3.1';
    const EXPANDED_WEAPON_KEY = 'kirka-ts-expanded-weapon';
    const MENU_TAB_KEY = 'kirka-ts-menu-tab';
    const USER_EXTRA_SKINS_KEY = 'kirka-user-extra-skins-v1';
    const SKINS_JSON_URL = 'https://raw.githubusercontent.com/nnapkin12/scripts-and-projects/main/skins.json';
    const SKINS_CACHE_KEY = 'kirka-swapper-skins-v2';
    const SKINS_VERSION_KEY = 'kirka-swapper-skins-version';
    const TEXTURE_CDN = 'https://kirka.io/assets/img/';
    const TEXTURE_FILE_RE = /texture\.[a-f0-9]+\.webp/i;

    const WEAPON_REGISTRY = {
        bayonet:  { label: 'Bayonet',  tab: 'melee' },
        tomahawk: { label: 'Tomahawk', tab: 'melee' },
        lar:      { label: 'LAR',      tab: 'guns' },
        ar9:      { label: 'AR-9',     tab: 'guns' },
        wheatie:  { label: 'Wheatie',  tab: 'guns' },
        mac10:    { label: 'Mac-10',   tab: 'guns' },
        scar:     { label: 'Scar',     tab: 'guns' },
        vita:     { label: 'Vita',     tab: 'guns' },
        shark:    { label: 'Shark',    tab: 'guns' },
        m60:      { label: 'M60',      tab: 'guns' },
        revolver: { label: 'Revolver', tab: 'guns' },
    };

    const MELEE_ORDER = ['bayonet', 'tomahawk'];
    const GUN_ORDER = ['ar9', 'wheatie', 'mac10', 'scar', 'vita', 'shark', 'm60', 'revolver', 'lar'];
    const ALL_WEAPON_ORDER = MELEE_ORDER.concat(GUN_ORDER);

    const RENDER_WEAPON_FOLDER = {
        bayonet: 'Bayonet',
        tomahawk: 'Tomahawk',
        lar: 'LAR',
        ar9: 'AR-9',
        wheatie: 'Wheatie',
        mac10: 'Mac-10',
        scar: 'Scar',
        vita: 'Vita',
        shark: 'Shark',
        m60: 'M60',
        revolver: 'Revolver',
    };

    const RARITY_FROM_CODE = {
        0: 'Common',
        1: 'Rare',
        2: 'Epic',
        3: 'Legendary',
        4: 'Mythical',
        5: 'Paranormal',
    };

    const RARITY_COLOR = {
        Common: '#6fd08c',
        Rare: '#58b9ea',
        Epic: '#a335ee',
        Legendary: '#f5b82e',
        Mythical: '#ff2a2a',
        Paranormal: '#888',
    };

    let SKIN_DATABASE = {};
    let SKIN_RENDER_URLS = {};
    let swappableByWeapon = {};
    let skinsCatalogReady = false;

    const fileToWeapon = new Map();
    const glTexturesByWeapon = {};
    const textureSetsByWeapon = {};
    for (const id in WEAPON_REGISTRY) {
        glTexturesByWeapon[id] = new Set();
        textureSetsByWeapon[id] = new Set();
    }

    const glToEntry = new WeakMap();
    const textureSources = new WeakMap();
    const textureOriginalFile = new WeakMap();
    const textureWeapon = new WeakMap();
    const textureGlEntry = new WeakMap();
    const textureMipmapped = new WeakMap();
    const trackedGlTextures = new Set();
    const refreshBindExtras = new Set();
    const hookedGlEntries = [];
    let knifeBridgeUnregisters = [];
    let refreshWeaponFilter = null;

    const preloadedSwapImages = new Map();
    const decodedSwapImages = new Set();
    const textureReuploadQueue = [];
    let textureReuploadRaf = null;
    const TEXTURE_REUPLOADS_PER_FRAME = 1;
    const SWAP_IMAGE_CACHE_MAX = 48;

    function getStorage(key, fallback) {
        try {
            const saved = localStorage.getItem(key);
            if (saved === null) return fallback;
            return saved;
        } catch (_) {
            return fallback;
        }
    }

    function getSkinSwapStorageKey(weaponId) {
        return 'kirka-skin-swap-' + weaponId;
    }

    function buildSkinSwapCfg() {
        const skinSwap = {};
        for (const weaponId in WEAPON_REGISTRY) {
            skinSwap[weaponId] = getStorage(getSkinSwapStorageKey(weaponId), 'none');
        }
        return skinSwap;
    }

    const cfg = { skinSwap: buildSkinSwapCfg() };
    let anySwapActive = false;

    function recomputeAnySwapActive() {
        anySwapActive = false;
        for (const weaponId in WEAPON_REGISTRY) {
            const target = cfg.skinSwap[weaponId];
            if (target && target !== 'none') {
                anySwapActive = true;
                return;
            }
        }
    }

    recomputeAnySwapActive();

    function normalizeTextureFilename(file) {
        const match = String(file || '').match(TEXTURE_FILE_RE);
        return match ? match[0].toLowerCase() : null;
    }

    function extractTextureFilename(url) {
        if (!url) return null;
        const match = String(url).match(TEXTURE_FILE_RE);
        return match ? match[0].toLowerCase() : null;
    }

    function getCatalogVersion(payload) {
        if (!payload) return '';
        return String(payload.version || payload.generated || '');
    }

    function hydrateSkinCatalog(payload) {
        SKIN_DATABASE = {};
        SKIN_RENDER_URLS = {};
        if (!payload || !payload.skins) throw new Error('Invalid skins payload');

        swappableByWeapon = {};
        for (const weaponId in WEAPON_REGISTRY) {
            swappableByWeapon[weaponId] = { none: 'Equipped' };
        }

        for (const shortKey in payload.skins) {
            const row = payload.skins[shortKey];
            const hash = shortKey.indexOf('.webp') !== -1
                ? shortKey
                : ('texture.' + shortKey + '.webp');
            const flags = row[3] || 0;
            const entry = {
                weapon: row[0],
                name: row[1],
                rarity: RARITY_FROM_CODE[row[2]] || 'Mythical',
                swappable: !!(flags & 2),
            };
            SKIN_DATABASE[hash] = entry;
            if (entry.swappable && swappableByWeapon[entry.weapon]) {
                swappableByWeapon[entry.weapon][hash] = entry.name;
            }
        }

        const renders = payload.renders || {};
        const renderBases = payload.renderBases || null;
        for (const shortKey in renders) {
            const hash = shortKey.indexOf('.webp') !== -1
                ? shortKey
                : ('texture.' + shortKey + '.webp');
            const raw = renders[shortKey];
            if (typeof raw === 'string') {
                SKIN_RENDER_URLS[hash] = raw;
            } else if (Array.isArray(raw) && raw.length >= 2 && renderBases) {
                const base = renderBases[raw[0]];
                SKIN_RENDER_URLS[hash] = base ? (base + raw[1]) : '';
            }
        }

        syncTextureSets();
        applyUserExtraSkinsToDropdown();
    }

    let userExtraSkinsCache = null;
    let weaponLabelLookup = null;
    let menuShadow = null;
    let catalogSelectedHash = null;
    let catalogSelectedWeaponId = null;

    function loadUserExtraSkins() {
        if (userExtraSkinsCache) return userExtraSkinsCache;
        try {
            const raw = localStorage.getItem(USER_EXTRA_SKINS_KEY);
            userExtraSkinsCache = raw ? JSON.parse(raw) : {};
            if (!userExtraSkinsCache || typeof userExtraSkinsCache !== 'object') userExtraSkinsCache = {};
        } catch (_) {
            userExtraSkinsCache = {};
        }
        return userExtraSkinsCache;
    }

    function saveUserExtraSkins(data) {
        userExtraSkinsCache = data;
        try {
            localStorage.setItem(USER_EXTRA_SKINS_KEY, JSON.stringify(data));
        } catch (_) {}
    }

    function isSkinInBuiltInDropdown(weaponId, hash) {
        const file = normalizeTextureFilename(hash);
        const skin = file && SKIN_DATABASE[file];
        return !!(skin && skin.weapon === weaponId && skin.swappable);
    }

    function isSkinUserAdded(weaponId, hash) {
        const file = normalizeTextureFilename(hash);
        if (!file || !weaponId) return false;
        const data = loadUserExtraSkins();
        const list = data[weaponId];
        return !!(Array.isArray(list) && list.indexOf(file) !== -1);
    }

    function applyUserExtraSkinsToDropdown() {
        const data = loadUserExtraSkins();
        for (const weaponId in data) {
            if (!swappableByWeapon[weaponId]) continue;
            const list = data[weaponId];
            if (!Array.isArray(list)) continue;
            for (let i = 0; i < list.length; i++) {
                const hash = normalizeTextureFilename(list[i]);
                const skin = SKIN_DATABASE[hash];
                if (!skin || skin.weapon !== weaponId) continue;
                swappableByWeapon[weaponId][hash] = skin.name;
            }
        }
    }

    function addUserExtraSkin(weaponId, hash) {
        const file = normalizeTextureFilename(hash);
        const skin = SKIN_DATABASE[file];
        if (!skin || skin.weapon !== weaponId) return false;
        if (isSkinUserAdded(weaponId, file)) return false;
        if (isSkinInBuiltInDropdown(weaponId, file)) return false;
        const data = loadUserExtraSkins();
        if (!data[weaponId]) data[weaponId] = [];
        if (data[weaponId].indexOf(file) === -1) data[weaponId].push(file);
        saveUserExtraSkins(data);
        if (swappableByWeapon[weaponId]) swappableByWeapon[weaponId][file] = skin.name;
        return true;
    }

    function searchFullSkinCatalog(query, limit) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return [];
        const max = limit || 16;
        const matches = [];
        for (const hash in SKIN_DATABASE) {
            const skin = SKIN_DATABASE[hash];
            if (!skin || !WEAPON_REGISTRY[skin.weapon]) continue;
            const name = String(skin.name || '');
            const lower = name.toLowerCase();
            if (!lower.includes(q)) continue;
            let rank = 2;
            if (lower === q) rank = -1;
            else if (lower.startsWith(q)) rank = 0;
            else if (lower.endsWith(q)) rank = 1;
            matches.push({
                hash: hash,
                name: name,
                weaponId: skin.weapon,
                weaponLabel: WEAPON_REGISTRY[skin.weapon].label,
                rarity: skin.rarity,
                rank: rank,
            });
        }
        matches.sort(function (a, b) {
            if (a.rank !== b.rank) return a.rank - b.rank;
            return a.name.localeCompare(b.name);
        });
        return matches.slice(0, max);
    }

    function getFavStorageKey(weaponId) {
        return 'kirka-fav-' + weaponId;
    }

    function loadFavoriteSkins(storageKey) {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(function (k) { return k && k !== 'none'; });
        } catch (_) {
            return [];
        }
    }

    function saveFavoriteSkins(storageKey, keys) {
        try {
            localStorage.setItem(storageKey, JSON.stringify(keys));
        } catch (_) {}
    }

    function isFavoriteSkin(storageKey, key) {
        if (!key || key === 'none') return false;
        return loadFavoriteSkins(storageKey).indexOf(key) !== -1;
    }

    function toggleFavoriteSkin(storageKey, key) {
        if (!key || key === 'none') return false;
        const list = loadFavoriteSkins(storageKey);
        const idx = list.indexOf(key);
        if (idx === -1) {
            list.push(key);
            saveFavoriteSkins(storageKey, list);
            return true;
        }
        list.splice(idx, 1);
        saveFavoriteSkins(storageKey, list);
        return false;
    }

    function buildFavoritesOptions(allOptions, favoriteKeys) {
        const out = {};
        for (let i = 0; i < favoriteKeys.length; i++) {
            const k = favoriteKeys[i];
            if (allOptions[k]) out[k] = allOptions[k];
        }
        return out;
    }

    function buildWeaponLabelLookup() {
        const lookup = Object.create(null);
        for (const weaponId in WEAPON_REGISTRY) {
            lookup[weaponId] = weaponId;
            lookup[WEAPON_REGISTRY[weaponId].label.toLowerCase()] = weaponId;
        }
        for (const weaponId in RENDER_WEAPON_FOLDER) {
            lookup[RENDER_WEAPON_FOLDER[weaponId].toLowerCase()] = weaponId;
        }
        lookup['mac-10'] = 'mac10';
        lookup['ar-9'] = 'ar9';
        lookup['weatie'] = 'wheatie';
        weaponLabelLookup = lookup;
        return lookup;
    }

    function lookupWeaponIdByLabel(label) {
        if (!label) return null;
        if (!weaponLabelLookup) buildWeaponLabelLookup();
        return weaponLabelLookup[String(label).trim().toLowerCase()] || null;
    }

    function warmVisibleLoadoutSwaps() {
        if (!anySwapActive) return;
        document.querySelectorAll('#bottom-right .weapons-cont .weapon-name.text-1').forEach(function (el) {
            const weaponId = lookupWeaponIdByLabel((el.textContent || '').trim());
            if (!weaponId) return;
            const target = getSwapTargetForWeapon(weaponId);
            if (target && target !== 'none') preloadSwapTexture(target);
        });
    }

    function refreshAllSavedSwapWeapons() {
        for (const weaponId in WEAPON_REGISTRY) {
            const target = getSwapTargetForWeapon(weaponId);
            if (target && target !== 'none') requestRefreshWeaponSwap(weaponId);
        }
    }

    function runMatchWarm() {
        warmVisibleLoadoutSwaps();
        refreshAllSavedSwapWeapons();
    }

    function initMatchWarmObserver() {
        let wasInGame = false;
        const observer = new MutationObserver(function () {
            const inGame = !!document.querySelector('.desktop-game-interface');
            if (inGame && !wasInGame) runMatchWarm();
            wasInGame = inGame;
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    buildWeaponLabelLookup();

    function hashToShortKey(textureKey) {
        const file = normalizeTextureFilename(textureKey);
        if (!file) return null;
        const match = file.match(/^texture\.([a-f0-9]+)\.webp$/i);
        return match ? match[1].toLowerCase() : null;
    }

    function buildKirkaRenderMiniUrl(textureKey) {
        const shortKey = hashToShortKey(textureKey);
        if (!shortKey) return null;
        return 'https://kirka.io/assets/img/render-mini.' + shortKey + '.webp';
    }

    function buildLukeRenderUrl(weaponId, skinName) {
        const folder = RENDER_WEAPON_FOLDER[weaponId];
        if (!folder || !skinName) return null;
        return 'https://kirka.lukeskywalk.com/static/renders/' + folder + '/' + encodeURIComponent(skinName + '-render.webp');
    }

    function isFullLukeRenderUrl(url) {
        return !!url
            && String(url).indexOf('lukeskywalk.com/static/renders/') !== -1
            && String(url).indexOf('render-mini.') === -1;
    }

    function isLukeRenderUrl(url) {
        if (!url) return false;
        const src = String(url);
        return src.indexOf('lukeskywalk.com/static/renders/') !== -1
            || src.indexOf('kirka.io/assets/img/render-mini.') !== -1;
    }

    function getSkinPreviewLoadCandidates(textureKey, weaponIdHint, opts) {
        const file = normalizeTextureFilename(textureKey);
        if (!file) return [];
        const renderOnly = !!(opts && opts.renderOnly);
        const seen = new Set();
        const out = [];
        const add = function (url) {
            if (!url || seen.has(url)) return;
            seen.add(url);
            out.push(url);
        };

        const catalogRender = SKIN_RENDER_URLS[file];
        const skin = SKIN_DATABASE[file];

        if (catalogRender) add(catalogRender);
        if (skin) {
            const weaponForRender = weaponIdHint || skin.weapon;
            const built = buildLukeRenderUrl(weaponForRender, skin.name);
            if (built) add(built);
            if (skin.weapon && skin.weapon !== weaponForRender) {
                const altBuilt = buildLukeRenderUrl(skin.weapon, skin.name);
                if (altBuilt) add(altBuilt);
            }
        }
        const kirkaMini = buildKirkaRenderMiniUrl(file);
        if (kirkaMini) add(kirkaMini);
        if (renderOnly) return out;
        add(TEXTURE_CDN + file);
        return out;
    }

    function loadPreviewImageWithFallback(img, wrap, candidates, index) {
        if (!candidates || index >= candidates.length) {
            img.onload = null;
            img.onerror = null;
            img.style.display = 'none';
            img.removeAttribute('src');
            wrap.classList.remove('has-preview');
            wrap.removeAttribute('data-preview');
            return;
        }

        const url = candidates[index];
        img.onload = function () {
            img.onload = null;
            img.onerror = null;
            if (img.naturalWidth > 0) {
                wrap.classList.add('has-preview');
                wrap.setAttribute('data-preview', isLukeRenderUrl(url) ? 'render' : 'texture');
                img.style.display = 'block';
                return;
            }
            loadPreviewImageWithFallback(img, wrap, candidates, index + 1);
        };
        img.onerror = function () {
            img.onload = null;
            img.onerror = null;
            loadPreviewImageWithFallback(img, wrap, candidates, index + 1);
        };
        wrap.classList.remove('has-preview');
        wrap.removeAttribute('data-preview');
        img.style.display = 'none';
        img.src = url;
    }

    function syncTextureSets() {
        fileToWeapon.clear();
        for (const weaponId in WEAPON_REGISTRY) {
            textureSetsByWeapon[weaponId].clear();
        }
        for (const hash in SKIN_DATABASE) {
            const skin = SKIN_DATABASE[hash];
            const lower = hash.toLowerCase();
            const weapon = skin.weapon;
            if (!WEAPON_REGISTRY[weapon]) continue;
            textureSetsByWeapon[weapon].add(lower);
            fileToWeapon.set(lower, weapon);
        }
    }

    function tryHydrateSkinsFromCacheSync() {
        try {
            const cached = localStorage.getItem(SKINS_CACHE_KEY);
            if (!cached) return false;
            const parsed = JSON.parse(cached);
            if (!parsed || parsed.v !== 2 || !parsed.skins) return false;
            hydrateSkinCatalog(parsed);
            skinsCatalogReady = true;
            return true;
        } catch (_) {
            return false;
        }
    }

    tryHydrateSkinsFromCacheSync();

    async function loadSkinCatalog() {
        try {
            const res = await fetch(SKINS_JSON_URL, { cache: 'no-cache' });
            if (!res.ok) throw new Error('Skins fetch failed: ' + res.status);
            const remote = await res.json();
            if (!remote || remote.v !== 2 || !remote.skins) throw new Error('Invalid remote skins.json');

            const remoteVersion = getCatalogVersion(remote);
            const storedVersion = localStorage.getItem(SKINS_VERSION_KEY) || '';
            const needsUpdate = remoteVersion !== storedVersion;

            if (needsUpdate || !skinsCatalogReady) {
                hydrateSkinCatalog(remote);
                try {
                    localStorage.setItem(SKINS_CACHE_KEY, JSON.stringify(remote));
                    localStorage.setItem(SKINS_VERSION_KEY, remoteVersion);
                } catch (_) {}
                console.log('[TextureSwapper] Catalog ready (' + Object.keys(SKIN_DATABASE).length + ' skins, v' + remoteVersion + ')');
            } else {
                console.log('[TextureSwapper] Catalog current (v' + storedVersion + ')');
            }
            skinsCatalogReady = true;
        } catch (err) {
            console.error('[TextureSwapper] Catalog load failed:', err);
            if (!skinsCatalogReady) throw err;
        }
    }

    function getSwapTargetForWeapon(weapon) {
        return (cfg.skinSwap && cfg.skinSwap[weapon]) || 'none';
    }

    function setSwapTargetForWeapon(weaponId, value) {
        const normalized = value === 'none' ? 'none' : (normalizeTextureFilename(value) || value);
        cfg.skinSwap[weaponId] = normalized;
        try {
            localStorage.setItem(getSkinSwapStorageKey(weaponId), normalized);
        } catch (_) {}
        if (normalized && normalized !== 'none') {
            preloadSwapTexture(normalized, function () {
                requestRefreshWeaponSwap(weaponId);
            });
        } else {
            requestRefreshWeaponSwap(weaponId);
        }
        recomputeAnySwapActive();
    }

    function isActiveSwapTextureFile(file) {
        if (!file) return false;
        for (const weaponId in WEAPON_REGISTRY) {
            const target = getSwapTargetForWeapon(weaponId);
            if (!target || target === 'none') continue;
            if (normalizeTextureFilename(target) === file) return true;
        }
        return false;
    }

    function trimSwapImageCache() {
        while (preloadedSwapImages.size > SWAP_IMAGE_CACHE_MAX) {
            let evicted = false;
            for (const file of preloadedSwapImages.keys()) {
                if (isActiveSwapTextureFile(file)) continue;
                preloadedSwapImages.delete(file);
                decodedSwapImages.delete(file);
                evicted = true;
                break;
            }
            if (!evicted) break;
        }
    }

    function finishSwapImageDecode(file, img, onReady) {
        if (!img || !img.complete || img.naturalWidth === 0) {
            if (onReady) onReady();
            return;
        }
        if (decodedSwapImages.has(file)) {
            if (onReady) onReady();
            return;
        }
        const done = function () {
            decodedSwapImages.add(file);
            if (onReady) onReady();
        };
        if (typeof img.decode === 'function') {
            img.decode().then(done).catch(done);
        } else {
            done();
        }
    }

    function preloadSwapTexture(filename, onReady) {
        if (!filename || filename === 'none') {
            if (onReady) onReady();
            return;
        }
        const file = normalizeTextureFilename(filename);
        if (!file) {
            if (onReady) onReady();
            return;
        }
        const finish = function () {
            if (onReady) onReady();
        };
        if (preloadedSwapImages.has(file)) {
            const existing = preloadedSwapImages.get(file);
            if (decodedSwapImages.has(file)) {
                finish();
                return;
            }
            if (existing.complete && existing.naturalWidth > 0) {
                finishSwapImageDecode(file, existing, finish);
                return;
            }
            function done() {
                existing.removeEventListener('load', done);
                existing.removeEventListener('error', done);
                finishSwapImageDecode(file, existing, finish);
            }
            existing.addEventListener('load', done);
            existing.addEventListener('error', done);
            return;
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = function () {
            finishSwapImageDecode(file, img, finish);
        };
        img.onerror = finish;
        img.src = TEXTURE_CDN + file;
        preloadedSwapImages.set(file, img);
        trimSwapImageCache();
    }

    function getReadySwapImage(filename) {
        const file = normalizeTextureFilename(filename);
        if (!file || !decodedSwapImages.has(file)) return null;
        const img = preloadedSwapImages.get(file);
        if (!img || !img.complete || img.naturalWidth === 0) return null;
        return img;
    }

    function getWeaponForFile(file) {
        if (!file) return null;
        return fileToWeapon.get(file) || null;
    }

    function registerWeaponTexture(tex, gl, file, srcUrl) {
        if (!tex || !gl || !file) return;
        if (textureOriginalFile.get(tex) === file) return;
        const weapon = getWeaponForFile(file);
        if (!weapon) return;
        const entry = glToEntry.get(gl);
        if (entry) textureGlEntry.set(tex, entry);
        textureOriginalFile.set(tex, file);
        textureWeapon.set(tex, weapon);
        textureSources.set(tex, srcUrl || (TEXTURE_CDN + file));
        trackedGlTextures.add(tex);
        glTexturesByWeapon[weapon].add(tex);
        if (anySwapActive) {
            const swap = getSwapTargetForWeapon(weapon);
            if (swap && swap !== 'none') {
                preloadSwapTexture(swap, function () {
                    requestRefreshWeaponSwap(weapon);
                });
            }
        }
    }

    function isLiveGlTexture(gl, tex) {
        if (!gl || !tex) return false;
        try {
            return !!gl.isTexture(tex);
        } catch (_) {
            return false;
        }
    }

    function unregisterWeaponTexture(tex) {
        if (!tex) return;
        const weapon = textureWeapon.get(tex);
        if (weapon && glTexturesByWeapon[weapon]) {
            glTexturesByWeapon[weapon].delete(tex);
        }
        textureOriginalFile.delete(tex);
        textureWeapon.delete(tex);
        textureGlEntry.delete(tex);
        textureSources.delete(tex);
        textureMipmapped.delete(tex);
        trackedGlTextures.delete(tex);
        refreshBindExtras.delete(tex);
    }

    function ensureLiveWeaponTexture(gl, tex) {
        if (!tex) return false;
        if (isLiveGlTexture(gl, tex)) return true;
        unregisterWeaponTexture(tex);
        return false;
    }

    function resolveTextureGl(tex) {
        const entry = textureGlEntry.get(tex);
        if (entry && entry.gl) return entry.gl;
        return hookedGlEntries.length ? hookedGlEntries[0].gl : null;
    }

    function pruneDeadWeaponTextures(weapon) {
        const pool = glTexturesByWeapon[weapon];
        if (!pool || !pool.size) return;
        pool.forEach(function (tex) {
            const gl = resolveTextureGl(tex);
            if (!gl || !isLiveGlTexture(gl, tex)) unregisterWeaponTexture(tex);
        });
    }

    function queueTextureReupload(tex, img) {
        textureReuploadQueue.push({ tex: tex, img: img });
        if (textureReuploadRaf) return;
        textureReuploadRaf = requestAnimationFrame(pumpTextureReuploadQueue);
    }

    function pumpTextureReuploadQueue() {
        textureReuploadRaf = null;
        const batch = textureReuploadQueue.splice(0, TEXTURE_REUPLOADS_PER_FRAME);
        for (let i = 0; i < batch.length; i++) {
            const item = batch[i];
            const gl = resolveTextureGl(item.tex);
            if (!gl || !ensureLiveWeaponTexture(gl, item.tex)) continue;
            reuploadSwapToTexture(item.tex, item.img);
        }
        if (textureReuploadQueue.length) {
            textureReuploadRaf = requestAnimationFrame(pumpTextureReuploadQueue);
        }
    }

    function trySwapTextureUpload(args) {
        if (!anySwapActive) return;
        const pixels = args[args.length - 1];
        if (!pixels || typeof pixels !== 'object' || !pixels.src) return;

        const uploadFile = extractTextureFilename(String(pixels.src));
        if (!uploadFile) return;

        const swapWeaponId = fileToWeapon.get(uploadFile);
        if (!swapWeaponId) return;

        const swapTarget = getSwapTargetForWeapon(swapWeaponId);
        if (!swapTarget || swapTarget === 'none') return;

        const swapFile = normalizeTextureFilename(swapTarget);
        if (!swapFile || uploadFile === swapFile) return;

        const replacement = getReadySwapImage(swapFile);
        if (!replacement) {
            preloadSwapTexture(swapFile);
            return;
        }
        args[args.length - 1] = replacement;
    }

    function reuploadSwapToTexture(tex, img) {
        const entry = textureGlEntry.get(tex);
        if (!entry || !img) return false;
        const gl = entry.gl;
        if (!ensureLiveWeaponTexture(gl, tex)) return false;
        try {
            entry.natives.bindTexture.call(gl, entry.TEXTURE_2D, tex);
            entry.natives.texImage2D.call(
                gl,
                entry.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                img
            );
            if (textureMipmapped.get(tex) && entry.natives.generateMipmap) {
                entry.natives.generateMipmap.call(gl, entry.TEXTURE_2D);
            }
            const uploaded = normalizeTextureFilename(img.src || '');
            if (uploaded) textureSources.set(tex, TEXTURE_CDN + uploaded);
            return true;
        } catch (_) {
            unregisterWeaponTexture(tex);
            return false;
        }
    }

    function collectWeaponRefreshTextures(weapon) {
        pruneDeadWeaponTextures(weapon);
        const pool = glTexturesByWeapon[weapon] || new Set();
        const out = [];
        pool.forEach(function (tex) {
            if (textureWeapon.get(tex) !== weapon) return;
            const gl = resolveTextureGl(tex);
            if (!gl || !ensureLiveWeaponTexture(gl, tex)) return;
            out.push(tex);
        });
        if (refreshWeaponFilter === weapon) {
            refreshBindExtras.forEach(function (tex) {
                if (textureWeapon.get(tex) !== weapon || out.indexOf(tex) !== -1) return;
                const gl = resolveTextureGl(tex);
                if (!gl || !ensureLiveWeaponTexture(gl, tex)) return;
                out.push(tex);
            });
        }
        return out;
    }

    function refreshWeaponSwapTextures(weaponFilter) {
        if (!hookedGlEntries.length) return;

        const weapons = weaponFilter ? [weaponFilter] : Object.keys(WEAPON_REGISTRY);
        let pendingPreload = null;

        for (let w = 0; w < weapons.length; w++) {
            const weapon = weapons[w];
            const swapTarget = getSwapTargetForWeapon(weapon);
            const textures = collectWeaponRefreshTextures(weapon);
            if (!textures.length) continue;

            let swapImg = null;
            if (swapTarget && swapTarget !== 'none') {
                swapImg = getReadySwapImage(swapTarget);
                if (!swapImg) {
                    pendingPreload = swapTarget;
                    continue;
                }
            }

            for (let i = 0; i < textures.length; i++) {
                const tex = textures[i];
                let img = swapImg;
                if (!img) {
                    const origFile = textureOriginalFile.get(tex) || extractTextureFilename(textureSources.get(tex));
                    if (!origFile) continue;
                    img = getReadySwapImage(origFile);
                    if (!img) {
                        pendingPreload = origFile;
                        continue;
                    }
                }
                queueTextureReupload(tex, img);
            }
        }

        if (pendingPreload) {
            preloadSwapTexture(pendingPreload, function () {
                refreshWeaponSwapTextures(weaponFilter);
            });
        }
    }

    function requestRefreshWeaponSwap(weaponFilter) {
        refreshWeaponFilter = weaponFilter;
        refreshBindExtras.clear();
        refreshWeaponSwapTextures(weaponFilter);
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                refreshWeaponSwapTextures(weaponFilter);
                refreshWeaponFilter = null;
                refreshBindExtras.clear();
            });
        });
    }

    function captureTextureUpload(args, entry) {
        const gl = entry.gl;
        const pixels = args[args.length - 1];
        if (!pixels || typeof pixels !== 'object' || !pixels.src) return;

        const src = String(pixels.src);
        const file = extractTextureFilename(src);
        if (!file || !fileToWeapon.has(file)) return;

        const tex = entry.activeTexture2D;
        if (!tex) return;

        registerWeaponTexture(tex, gl, file, src);
        entry.vm.lastMeleeUpload = { file: file };
    }

    function trackRefreshBind(entry, texture) {
        if (!refreshWeaponFilter || !texture) return;
        if (textureWeapon.has(texture) && !isLiveGlTexture(entry.gl, texture)) {
            unregisterWeaponTexture(texture);
            return;
        }
        const weapon = textureWeapon.get(texture);
        if (weapon !== refreshWeaponFilter) return;
        refreshBindExtras.add(texture);
        if (!textureGlEntry.has(texture)) textureGlEntry.set(texture, entry);
        if (weapon && glTexturesByWeapon[weapon]) glTexturesByWeapon[weapon].add(texture);
    }

    function onTexImage2D(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) return;
        captureTextureUpload(ctx.args, entry);
        if (anySwapActive) trySwapTextureUpload(ctx.args);
    }

    function onTexSubImage2D(ctx) {
        onTexImage2D(ctx);
    }

    function onCopyTexImage2D(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) return;
        const gl = ctx.gl;
        const TEXTURE_2D = gl.TEXTURE_2D;
        if (ctx.phase === 'before') {
            if (ctx.args[0] === TEXTURE_2D) ctx.meta.dstTex = entry.activeTexture2D;
            return;
        }
        try {
            const last = entry.vm.lastMeleeUpload;
            if (ctx.meta.dstTex && last && last.file) {
                registerWeaponTexture(ctx.meta.dstTex, gl, last.file, TEXTURE_CDN + last.file);
            }
        } catch (_) {}
    }

    function onGenerateMipmap(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) return;
        const gl = ctx.gl;
        if (ctx.args[0] !== gl.TEXTURE_2D) return;
        const tex = entry.activeTexture2D;
        if (tex && textureWeapon.has(tex)) textureMipmapped.set(tex, true);
    }

    function onDeleteTexture(ctx) {
        const tex = ctx.args[0];
        if (tex) unregisterWeaponTexture(tex);
    }

    function onBindTexture(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) return;
        const gl = ctx.gl;
        if (ctx.args[0] === gl.TEXTURE_2D) {
            entry.activeTexture2D = ctx.args[1] || null;
            trackRefreshBind(entry, ctx.args[1]);
        }
    }

    function clearBridgeHandlers() {
        for (let i = 0; i < knifeBridgeUnregisters.length; i++) {
            knifeBridgeUnregisters[i]();
        }
        knifeBridgeUnregisters = [];
    }

    function refreshBridgeHandlers() {
        const bridge = window.__NAP_GL_BRIDGE__;
        if (!bridge) return;
        clearBridgeHandlers();

        function register(method, handler) {
            try {
                return bridge.register(method, handler);
            } catch (err) {
                if (method === 'deleteTexture') return function () {};
                throw err;
            }
        }

        knifeBridgeUnregisters.push(
            register('texImage2D', onTexImage2D),
            register('texSubImage2D', onTexSubImage2D),
            register('copyTexImage2D', onCopyTexImage2D),
            register('generateMipmap', onGenerateMipmap),
            register('deleteTexture', onDeleteTexture),
            register('bindTexture', onBindTexture)
        );
    }

    function bootstrapSavedSwaps() {
        if (!anySwapActive) return;
        let pending = 0;
        for (const weaponId in WEAPON_REGISTRY) {
            const target = getSwapTargetForWeapon(weaponId);
            if (!target || target === 'none') continue;
            pending += 1;
            preloadSwapTexture(target, function () {
                pending -= 1;
                if (pending <= 0) {
                    for (const wid in WEAPON_REGISTRY) {
                        if (getSwapTargetForWeapon(wid) !== 'none') {
                            requestRefreshWeaponSwap(wid);
                        }
                    }
                }
            });
        }
    }

    function onBridgeContext(gl, natives) {
        if (glToEntry.has(gl)) return;
        const entry = {
            gl: gl,
            natives: natives,
            TEXTURE_2D: gl.TEXTURE_2D,
            activeTexture2D: null,
            vm: { lastMeleeUpload: null },
        };
        hookedGlEntries.push(entry);
        glToEntry.set(gl, entry);
        bootstrapSavedSwaps();
    }

    function initBridge() {
        const bridge = window.__NAP_GL_BRIDGE__;
        if (!bridge) {
            console.error('[TextureSwapper] NAP WebGL bridge unavailable');
            return;
        }
        bridge.onContext(onBridgeContext);
        refreshBridgeHandlers();
    }

    initBridge();

    // --- Menu ---

    let menuHost = null;
    let menuOpen = false;
    let menuInitialized = false;
    let expandedWeaponId = null;
    const slotUiByWeapon = {};

    function loadExpandedWeaponId() {
        try {
            const saved = localStorage.getItem(EXPANDED_WEAPON_KEY);
            if (saved && WEAPON_REGISTRY[saved]) return saved;
        } catch (_) {}
        return null;
    }

    function saveExpandedWeaponId(weaponId) {
        try {
            if (weaponId) localStorage.setItem(EXPANDED_WEAPON_KEY, weaponId);
            else localStorage.removeItem(EXPANDED_WEAPON_KEY);
        } catch (_) {}
    }

    function paintCarrot(ui, open) {
        if (!ui || !ui.carrot) return;
        ui.carrot.textContent = open ? '▼' : '▶';
        ui.carrot.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function applyExpandedWeapon(weaponId) {
        expandedWeaponId = weaponId && slotUiByWeapon[weaponId] ? weaponId : null;
        for (const id in slotUiByWeapon) {
            const ui = slotUiByWeapon[id];
            const open = id === expandedWeaponId;
            ui.slot.classList.toggle('is-open', open);
            paintCarrot(ui, open);
        }
        saveExpandedWeaponId(expandedWeaponId);
    }

    function toggleExpandedWeapon(weaponId) {
        if (expandedWeaponId === weaponId) {
            applyExpandedWeapon(null);
            return;
        }
        applyExpandedWeapon(weaponId);
    }

    function restoreExpandedWeapon() {
        applyExpandedWeapon(loadExpandedWeaponId());
    }

    function getSkinRarityColor(hash) {
        if (!hash || hash === 'none') return '#ff6b7a';
        const meta = SKIN_DATABASE[hash];
        return meta ? (RARITY_COLOR[meta.rarity] || '#4a9eff') : '#4a9eff';
    }

    const skinDropdownClosers = [];

    function registerSkinDropdownCloser(closeFn) {
        skinDropdownClosers.push(closeFn);
    }

    function closeAllSkinDropdowns(keepCloseFn) {
        for (let i = 0; i < skinDropdownClosers.length; i++) {
            const closeFn = skinDropdownClosers[i];
            if (closeFn !== keepCloseFn) closeFn();
        }
    }

    function preventFocusFlash(el) {
        el.addEventListener('mousedown', function (e) {
            e.preventDefault();
        });
    }

    function createSkinDropdown(weaponId) {
        const meta = WEAPON_REGISTRY[weaponId];
        const wrap = document.createElement('div');
        wrap.className = 'ts-dd-wrap';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ts-dd-btn';

        const btnLabel = document.createElement('span');
        btnLabel.className = 'ts-dd-label';

        const caret = document.createElement('span');
        caret.className = 'ts-dd-caret';
        caret.textContent = '▾';

        btn.appendChild(btnLabel);
        btn.appendChild(caret);

        const list = document.createElement('div');
        list.className = 'ts-dd-list';

        let selectedKey = normalizeSwapHash(getSwapTargetForWeapon(weaponId));

        function paintSelection(key) {
            selectedKey = key;
            const options = getWeaponSelectOptions(weaponId);
            btnLabel.textContent = options[key] || key;
            btnLabel.style.color = getSkinRarityColor(key);
            const items = list.querySelectorAll('.ts-dd-item');
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const sel = item.dataset.key === key;
                item.classList.toggle('is-selected', sel);
                const nameEl = item.querySelector('.ts-dd-item-name');
                if (nameEl) {
                    nameEl.style.color = sel ? getSkinRarityColor(key) : '#e8e8e8';
                    nameEl.style.fontWeight = sel ? '700' : '500';
                }
            }
        }

        function closeList() {
            list.style.display = 'none';
            list.style.position = '';
            list.style.top = '';
            list.style.bottom = '';
            list.style.left = '';
            list.style.right = '';
            list.style.width = '';
            list.style.minWidth = '';
            list.style.maxHeight = '';
            caret.textContent = '▾';
        }

        function openList() {
            closeAllSkinDropdowns(closeList);
            rebuildListItems();
            list.style.display = 'block';
            caret.textContent = '▴';

            const wrapRect = wrap.getBoundingClientRect();
            const listHeight = Math.min(list.scrollHeight, 240);
            const spaceBelow = window.innerHeight - wrapRect.bottom - 8;
            const spaceAbove = wrapRect.top - 8;
            const openUp = spaceBelow < listHeight && spaceAbove >= spaceBelow;

            list.style.position = 'fixed';
            list.style.width = Math.max(wrapRect.width, 210) + 'px';
            list.style.minWidth = '210px';
            list.style.left = wrapRect.left + 'px';
            list.style.right = 'auto';
            list.style.maxHeight = '240px';

            if (openUp) {
                list.style.top = 'auto';
                list.style.bottom = (window.innerHeight - wrapRect.top + 4) + 'px';
            } else {
                list.style.top = (wrapRect.bottom + 4) + 'px';
                list.style.bottom = 'auto';
            }

            const sel = list.querySelector('[data-key="' + selectedKey + '"]');
            if (sel) {
                list.scrollTop = Math.max(0, sel.offsetTop - (list.clientHeight - sel.offsetHeight) / 2);
            }
        }

        function applySelection(key) {
            paintSelection(key);
            closeList();
            applyWeaponSelection(weaponId, key);
            btn.blur();
        }

        function rebuildListItems() {
            list.innerHTML = '';
            const options = getWeaponSelectOptions(weaponId);
            const keys = sortedSkinKeys(weaponId);
            const current = normalizeSwapHash(getSwapTargetForWeapon(weaponId));
            if (current !== 'none' && keys.indexOf(current) === -1) {
                keys.push(current);
            }
            const favKey = getFavStorageKey(weaponId);

            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const item = document.createElement('div');
                item.className = 'ts-dd-item';
                item.dataset.key = k;
                const sel = k === selectedKey;
                if (sel) item.classList.add('is-selected');

                if (k === 'none') {
                    const nameOnly = document.createElement('span');
                    nameOnly.className = 'ts-dd-item-name';
                    nameOnly.textContent = options[k] || k;
                    item.appendChild(nameOnly);
                } else {
                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'ts-dd-item-name';
                    nameSpan.textContent = options[k] || k;
                    nameSpan.style.color = sel ? getSkinRarityColor(k) : '#e8e8e8';
                    if (sel) nameSpan.style.fontWeight = '700';

                    const favBtn = document.createElement('button');
                    favBtn.type = 'button';
                    favBtn.className = 'ts-dd-fav';
                    favBtn.title = 'Favorite';
                    function paintFav() {
                        const on = isFavoriteSkin(favKey, k);
                        favBtn.textContent = on ? '♥' : '♡';
                        favBtn.classList.toggle('is-on', on);
                    }
                    paintFav();
                    favBtn.addEventListener('mousedown', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                    });
                    favBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        toggleFavoriteSkin(favKey, k);
                        paintFav();
                        const ui = slotUiByWeapon[weaponId];
                        if (ui && ui.favDropdown) ui.favDropdown.refresh();
                        favBtn.blur();
                    });
                    preventFocusFlash(favBtn);

                    item.appendChild(nameSpan);
                    item.appendChild(favBtn);
                }

                item.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                });
                item.addEventListener('click', function (e) {
                    if (e.target && e.target.classList && e.target.classList.contains('ts-dd-fav')) return;
                    e.stopPropagation();
                    applySelection(k);
                });
                list.appendChild(item);
            }
        }

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (list.style.display === 'block') closeList();
            else openList();
            btn.blur();
        });
        preventFocusFlash(btn);
        list.addEventListener('mousedown', function (e) {
            e.stopPropagation();
        });

        wrap.appendChild(btn);
        wrap.appendChild(list);
        registerSkinDropdownCloser(closeList);
        rebuildListItems();
        paintSelection(selectedKey);

        return {
            el: wrap,
            refresh: function () {
                rebuildListItems();
                paintSelection(normalizeSwapHash(getSwapTargetForWeapon(weaponId)));
            },
            close: closeList,
            setValue: paintSelection,
        };
    }

    function createFavoritesDropdown(weaponId) {
        const wrap = document.createElement('div');
        wrap.className = 'ts-dd-wrap ts-fav-dd-wrap';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ts-dd-btn ts-fav-dd-btn';

        const btnLabel = document.createElement('span');
        btnLabel.className = 'ts-dd-label';
        btnLabel.textContent = 'Favorites';

        const caret = document.createElement('span');
        caret.className = 'ts-dd-caret';
        caret.textContent = '▾';

        btn.appendChild(btnLabel);
        btn.appendChild(caret);

        const list = document.createElement('div');
        list.className = 'ts-dd-list';

        function getFavoriteOptions() {
            return buildFavoritesOptions(
                getWeaponSelectOptions(weaponId),
                loadFavoriteSkins(getFavStorageKey(weaponId))
            );
        }

        function closeList() {
            list.style.display = 'none';
            list.style.position = '';
            list.style.top = '';
            list.style.bottom = '';
            list.style.left = '';
            list.style.right = '';
            list.style.width = '';
            list.style.minWidth = '';
            list.style.maxHeight = '';
            caret.textContent = '▾';
        }

        function openList() {
            closeAllSkinDropdowns(closeList);
            rebuildListItems();
            list.style.display = 'block';
            caret.textContent = '▴';

            const wrapRect = wrap.getBoundingClientRect();
            const listHeight = Math.min(list.scrollHeight, 200);
            const spaceBelow = window.innerHeight - wrapRect.bottom - 8;
            const spaceAbove = wrapRect.top - 8;
            const openUp = spaceBelow < listHeight && spaceAbove >= spaceBelow;

            list.style.position = 'fixed';
            list.style.width = Math.max(wrapRect.width, 210) + 'px';
            list.style.minWidth = '210px';
            list.style.left = wrapRect.left + 'px';
            list.style.right = 'auto';
            list.style.maxHeight = '200px';

            if (openUp) {
                list.style.top = 'auto';
                list.style.bottom = (window.innerHeight - wrapRect.top + 4) + 'px';
            } else {
                list.style.top = (wrapRect.bottom + 4) + 'px';
                list.style.bottom = 'auto';
            }
        }

        function rebuildListItems() {
            list.innerHTML = '';
            const favOptions = getFavoriteOptions();
            const keys = Object.keys(favOptions);
            if (!keys.length) {
                const empty = document.createElement('div');
                empty.className = 'ts-dd-item ts-dd-empty';
                empty.textContent = 'No favorites yet';
                list.appendChild(empty);
                return;
            }
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const item = document.createElement('div');
                item.className = 'ts-dd-item';
                item.dataset.key = k;
                const nameSpan = document.createElement('span');
                nameSpan.className = 'ts-dd-item-name';
                nameSpan.textContent = favOptions[k];
                nameSpan.style.color = getSkinRarityColor(k);
                item.appendChild(nameSpan);
                item.addEventListener('mousedown', function (e) { e.preventDefault(); });
                item.addEventListener('click', function (e) {
                    e.stopPropagation();
                    closeList();
                    applyWeaponSelection(weaponId, k);
                    btn.blur();
                });
                list.appendChild(item);
            }
        }

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (list.style.display === 'block') closeList();
            else openList();
            btn.blur();
        });
        preventFocusFlash(btn);
        list.addEventListener('mousedown', function (e) { e.stopPropagation(); });

        wrap.appendChild(btn);
        wrap.appendChild(list);
        registerSkinDropdownCloser(closeList);
        rebuildListItems();

        return {
            el: wrap,
            refresh: rebuildListItems,
            close: closeList,
        };
    }

    function notifySkinOptionsChanged() {
        refreshAllSlotSelects();
    }

    function normalizeSwapHash(hash) {
        if (!hash || hash === 'none') return 'none';
        return normalizeTextureFilename(hash) || hash;
    }

    function getWeaponSelectOptions(weaponId) {
        const options = Object.assign({ none: 'Equipped' }, swappableByWeapon[weaponId] || {});
        const current = normalizeSwapHash(getSwapTargetForWeapon(weaponId));
        if (current !== 'none' && !options[current]) {
            const meta = SKIN_DATABASE[current];
            options[current] = meta ? meta.name : current;
        }
        return options;
    }

    function sortedSkinKeys(weaponId) {
        const options = getWeaponSelectOptions(weaponId);
        return Object.keys(options).sort(function (a, b) {
            if (a === 'none') return -1;
            if (b === 'none') return 1;
            return String(options[a]).localeCompare(String(options[b]));
        });
    }

    function updateSlotPreview(weaponId, hash) {
        const ui = slotUiByWeapon[weaponId];
        if (!ui) return;

        const file = normalizeSwapHash(hash);
        if (!file || file === 'none') {
            ui.previewImg.style.display = 'none';
            ui.previewImg.removeAttribute('src');
            ui.previewWrap.classList.remove('has-preview');
            ui.previewWrap.removeAttribute('data-preview');
            ui.emptyHint.style.display = 'block';
            return;
        }

        ui.emptyHint.style.display = 'none';
        preloadSwapTexture(file);
        loadPreviewImageWithFallback(
            ui.previewImg,
            ui.previewWrap,
            getSkinPreviewLoadCandidates(file, weaponId),
            0
        );
    }

    function applyWeaponSelection(weaponId, hash) {
        const normalized = normalizeSwapHash(hash);
        setSwapTargetForWeapon(weaponId, normalized);
        const ui = slotUiByWeapon[weaponId];
        if (ui && ui.dropdown) ui.dropdown.setValue(normalized);
        if (ui && ui.favDropdown) ui.favDropdown.refresh();
        updateSlotPreview(weaponId, normalized);
    }

    function resetAllSwaps() {
        closeAllSkinDropdowns();
        for (let i = 0; i < ALL_WEAPON_ORDER.length; i++) {
            applyWeaponSelection(ALL_WEAPON_ORDER[i], 'none');
        }
    }

    function randomizeAllSwaps() {
        closeAllSkinDropdowns();
        for (let i = 0; i < ALL_WEAPON_ORDER.length; i++) {
            const weaponId = ALL_WEAPON_ORDER[i];
            const keys = sortedSkinKeys(weaponId).filter(function (k) { return k !== 'none'; });
            if (!keys.length) continue;
            applyWeaponSelection(weaponId, keys[Math.floor(Math.random() * keys.length)]);
        }
    }

    function createWeaponSlot(shadow, rowEl, weaponId) {
        const meta = WEAPON_REGISTRY[weaponId];
        const slot = document.createElement('div');
        slot.className = 'ts-slot';
        slot.id = 'slot-' + weaponId;

        const previewWrap = document.createElement('div');
        previewWrap.className = 'ts-preview-wrap' + (meta.tab === 'melee' ? ' is-melee' : '');
        previewWrap.setAttribute('data-weapon-id', weaponId);

        const previewBg = document.createElement('img');
        previewBg.className = 'ts-preview-bg';
        previewBg.alt = '';
        previewBg.setAttribute('aria-hidden', 'true');

        const previewImg = document.createElement('img');
        previewImg.className = 'ts-preview-render';
        previewImg.alt = meta.label;
        previewImg.decoding = 'async';
        previewImg.referrerPolicy = 'no-referrer';

        const emptyHint = document.createElement('span');
        emptyHint.className = 'ts-preview-empty';
        emptyHint.textContent = 'Equipped';

        previewWrap.appendChild(previewBg);
        previewWrap.appendChild(previewImg);
        previewWrap.appendChild(emptyHint);

        const head = document.createElement('div');
        head.className = 'ts-head';

        const carrot = document.createElement('button');
        carrot.type = 'button';
        carrot.className = 'ts-carrot';
        carrot.textContent = '▶';
        carrot.title = 'Show swap controls';
        carrot.setAttribute('aria-expanded', 'false');
        carrot.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleExpandedWeapon(weaponId);
            carrot.blur();
        });
        preventFocusFlash(carrot);

        const label = document.createElement('span');
        label.className = 'ts-label';
        label.textContent = meta.label;

        head.appendChild(carrot);
        head.appendChild(label);

        const drawer = document.createElement('div');
        drawer.className = 'ts-drawer';

        const controls = document.createElement('div');
        controls.className = 'ts-controls';

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'ts-btn ts-btn-rst';
        resetBtn.textContent = 'Rst';
        resetBtn.title = 'Reset to equipped';
        resetBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            applyWeaponSelection(weaponId, 'none');
            resetBtn.blur();
        });
        preventFocusFlash(resetBtn);

        const randomBtn = document.createElement('button');
        randomBtn.type = 'button';
        randomBtn.className = 'ts-btn ts-btn-rnd';
        randomBtn.textContent = 'Rnd';
        randomBtn.title = 'Random skin';
        randomBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            const keys = sortedSkinKeys(weaponId).filter(function (k) { return k !== 'none'; });
            if (!keys.length) return;
            applyWeaponSelection(weaponId, keys[Math.floor(Math.random() * keys.length)]);
            randomBtn.blur();
        });
        preventFocusFlash(randomBtn);

        const dropdown = createSkinDropdown(weaponId);
        const favDropdown = createFavoritesDropdown(weaponId);

        const btnRow = document.createElement('div');
        btnRow.className = 'ts-btn-row';
        btnRow.appendChild(resetBtn);
        btnRow.appendChild(randomBtn);

        controls.appendChild(btnRow);
        controls.appendChild(dropdown.el);
        controls.appendChild(favDropdown.el);
        drawer.appendChild(controls);

        slot.appendChild(previewWrap);
        slot.appendChild(head);
        slot.appendChild(drawer);
        rowEl.appendChild(slot);

        slotUiByWeapon[weaponId] = {
            slot: slot,
            previewWrap: previewWrap,
            previewImg: previewImg,
            emptyHint: emptyHint,
            carrot: carrot,
            drawer: drawer,
            dropdown: dropdown,
            favDropdown: favDropdown,
        };

        updateSlotPreview(weaponId, getSwapTargetForWeapon(weaponId));
    }

    function switchMenuTab(tabId) {
        if (!menuShadow) return;
        const mainPanel = menuShadow.getElementById('ts-tab-main');
        const morePanel = menuShadow.getElementById('ts-tab-more');
        const mainBtn = menuShadow.getElementById('ts-tab-btn-main');
        const moreBtn = menuShadow.getElementById('ts-tab-btn-more');
        const useMore = tabId === 'more';
        if (mainPanel) mainPanel.hidden = useMore;
        if (morePanel) morePanel.hidden = !useMore;
        if (mainBtn) mainBtn.classList.toggle('is-active', !useMore);
        if (moreBtn) moreBtn.classList.toggle('is-active', useMore);
        const footer = menuShadow.querySelector('.ts-footer');
        if (footer) footer.style.display = useMore ? 'none' : '';
        try {
            localStorage.setItem(MENU_TAB_KEY, useMore ? 'more' : 'main');
        } catch (_) {}
        if (useMore) closeAllSkinDropdowns();
    }

    function restoreMenuTab() {
        let tab = 'main';
        try {
            const saved = localStorage.getItem(MENU_TAB_KEY);
            if (saved === 'more') tab = 'more';
        } catch (_) {}
        switchMenuTab(tab);
    }

    function buildFindAnySkinDescription() {
        const count = String(Object.keys(SKIN_DATABASE).length);
        return 'Search the full skin catalog and press Add to dropdown to save locally. (' + count + ' skins)';
    }

    function initCatalogFinder(shadow) {
        const mount = shadow.getElementById('ts-tab-more');
        if (!mount) return;

        const title = document.createElement('div');
        title.className = 'ts-more-title';
        title.textContent = 'Find any skin';

        const searchWrap = document.createElement('div');
        searchWrap.className = 'ts-catalog-search-wrap';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'ts-catalog-search';
        searchInput.placeholder = 'Search any skin name…';
        searchInput.autocomplete = 'off';
        searchInput.spellcheck = false;

        const suggestionList = document.createElement('div');
        suggestionList.className = 'ts-catalog-suggestions';

        searchWrap.appendChild(searchInput);
        searchWrap.appendChild(suggestionList);

        const selectedBox = document.createElement('div');
        selectedBox.className = 'ts-catalog-selected';

        const selectedName = document.createElement('div');
        selectedName.className = 'ts-catalog-selected-name';

        const selectedWeapon = document.createElement('div');
        selectedWeapon.className = 'ts-catalog-selected-weapon';

        const selectedRarity = document.createElement('div');
        selectedRarity.className = 'ts-catalog-selected-rarity';

        selectedBox.appendChild(selectedName);
        selectedBox.appendChild(selectedWeapon);
        selectedBox.appendChild(selectedRarity);

        const actions = document.createElement('div');
        actions.className = 'ts-catalog-actions';

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'ts-btn ts-catalog-reset';
        resetBtn.textContent = 'Reset';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'ts-btn ts-catalog-add';
        addBtn.textContent = 'Add to dropdown';
        addBtn.disabled = true;

        const statusEl = document.createElement('div');
        statusEl.className = 'ts-catalog-status';

        actions.appendChild(resetBtn);
        actions.appendChild(addBtn);

        const desc = document.createElement('div');
        desc.className = 'ts-more-desc';
        desc.textContent = buildFindAnySkinDescription();

        mount.appendChild(title);
        mount.appendChild(searchWrap);
        mount.appendChild(selectedBox);
        mount.appendChild(actions);
        mount.appendChild(statusEl);
        mount.appendChild(desc);

        function clearCatalogSelection() {
            catalogSelectedHash = null;
            catalogSelectedWeaponId = null;
            selectedBox.classList.remove('is-visible');
            selectedName.textContent = '';
            selectedWeapon.textContent = '';
            selectedRarity.textContent = '';
            addBtn.disabled = true;
            addBtn.textContent = 'Add to dropdown';
            addBtn.classList.remove('is-added', 'is-just-added');
            statusEl.textContent = '';
            statusEl.className = 'ts-catalog-status';
        }

        function selectCatalogSkin(match) {
            catalogSelectedHash = match.hash;
            catalogSelectedWeaponId = match.weaponId;
            selectedName.textContent = match.name;
            selectedWeapon.textContent = match.weaponLabel;
            selectedRarity.textContent = match.rarity;
            selectedBox.classList.add('is-visible');
            addBtn.disabled = false;
            if (isSkinUserAdded(match.weaponId, match.hash) || isSkinInBuiltInDropdown(match.weaponId, match.hash)) {
                addBtn.textContent = 'Already in dropdown';
                addBtn.classList.add('is-added');
            } else {
                addBtn.textContent = 'Add to dropdown';
                addBtn.classList.remove('is-added');
            }
            addBtn.classList.remove('is-just-added');
            statusEl.textContent = '';
        }

        function renderSuggestions() {
            const q = searchInput.value.trim();
            suggestionList.innerHTML = '';
            if (!q) {
                suggestionList.style.display = 'none';
                return;
            }
            const matches = searchFullSkinCatalog(q, 18);
            if (!matches.length) {
                suggestionList.style.display = 'none';
                return;
            }
            for (let i = 0; i < matches.length; i++) {
                const match = matches[i];
                const row = document.createElement('div');
                row.className = 'ts-catalog-suggestion';
                const name = document.createElement('span');
                name.textContent = match.name;
                name.style.color = RARITY_COLOR[match.rarity] || '#e8e8e8';
                const sub = document.createElement('span');
                sub.className = 'ts-catalog-suggestion-sub';
                sub.textContent = match.weaponLabel;
                row.appendChild(name);
                row.appendChild(sub);
                row.addEventListener('mousedown', function (e) { e.preventDefault(); });
                row.addEventListener('click', function (e) {
                    e.stopPropagation();
                    selectCatalogSkin(match);
                    suggestionList.style.display = 'none';
                });
                suggestionList.appendChild(row);
            }
            suggestionList.style.display = 'block';
        }

        searchInput.addEventListener('input', renderSuggestions);
        searchInput.addEventListener('focus', function () {
            if (searchInput.value.trim()) renderSuggestions();
        });
        searchInput.addEventListener('click', function (e) { e.stopPropagation(); });
        searchInput.addEventListener('keydown', function (e) { e.stopPropagation(); });

        resetBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            clearCatalogSelection();
            searchInput.value = '';
            suggestionList.style.display = 'none';
            resetBtn.blur();
        });
        preventFocusFlash(resetBtn);

        addBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!catalogSelectedHash || !catalogSelectedWeaponId) return;
            if (addUserExtraSkin(catalogSelectedWeaponId, catalogSelectedHash)) {
                notifySkinOptionsChanged();
                addBtn.textContent = 'Added!';
                addBtn.classList.add('is-just-added');
                statusEl.textContent = 'Saved to ' + WEAPON_REGISTRY[catalogSelectedWeaponId].label + ' dropdown.';
                statusEl.className = 'ts-catalog-status is-success';
            } else if (isSkinUserAdded(catalogSelectedWeaponId, catalogSelectedHash) || isSkinInBuiltInDropdown(catalogSelectedWeaponId, catalogSelectedHash)) {
                addBtn.textContent = 'Already in dropdown';
                addBtn.classList.add('is-added');
            }
            addBtn.blur();
        });
        preventFocusFlash(addBtn);
    }

    function initMenu() {
        if (menuInitialized) return;

        menuHost = document.createElement('div');
        menuHost.id = 'texture-swapper-minimal-host';
        menuHost.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;display:none;pointer-events:none;';

        const shadow = menuHost.attachShadow({ mode: 'open' });
        menuShadow = shadow;
        shadow.innerHTML = `
            <style>
                :host, :host * {
                    -webkit-tap-highlight-color: transparent !important;
                }
                :host *:focus,
                :host *:focus-visible,
                :host *:focus-within {
                    outline: none !important;
                    box-shadow: none !important;
                    -webkit-focus-ring-color: transparent;
                }
                :host button:focus,
                :host button:focus-visible,
                :host button:active {
                    outline: none !important;
                    box-shadow: none !important;
                }
                :host { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
                .ts-overlay {
                    position: fixed;
                    inset: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0,0,0,0.55);
                    pointer-events: auto;
                }
                .ts-panel {
                    position: relative;
                    width: min(1420px, 98vw);
                    max-height: 90vh;
                    background: #121212;
                    border: 1px solid #4a9eff;
                    border-radius: 12px;
                    display: flex; flex-direction: column;
                    overflow: hidden;
                    pointer-events: auto;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
                    user-select: none;
                    -webkit-user-select: none;
                    flex-shrink: 1;
                }
                .ts-panel input,
                .ts-panel textarea {
                    -webkit-user-select: text;
                    user-select: text;
                    outline: none !important;
                    caret-color: #4a9eff;
                }
                .ts-header {
                    padding: 14px 18px;
                    border-bottom: 1px solid #2a2a2a;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 12px;
                }
                .ts-title { color: #4a9eff; font-size: 17px; font-weight: 600; margin: 0; }
                .ts-header-right {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    flex-shrink: 0;
                }
                .ts-version { color: #666; font-size: 12px; }
                .ts-close {
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 8px;
                    border: 1px solid rgba(120, 20, 28, 0.45);
                    background: rgba(0, 0, 0, 0.35);
                    color: #ff3860;
                    font-size: 22px;
                    font-weight: 700;
                    line-height: 1;
                    padding: 0;
                    cursor: pointer;
                    font-family: inherit;
                }
                .ts-close:hover { color: #ff6b7a; border-color: rgba(227, 41, 47, 0.6); }
                .ts-body {
                    overflow-x: hidden;
                    overflow-y: auto;
                    padding: 6px 0 10px;
                }
                .ts-row {
                    display: flex;
                    flex-direction: row;
                    flex-wrap: nowrap;
                    gap: 12px;
                    justify-content: center;
                    padding: 14px 18px;
                    width: 100%;
                    box-sizing: border-box;
                }
                #ts-gun-row {
                    border-top: 1px solid #2a2a2a;
                    margin-top: 2px;
                }
                .ts-row-label {
                    font-size: 11px;
                    color: #666;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                    padding: 12px 18px 0;
                }
                .ts-slot {
                    flex: 0 0 128px;
                    width: 128px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 6px;
                }
                .ts-preview-wrap {
                    position: relative;
                    width: 124px;
                    height: 54px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0,0,0,0.35);
                    border-radius: 8px;
                    overflow: hidden;
                }
                .ts-preview-wrap.is-melee { height: 64px; }
                .ts-preview-bg {
                    position: absolute;
                    left: 50%;
                    top: 22%;
                    transform: translate(-50%, -22%);
                    max-width: 72%;
                    max-height: 70%;
                    opacity: 0;
                    pointer-events: none;
                    filter: invert(1);
                }
                .ts-preview-render {
                    position: absolute;
                    left: 50%;
                    top: 22%;
                    transform: translate(-50%, -22%);
                    max-width: 90%;
                    max-height: 82%;
                    width: auto;
                    height: auto;
                    object-fit: contain;
                    display: none;
                    pointer-events: none;
                    filter: drop-shadow(0 2px 6px rgba(0,0,0,0.55));
                }
                .ts-preview-wrap.has-preview .ts-preview-render { display: block; }
                .ts-preview-wrap.has-preview .ts-preview-empty { display: none; }
                .ts-preview-empty {
                    font-size: 11px;
                    color: #555;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .ts-preview-wrap[data-preview="render"] .ts-preview-render { max-width: 94%; max-height: 86%; }
                .ts-preview-wrap[data-preview="texture"] .ts-preview-render {
                    max-width: 100%;
                    max-height: 100%;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    object-fit: contain;
                }
                .ts-preview-wrap[data-weapon-id="bayonet"] .ts-preview-render,
                .ts-preview-wrap[data-weapon-id="tomahawk"] .ts-preview-render {
                    top: 20%; transform: translate(-50%, -20%); max-height: 88%;
                }
                .ts-preview-wrap[data-weapon-id="lar"] .ts-preview-render,
                .ts-preview-wrap[data-weapon-id="m60"] .ts-preview-render,
                .ts-preview-wrap[data-weapon-id="scar"] .ts-preview-render {
                    max-width: 96%; max-height: 76%; top: 21%; transform: translate(-50%, -21%);
                }
                .ts-preview-wrap[data-weapon-id="shark"] .ts-preview-render,
                .ts-preview-wrap[data-weapon-id="ar9"] .ts-preview-render,
                .ts-preview-wrap[data-weapon-id="revolver"] .ts-preview-render {
                    max-width: 86%; max-height: 72%; top: 23%; transform: translate(-50%, -23%);
                }
                .ts-head {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    min-height: 22px;
                }
                .ts-carrot {
                    flex: 0 0 auto;
                    width: 18px;
                    height: 18px;
                    padding: 0;
                    border: none;
                    background: transparent;
                    color: #4a9eff;
                    font-size: 10px;
                    line-height: 1;
                    cursor: pointer;
                    font-family: inherit;
                }
                .ts-carrot:hover { color: #7bb8ff; }
                .ts-slot.is-open .ts-carrot { color: #7bb8ff; }
                .ts-label {
                    color: #ccc;
                    font-size: 12px;
                    font-weight: 600;
                    text-align: center;
                    line-height: 1.2;
                    flex: 0 1 auto;
                }
                .ts-drawer {
                    width: 100%;
                    display: none;
                    flex-direction: column;
                    align-items: stretch;
                    gap: 6px;
                    padding-top: 2px;
                }
                .ts-slot.is-open .ts-drawer { display: flex; }
                .ts-controls {
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                    align-items: stretch;
                    gap: 6px;
                }
                .ts-btn-row {
                    display: flex;
                    gap: 6px;
                    width: 100%;
                }
                .ts-btn {
                    flex: 1;
                    padding: 5px 0;
                    font-size: 12px;
                    font-weight: 600;
                    border-radius: 6px;
                    border: 1px solid #333;
                    background: #1a1a1a;
                    color: #aaa;
                    cursor: pointer;
                    font-family: inherit;
                }
                .ts-btn:hover { border-color: #4a9eff; color: #fff; }
                .ts-btn-rst { color: #c9a8ff; border-color: #3a2f55; }
                .ts-btn-rnd { color: #8ec4ff; border-color: #2a3f55; }
                .ts-dd-wrap {
                    position: relative;
                    width: 100%;
                }
                .ts-dd-btn {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    padding: 7px 8px;
                    border-radius: 6px;
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    background: rgba(0, 0, 0, 0.35);
                    color: #ddd;
                    font-family: inherit;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    text-align: left;
                }
                .ts-dd-btn:hover {
                    border-color: rgba(74, 158, 255, 0.45);
                    background: rgba(74, 158, 255, 0.08);
                }
                .ts-dd-label {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    flex: 1;
                    min-width: 0;
                }
                .ts-dd-caret {
                    flex-shrink: 0;
                    opacity: 0.55;
                    font-size: 10px;
                }
                .ts-dd-list {
                    display: none;
                    position: absolute;
                    top: calc(100% + 4px);
                    left: 0;
                    right: 0;
                    min-width: 210px;
                    max-height: 240px;
                    overflow-y: auto;
                    z-index: 100010;
                    background: #16161a;
                    border: 1px solid rgba(74, 158, 255, 0.35);
                    border-radius: 8px;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
                    padding: 4px 0;
                }
                .ts-dd-list::-webkit-scrollbar { width: 8px; }
                .ts-dd-list::-webkit-scrollbar-track { background: transparent; }
                .ts-dd-list::-webkit-scrollbar-thumb {
                    background: #3a3a42;
                    border-radius: 4px;
                }
                .ts-dd-list::-webkit-scrollbar-thumb:hover { background: #4a4a55; }
                .ts-dd-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    padding: 9px 10px 9px 12px;
                    cursor: pointer;
                    font-size: 12px;
                    line-height: 1.35;
                }
                .ts-dd-item-name {
                    flex: 1;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    color: #e8e8e8;
                }
                .ts-dd-fav {
                    flex: 0 0 auto;
                    width: 22px;
                    height: 22px;
                    padding: 0;
                    border: none;
                    background: transparent;
                    color: rgba(255, 255, 255, 0.35);
                    font-size: 14px;
                    line-height: 1;
                    cursor: pointer;
                    font-family: inherit;
                }
                .ts-dd-fav.is-on { color: #ff6b9d; }
                .ts-dd-fav:hover { color: #ff8e95; }
                .ts-dd-empty {
                    cursor: default;
                    color: #666;
                    justify-content: center;
                }
                .ts-fav-dd-btn .ts-dd-label { color: #c9a8ff; }
                .ts-tab-bar {
                    display: flex;
                    gap: 6px;
                    padding: 10px 18px 0;
                    border-bottom: 1px solid #2a2a2a;
                }
                .ts-tab {
                    padding: 8px 16px;
                    border: 1px solid transparent;
                    border-bottom: none;
                    border-radius: 8px 8px 0 0;
                    background: transparent;
                    color: #888;
                    font-size: 12px;
                    font-weight: 600;
                    cursor: pointer;
                    font-family: inherit;
                }
                .ts-tab.is-active {
                    color: #4a9eff;
                    background: rgba(74, 158, 255, 0.08);
                    border-color: #2a2a2a;
                }
                .ts-tab-more { font-size: 18px; line-height: 1; padding: 6px 14px; }
                .ts-tab-panel[hidden] { display: none !important; }
                .ts-more-title {
                    font-size: 15px;
                    font-weight: 700;
                    color: #fff;
                    padding: 16px 18px 10px;
                }
                .ts-more-desc {
                    color: #666;
                    font-size: 11px;
                    line-height: 1.45;
                    padding: 12px 18px 16px;
                }
                .ts-catalog-search-wrap {
                    position: relative;
                    padding: 0 18px;
                }
                .ts-catalog-search {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 10px 12px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    background: rgba(0, 0, 0, 0.35);
                    color: #fff;
                    font-size: 13px;
                    font-family: inherit;
                }
                .ts-catalog-search::placeholder { color: rgba(255, 255, 255, 0.35); }
                .ts-catalog-suggestions {
                    display: none;
                    position: absolute;
                    top: calc(100% + 4px);
                    left: 18px;
                    right: 18px;
                    max-height: 220px;
                    overflow-y: auto;
                    z-index: 100020;
                    background: #16161a;
                    border: 1px solid rgba(74, 158, 255, 0.35);
                    border-radius: 8px;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
                }
                .ts-catalog-suggestion {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    padding: 9px 12px;
                    cursor: pointer;
                    font-size: 13px;
                }
                .ts-catalog-suggestion:hover { background: rgba(74, 158, 255, 0.12); }
                .ts-catalog-suggestion-sub {
                    font-size: 11px;
                    color: rgba(255, 255, 255, 0.45);
                }
                .ts-catalog-selected {
                    display: none;
                    padding: 14px 18px 0;
                    gap: 6px;
                    flex-direction: column;
                }
                .ts-catalog-selected.is-visible { display: flex; }
                .ts-catalog-selected-name {
                    font-size: 15px;
                    font-weight: 700;
                    color: #fff;
                }
                .ts-catalog-selected-weapon,
                .ts-catalog-selected-rarity {
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.55);
                }
                .ts-catalog-actions {
                    display: flex;
                    gap: 8px;
                    padding: 12px 18px 0;
                }
                .ts-catalog-actions .ts-btn { flex: 1; padding: 8px 10px; }
                .ts-catalog-add { color: #4a9eff; border-color: rgba(74, 158, 255, 0.45); }
                .ts-catalog-add.is-just-added {
                    color: #2cff7c;
                    border-color: rgba(44, 255, 124, 0.45);
                }
                .ts-catalog-add.is-added { color: #888; }
                .ts-catalog-status {
                    padding: 8px 18px 0;
                    font-size: 11px;
                    color: #666;
                }
                .ts-dd-item:hover { background: rgba(74, 158, 255, 0.12); }
                .ts-dd-item.is-selected { background: rgba(74, 158, 255, 0.16); }
                .ts-tab-panel {
                    overflow-x: hidden;
                    overflow-y: auto;
                }
                .ts-hint {
                    color: #555;
                    font-size: 12px;
                    text-align: left;
                    flex: 1;
                    min-width: 0;
                }
                .ts-footer {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 10px 18px;
                    border-top: 1px solid #2a2a2a;
                }
                .ts-footer-actions {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    flex-shrink: 0;
                }
                .ts-footer-actions .ts-btn {
                    flex: 0 0 auto;
                    min-width: 96px;
                    padding: 6px 12px;
                    font-size: 11px;
                }
            </style>
            <div class="ts-overlay" id="ts-overlay">
            <div class="ts-panel" id="ts-panel">
                <div class="ts-header">
                    <h2 class="ts-title">Texture Swapper</h2>
                    <div class="ts-header-right">
                        <span class="ts-version">v${VERSION}</span>
                        <button type="button" class="ts-close" id="ts-close" title="Close">×</button>
                    </div>
                </div>
                <div class="ts-tab-bar">
                    <button type="button" class="ts-tab is-active" id="ts-tab-btn-main">Main</button>
                    <button type="button" class="ts-tab ts-tab-more" id="ts-tab-btn-more" title="More">⋯</button>
                </div>
                <div class="ts-body" id="ts-body">
                    <div class="ts-tab-panel" id="ts-tab-main">
                        <div class="ts-row-label">Melee</div>
                        <div id="ts-melee-row"></div>
                        <div class="ts-row-label">Guns</div>
                        <div id="ts-gun-row"></div>
                    </div>
                    <div class="ts-tab-panel" id="ts-tab-more" hidden></div>
                </div>
                <div class="ts-footer">
                    <div class="ts-hint">ctrl+o to toggle -#KLKLYH</div>
                    <div class="ts-footer-actions">
                        <button type="button" class="ts-btn ts-btn-rst" id="ts-reset-all">Reset all</button>
                        <button type="button" class="ts-btn ts-btn-rnd" id="ts-random-all">Randomize all</button>
                    </div>
                </div>
            </div>
            </div>
        `;

        const meleeMount = shadow.getElementById('ts-melee-row');
        const gunMount = shadow.getElementById('ts-gun-row');

        const meleeRow = document.createElement('div');
        meleeRow.className = 'ts-row';
        meleeMount.appendChild(meleeRow);
        for (let i = 0; i < MELEE_ORDER.length; i++) {
            createWeaponSlot(shadow, meleeRow, MELEE_ORDER[i]);
        }

        const gunRow = document.createElement('div');
        gunRow.className = 'ts-row';
        gunMount.appendChild(gunRow);
        for (let i = 0; i < GUN_ORDER.length; i++) {
            createWeaponSlot(shadow, gunRow, GUN_ORDER[i]);
        }

        initCatalogFinder(shadow);

        const mainTabBtn = shadow.getElementById('ts-tab-btn-main');
        const moreTabBtn = shadow.getElementById('ts-tab-btn-more');
        mainTabBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            switchMenuTab('main');
            mainTabBtn.blur();
        });
        moreTabBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            switchMenuTab('more');
            moreTabBtn.blur();
        });
        preventFocusFlash(mainTabBtn);
        preventFocusFlash(moreTabBtn);
        restoreMenuTab();

        shadow.getElementById('ts-overlay').addEventListener('click', function (e) {
            if (e.target.id === 'ts-overlay') closeMenu();
        });
        shadow.getElementById('ts-panel').addEventListener('mousedown', function (e) {
            const t = e.target;
            if (t && t.closest && t.closest('input, textarea')) return;
            if (
                t && t.closest && t.closest(
                    'button, .ts-dd-list, .ts-catalog-suggestions, .ts-catalog-search'
                )
            ) {
                e.preventDefault();
            }
        }, true);
        shadow.getElementById('ts-panel').addEventListener('click', function (e) {
            e.stopPropagation();
            const path = e.composedPath ? e.composedPath() : [];
            let insideDropdown = false;
            let insideCatalogSearch = false;
            for (let i = 0; i < path.length; i++) {
                const el = path[i];
                if (!el || !el.classList) continue;
                if (el.classList.contains('ts-dd-wrap') || el.classList.contains('ts-dd-list')) {
                    insideDropdown = true;
                }
                if (el.classList.contains('ts-catalog-search-wrap') || el.classList.contains('ts-catalog-suggestions')) {
                    insideCatalogSearch = true;
                }
            }
            if (!insideDropdown) closeAllSkinDropdowns();
            if (!insideCatalogSearch) {
                const suggestions = shadow.querySelectorAll('.ts-catalog-suggestions');
                for (let j = 0; j < suggestions.length; j++) {
                    suggestions[j].style.display = 'none';
                }
            }
        });

        const closeBtn = shadow.getElementById('ts-close');
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            closeMenu();
            closeBtn.blur();
        });
        preventFocusFlash(closeBtn);

        const resetAllBtn = shadow.getElementById('ts-reset-all');
        resetAllBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            resetAllSwaps();
            resetAllBtn.blur();
        });
        preventFocusFlash(resetAllBtn);

        const randomAllBtn = shadow.getElementById('ts-random-all');
        randomAllBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            randomizeAllSwaps();
            randomAllBtn.blur();
        });
        preventFocusFlash(randomAllBtn);

        document.body.appendChild(menuHost);
        menuInitialized = true;
        restoreExpandedWeapon();
    }

    function refreshAllSlotSelects() {
        for (const weaponId in slotUiByWeapon) {
            if (slotUiByWeapon[weaponId].dropdown) {
                slotUiByWeapon[weaponId].dropdown.refresh();
            }
            if (slotUiByWeapon[weaponId].favDropdown) {
                slotUiByWeapon[weaponId].favDropdown.refresh();
            }
            updateSlotPreview(weaponId, getSwapTargetForWeapon(weaponId));
        }
    }

    function setMenuOpen(open) {
        if (!menuHost) return;
        menuOpen = !!open;
        menuHost.style.display = open ? 'block' : 'none';
        menuHost.style.pointerEvents = open ? 'auto' : 'none';
        if (open) {
            refreshAllSlotSelects();
            restoreExpandedWeapon();
        } else {
            closeAllSkinDropdowns();
        }
    }

    function closeMenu() {
        setMenuOpen(false);
    }

    function toggleMenu() {
        if (!skinsCatalogReady) {
            console.warn('[TextureSwapper] Catalog still loading…');
            return;
        }
        if (!document.body) return;
        if (!menuInitialized) initMenu();
        setMenuOpen(!menuOpen);
    }

    function publishMenuApi() {
        window.__NAP_KIRKA_SWAPPER_TOGGLE__ = toggleMenu;
        window.__kirkaSwapperMenu = {
            toggle: toggleMenu,
            open: function () {
                if (!skinsCatalogReady || !document.body) return;
                if (!menuInitialized) initMenu();
                setMenuOpen(true);
            },
            close: closeMenu,
        };
        if (window.__NAP_PENDING_SWAPPER_TOGGLE__) {
            window.__NAP_PENDING_SWAPPER_TOGGLE__ = false;
            toggleMenu();
        }
    }

    function bindHotkeys() {
        if (window.__kirkaSwapperMenuHotkeyBound) return;
        window.__kirkaSwapperMenuHotkeyBound = true;
        document.addEventListener('keydown', function (event) {
            if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            if (event.key.toLowerCase() !== 'o') return;
            event.preventDefault();
            event.stopPropagation();
            toggleMenu();
        }, true);
    }

    function boot() {
        bindHotkeys();
        publishMenuApi();
        bootstrapSavedSwaps();
        initMatchWarmObserver();
        console.log('[TextureSwapper] Ready — Ctrl+O for menu');
    }

    loadSkinCatalog().then(boot).catch(function (err) {
        console.error('[TextureSwapper] Could not start:', err);
    });
})();
