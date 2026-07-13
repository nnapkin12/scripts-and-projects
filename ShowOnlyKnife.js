// ==UserScript==
// @name         Kirka Texture Swapper + Knife Only 
// @namespace    https://github.com/nnapkin12/scripts-and-projects
// @version      1.22.0
// @description  Client-side texture swapper, melee-only, wireframe, gun scale, skin finder for skins not in dropdown you would like to add.
// @author       nap
// @match        https://kirka.io/*
// @grant        none
// @connect      raw.githubusercontent.com
// @connect      githubusercontent.com
// @connect      kirka.lukeskywalk.com
// @connect      kirka.io
// @run-at       document-start
// ==/UserScript==

// Kirka — Texture Swapper + Knife Only  | inhib#KLKLYH
// Credits: imnotkoolkids wireframe/gunscale/rgb base, kirka.lukeskywalk.com render previews
// Ctrl+O opens menu. Skin catalog: https://github.com/nnapkin12/scripts-and-projects/blob/main/skins.json

(function () {
    'use strict';

    
    // EMBEDDED WEBGL BRIDGE — single getContext hook shared by thi
    
    const HOOKED_METHODS = [
      'texImage2D',
      'texSubImage2D',
      'copyTexImage2D',
      'generateMipmap',
      'deleteTexture',
      'clear',
      'bindTexture',
      'uniformMatrix4fv',
      'drawElements',
      'drawArrays',
    ];

    function createWebGlBridge() {
      const handlers = Object.create(null);
      HOOKED_METHODS.forEach((method) => {
        handlers[method] = new Set();
      });

      const hookedContexts = new WeakSet();
      const contextRecords = new WeakMap();
      const contextListeners = new Set();
      const hookedGlList = [];
      let getContextHooked = false;

      function hasHandlers(method) {
        return handlers[method].size > 0;
      }

      function runHandlers(method, ctx) {
        const set = handlers[method];
        if (!set.size) {
          return;
        }
        for (const handler of set) {
          handler(ctx);
          if (ctx.skip) {
            return;
          }
        }
      }

      function captureNatives(gl) {
        return {
          texImage2D: gl.texImage2D.bind(gl),
          texSubImage2D: gl.texSubImage2D ? gl.texSubImage2D.bind(gl) : null,
          copyTexImage2D: gl.copyTexImage2D ? gl.copyTexImage2D.bind(gl) : null,
          generateMipmap: gl.generateMipmap ? gl.generateMipmap.bind(gl) : null,
          deleteTexture: gl.deleteTexture ? gl.deleteTexture.bind(gl) : null,
          clear: gl.clear.bind(gl),
          bindTexture: gl.bindTexture.bind(gl),
          uniformMatrix4fv: gl.uniformMatrix4fv.bind(gl),
          drawElements: gl.drawElements.bind(gl),
          drawArrays: gl.drawArrays.bind(gl),
        };
      }

      function installMethodWrapper(gl, method, record) {
        const natives = record.natives;

        if (method === 'uniformMatrix4fv') {
          gl.uniformMatrix4fv = function uniformMatrixWrapper(...callArgs) {
            const ctx = {
              gl,
              args: callArgs,
              natives,
              skip: false,
              matrixOverride: null,
              meta: {},
            };
            runHandlers(method, ctx);
            if (ctx.skip) {
              return undefined;
            }
            if (ctx.matrixOverride) {
              const location = callArgs[0];
              const transpose = callArgs[1];
              return natives.uniformMatrix4fv(location, transpose, ctx.matrixOverride, 0, 16);
            }
            return natives.uniformMatrix4fv.apply(gl, callArgs);
          };
          return;
        }

        if (method === 'drawElements' || method === 'drawArrays') {
          gl[method] = function drawWrapper(...callArgs) {
            const ctx = {
              gl,
              args: callArgs,
              natives,
              skip: false,
              modeOverride: null,
              meta: {},
            };
            runHandlers(method, ctx);
            if (ctx.skip) {
              return undefined;
            }
            const mode = ctx.modeOverride != null ? ctx.modeOverride : callArgs[0];
            return natives[method].call(gl, mode, ...callArgs.slice(1));
          };
          return;
        }

        if (method === 'copyTexImage2D') {
          gl[method] = function copyTexWrapper(...callArgs) {
            const ctx = {
              gl,
              args: callArgs,
              natives,
              skip: false,
              meta: {},
              phase: 'before',
              result: undefined,
            };
            runHandlers(method, ctx);
            if (ctx.skip) {
              return undefined;
            }
            const result = natives.copyTexImage2D.apply(gl, callArgs);
            ctx.phase = 'after';
            ctx.result = result;
            runHandlers(method, ctx);
            return result;
          };
          return;
        }

        gl[method] = function methodWrapper(...callArgs) {
          const ctx = {
            gl,
            args: callArgs,
            natives,
            skip: false,
            meta: {},
          };
          runHandlers(method, ctx);
          if (ctx.skip) {
            return undefined;
          }
          return natives[method].apply(gl, callArgs);
        };
      }

      function syncMethod(gl, method) {
        const record = contextRecords.get(gl);
        if (!record || !record.natives[method]) {
          return;
        }

        if (hasHandlers(method)) {
          if (!record.installed.has(method)) {
            installMethodWrapper(gl, method, record);
            record.installed.add(method);
          }
        } else if (record.installed.has(method)) {
          gl[method] = record.natives[method];
          record.installed.delete(method);
        }
      }

      function syncAllMethods(gl) {
        for (let i = 0; i < HOOKED_METHODS.length; i += 1) {
          syncMethod(gl, HOOKED_METHODS[i]);
        }
      }

      function syncAllContexts() {
        for (let i = 0; i < hookedGlList.length; i += 1) {
          syncAllMethods(hookedGlList[i]);
        }
      }

      function hookGlContext(gl) {
        if (!gl) {
          return null;
        }

        if (hookedContexts.has(gl)) {
          return contextRecords.get(gl).natives;
        }

        hookedContexts.add(gl);
        const natives = captureNatives(gl);
        contextRecords.set(gl, {
          natives,
          installed: new Set(),
        });
        hookedGlList.push(gl);
        syncAllMethods(gl);

        contextListeners.forEach((listener) => {
          try {
            listener(gl, natives);
          } catch (err) {
            console.error('[Kirka GL Bridge] Context listener failed:', err);
          }
        });

        return natives;
      }

      function installGetContextHook() {
        if (getContextHooked) {
          return;
        }

        const proto = HTMLCanvasElement.prototype;
        const originalGetContext = proto.getContext;

        proto.getContext = function patchedGetContext(type, attrs) {
          const ctx = originalGetContext.call(this, type, attrs);
          if (ctx && typeof type === 'string' && /webgl/i.test(type)) {
            hookGlContext(ctx);
          }
          return ctx;
        };

        getContextHooked = true;
      }

      function removeHandler(method, handler) {
        if (!handlers[method]) {
          return;
        }
        handlers[method].delete(handler);
        syncAllContexts();
      }

      function register(method, handler) {
        if (!handlers[method]) {
          throw new Error(`[Kirka GL Bridge] Unknown method: ${method}`);
        }
        handlers[method].add(handler);
        syncAllContexts();
        return function unregisterHandler() {
          removeHandler(method, handler);
        };
      }

      function unregister(method, handler) {
        removeHandler(method, handler);
      }

      function onContext(listener) {
        contextListeners.add(listener);
        return function removeListener() {
          contextListeners.delete(listener);
        };
      }

      function getNatives(gl) {
        const record = contextRecords.get(gl);
        return record ? record.natives : null;
      }

      return {
        installGetContextHook,
        hookGlContext,
        register,
        unregister,
        onContext,
        getNatives,
        hasHandlers,
      };
    }



    function ensureWebGlBridge() {
        if (window.__NAP_GL_BRIDGE__) return window.__NAP_GL_BRIDGE__;
        const bridge = createWebGlBridge();
        bridge.installGetContextHook();
        window.__NAP_GL_BRIDGE__ = bridge;
        return bridge;
    }

const VM_VERSION = '1.22.0';

    // skin catalog loaded from external JSON (see SKINS_JSON_URL)
    let SKIN_DATABASE = {};
    let SKIN_RENDER_URLS = {};

    // Catalog: https://github.com/nnapkin12/scripts-and-projects/blob/main/skins.json
    const SKINS_JSON_URL = 'https://raw.githubusercontent.com/nnapkin12/scripts-and-projects/main/skins.json';
    const SKINS_CACHE_KEY = 'kirka-swapper-skins-v2';
    const SKINS_VERSION_KEY = 'kirka-swapper-skins-version';

    function getCatalogVersion(payload) {
        if (!payload) return '';
        return String(payload.version || payload.generated || '');
    }

    const RARITY_FROM_CODE = {
        0: 'Common',
        1: 'Rare',
        2: 'Epic',
        3: 'Legendary',
        4: 'Mythical',
        5: 'Paranormal',
    };

    function shortKeyToHash(shortKey) {
        if (!shortKey) return null;
        return shortKey.indexOf('.webp') !== -1 ? shortKey : ('texture.' + shortKey + '.webp');
    }

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

    let GUN_SETS = {};
    let GUN_SET_ORDER = [];
    let gunSetLabelsByWeaponHash = {};

    function rebuildGunSetLabelsIndex() {
        gunSetLabelsByWeaponHash = {};
        for (let i = 0; i < GUN_SET_ORDER.length; i++) {
            const setId = GUN_SET_ORDER[i];
            const set = GUN_SETS[setId];
            if (!set) continue;
            for (const weaponId in set.skins) {
                const hash = set.skins[weaponId];
                if (!gunSetLabelsByWeaponHash[weaponId]) gunSetLabelsByWeaponHash[weaponId] = {};
                if (!gunSetLabelsByWeaponHash[weaponId][hash]) gunSetLabelsByWeaponHash[weaponId][hash] = [];
                gunSetLabelsByWeaponHash[weaponId][hash].push(set.label);
            }
        }
    }

    function getGunSetLabelsForSkin(weaponId, hash) {
        if (!weaponId || !hash || hash === 'none') return [];
        const bucket = gunSetLabelsByWeaponHash[weaponId];
        if (!bucket) return [];
        const file = normalizeTextureFilename(hash) || hash;
        return bucket[hash] || bucket[file] || [];
    }

    function buildGunSetsFromPayload(payload) {
        GUN_SETS = {};
        GUN_SET_ORDER = [];
        const raw = payload && payload.gunSets;
        if (!raw || typeof raw !== 'object') {
            rebuildGunSetLabelsIndex();
            return;
        }

        for (const setId in raw) {
            const entry = raw[setId];
            if (!entry || !entry.skins) continue;
            const skins = {};
            for (const weaponId in entry.skins) {
                if (!WEAPON_REGISTRY[weaponId] || WEAPON_REGISTRY[weaponId].tab !== 'guns') continue;
                const hash = shortKeyToHash(entry.skins[weaponId]);
                if (hash) skins[weaponId] = hash;
            }
            if (!Object.keys(skins).length) continue;
            GUN_SETS[setId] = {
                label: entry.label || setId,
                skins: skins,
            };
            GUN_SET_ORDER.push(setId);
        }
        rebuildGunSetLabelsIndex();
    }

    function hydrateSkinCatalog(payload) {
        SKIN_DATABASE = {};
        SKIN_RENDER_URLS = {};
        if (!payload || !payload.skins) throw new Error('Invalid skins payload');

        for (const shortKey in payload.skins) {
            const row = payload.skins[shortKey];
            const hash = shortKey.indexOf('.webp') !== -1 ? shortKey : ('texture.' + shortKey + '.webp');
            const flags = row[3] || 0;
            const entry = {
                weapon: row[0],
                name: row[1],
                rarity: RARITY_FROM_CODE[row[2]] || 'Mythical',
            };
            if (flags & 2) entry.swappable = true;
            SKIN_DATABASE[hash] = entry;
        }

        const renders = payload.renders || {};
        const renderBases = payload.renderBases || null;
        for (const shortKey in renders) {
            const hash = shortKey.indexOf('.webp') !== -1 ? shortKey : ('texture.' + shortKey + '.webp');
            const raw = renders[shortKey];
            if (typeof raw === 'string') {
                SKIN_RENDER_URLS[hash] = raw;
            } else if (Array.isArray(raw) && raw.length >= 2 && renderBases) {
                const base = renderBases[raw[0]];
                SKIN_RENDER_URLS[hash] = base ? (base + raw[1]) : '';
            }
        }
        userExtraSkinsCache = null;
        buildSkinDerivedData();
        buildGunSetsFromPayload(payload);
        syncTextureSets();
    }

    let swapTargetsPreloaded = false;

    function forEachActiveSavedSwap(callback) {
        for (const weaponId in WEAPON_REGISTRY) {
            const target = getSwapTargetForWeapon(weaponId);
            if (target && target !== 'none') callback(weaponId, target);
        }
    }

    function preloadSavedSwapTargets() {
        forEachActiveSavedSwap(function (weaponId, target) {
            preloadSwapTexture(target);
        });
    }

    function refreshAllSavedSwapWeapons() {
        forEachActiveSavedSwap(function (weaponId) {
            requestRefreshWeaponSwap(weaponId);
        });
    }

    function bootstrapSavedSwaps() {
        if (!anySwapActive) return;
        preloadSavedSwapTargetsOnce();
        let pending = 0;
        forEachActiveSavedSwap(function (weaponId, target) {
            pending += 1;
            preloadSwapTexture(target, function () {
                pending -= 1;
                if (pending <= 0) {
                    refreshAllSavedSwapWeapons();
                }
            });
        });
        if (pending === 0) {
            refreshAllSavedSwapWeapons();
        }
    }

    function scheduleSavedSwapBootstrap() {
        if (!anySwapActive) return;
        bootstrapSavedSwaps();
    }

    function preloadSavedSwapTargetsOnce() {
        if (swapTargetsPreloaded) return;
        swapTargetsPreloaded = true;
        preloadSavedSwapTargets();
    }

    let skinsCatalogReady = false;
    let skinsCatalogError = null;

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
                console.log('[ShowOnlyKnife] Skin catalog ready (' + Object.keys(SKIN_DATABASE).length + ' skins, v' + remoteVersion + ')');
            } else {
                console.log('[ShowOnlyKnife] Skin catalog current (v' + storedVersion + ', ' + Object.keys(SKIN_DATABASE).length + ' skins)');
            }

            skinsCatalogReady = true;
        } catch (err) {
            skinsCatalogError = err;
            console.error('[ShowOnlyKnife] Skin catalog load failed:', err);
            if (!skinsCatalogReady) throw err;
        }
    }


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

    const GUN_TAB_WEAPON_ORDER = ['ar9', 'wheatie', 'mac10', 'scar', 'vita', 'shark', 'm60', 'revolver', 'lar'];

    const TEXTURE_CDN = 'https://kirka.io/assets/img/';

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

    function buildLukeRenderUrl(weaponId, skinName) {
        const folder = RENDER_WEAPON_FOLDER[weaponId];
        if (!folder || !skinName) return null;
        return 'https://kirka.lukeskywalk.com/static/renders/' + folder + '/' + encodeURIComponent(skinName + '-render.webp');
    }

    function resolveRenderWeaponId(weaponIdHint, catalogWeapon) {
        if (weaponIdHint && RENDER_WEAPON_FOLDER[weaponIdHint]) return weaponIdHint;
        if (catalogWeapon && RENDER_WEAPON_FOLDER[catalogWeapon]) return catalogWeapon;
        if (catalogWeapon) {
            const lookup = lookupWeaponIdByLabel(String(catalogWeapon));
            if (lookup && RENDER_WEAPON_FOLDER[lookup]) return lookup;
        }
        return weaponIdHint || catalogWeapon || null;
    }

    function isFullLukeRenderUrl(url) {
        return !!url
            && String(url).indexOf('lukeskywalk.com/static/renders/') !== -1
            && String(url).indexOf('render-mini.') === -1;
    }

    // --- Preview URLs: Luke full render → built URL → kirka.io mini → texture CDN ---
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

        if (catalogRender && isFullLukeRenderUrl(catalogRender)) add(catalogRender);

        if (skin) {
            const weaponKey = resolveRenderWeaponId(weaponIdHint, skin.weapon);
            const built = buildLukeRenderUrl(weaponKey, skin.name);
            if (built) add(built);
        }

        const kirkaMini = buildKirkaRenderMiniUrl(file);
        if (kirkaMini) add(kirkaMini);

        if (renderOnly) return out;

        if (catalogRender) add(catalogRender);
        add(TEXTURE_CDN + file);
        return out;
    }

    function getSkinPreviewUrl(textureKey, weaponIdHint) {
        const file = normalizeTextureFilename(textureKey);
        if (!file) return null;
        const catalogRender = SKIN_RENDER_URLS[file];
        const skin = SKIN_DATABASE[file];

        if (catalogRender) return catalogRender;

        if (skin) {
            const weaponKey = resolveRenderWeaponId(weaponIdHint, skin.weapon);
            const built = buildLukeRenderUrl(weaponKey, skin.name);
            if (built) return built;
        }

        const kirkaMini = buildKirkaRenderMiniUrl(file);
        if (kirkaMini) return kirkaMini;
        return TEXTURE_CDN + file;
    }

    function isLukeRenderUrl(url) {
        if (!url) return false;
        const src = String(url);
        return src.indexOf('lukeskywalk.com/static/renders/') !== -1
            || src.indexOf('kirka.io/assets/img/render-mini.') !== -1;
    }

    const SWAP_IMAGE_CACHE_MAX = 48;

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

    // --- Menu preview image loader (Luke / kirka.io mini render fallbacks) ---
    function applyPreviewImagePresentation(box, img, previewUrl) {
        const isRender = isLukeRenderUrl(previewUrl);
        box.classList.toggle('melee-vm-preview-render', isRender);
    }

    function loadPreviewImageWithFallback(img, box, candidates, index) {
        if (!candidates || index >= candidates.length) {
            img.onload = null;
            img.onerror = null;
            img.style.display = 'none';
            img.removeAttribute('src');
            box.classList.remove('melee-vm-preview-render');
            return;
        }

        const url = candidates[index];
        img.onload = function () {
            img.onload = null;
            img.onerror = null;
            if (img.naturalWidth > 0) {
                applyPreviewImagePresentation(box, img, url);
                img.style.display = 'block';
                return;
            }
            loadPreviewImageWithFallback(img, box, candidates, index + 1);
        };
        img.onerror = function () {
            img.onload = null;
            img.onerror = null;
            loadPreviewImageWithFallback(img, box, candidates, index + 1);
        };
        box.classList.remove('melee-vm-preview-render');
        img.style.display = 'none';
        img.src = url;
    }


    const RARITY_STYLES = {
        Common: { bg: '#6fd08c', border: '#1a1a1a', text: '#fff', shadow: '0 1px 2px rgba(0,0,0,0.85)' },
        Rare: { bg: '#58b9ea', border: '#1a1a1a', text: '#fff', shadow: '0 1px 2px rgba(0,0,0,0.85)' },
        Mythical: { bg: '#ff2a2a', border: '#1a1a1a', text: '#fff', shadow: '0 1px 2px rgba(0,0,0,0.85)' },
        Epic: { bg: '#a335ee', border: '#1a1a1a', text: '#fff', shadow: '0 1px 2px rgba(0,0,0,0.85)' },
        Paranormal: { bg: '#000000', border: '#2a2a2a', text: '#fff', shadow: '0 1px 2px rgba(0,0,0,0.85)' },
        Legendary: { bg: '#f5b82e', border: '#1a1a1a', text: '#fff', shadow: '0 1px 2px rgba(0,0,0,0.85)' },
    };

    let swappableByWeapon = {};

    const meleeTextureSet = new Set();
    const textureSetsByWeapon = {};
    const fileToWeapon = new Map();
    const glTexturesByWeapon = {};
    const swapRefreshBumpAt = {};
    const TEXTURE_FILE_RE = /texture\.[a-f0-9]+\.webp/i;

    for (const weaponId in WEAPON_REGISTRY) {
        textureSetsByWeapon[weaponId] = new Set();
        glTexturesByWeapon[weaponId] = new Set();
    }

    const lastKnownHashByWeapon = {};
    const latestEquippedHashByWeapon = {};
    let weaponLabelLookup = null;

    for (const weaponId in WEAPON_REGISTRY) {
        lastKnownHashByWeapon[weaponId] = null;
        latestEquippedHashByWeapon[weaponId] = null;
    }

    function getWeaponNameTokens(weaponId) {
        const tokens = new Set();
        const meta = WEAPON_REGISTRY[weaponId];
        if (meta) tokens.add(meta.label.toLowerCase());
        if (RENDER_WEAPON_FOLDER[weaponId]) tokens.add(RENDER_WEAPON_FOLDER[weaponId].toLowerCase());
        tokens.add(String(weaponId).toLowerCase());
        if (weaponId === 'mac10') {
            tokens.add('mac-10');
            tokens.add('mac10');
        }
        if (weaponId === 'ar9') {
            tokens.add('ar-9');
            tokens.add('ar9');
        }
        if (weaponId === 'wheatie') {
            tokens.add('wheatie');
            tokens.add('weatie');
        }
        if (weaponId === 'vita') {
            tokens.add('vita');
        }
        return tokens;
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
        lookup['mac10'] = 'mac10';
        lookup['ar-9'] = 'ar9';
        lookup['ar9'] = 'ar9';
        lookup['weatie'] = 'wheatie';
        weaponLabelLookup = lookup;
        return lookup;
    }

    function lookupWeaponIdByLabel(label) {
        if (!label) return null;
        if (!weaponLabelLookup) buildWeaponLabelLookup();
        return weaponLabelLookup[String(label).trim().toLowerCase()] || null;
    }

    function rememberWeaponSkinHash(weaponId, textureKey) {
        if (!weaponId || !textureKey) return;
        const file = normalizeTextureFilename(textureKey);
        if (!file) return;
        lastKnownHashByWeapon[weaponId] = file;
    }

    function resolveEquippedHashFromTextures(weaponId) {
        const latest = latestEquippedHashByWeapon[weaponId];
        if (latest) return normalizeTextureFilename(latest);
        const pool = glTexturesByWeapon[weaponId];
        if (!pool || !pool.size) return null;
        let found = null;
        pool.forEach(function (tex) {
            if (found) return;
            const orig = textureOriginalFile.get(tex);
            if (orig) found = normalizeTextureFilename(orig);
        });
        return found;
    }

    function getFavStorageKey(weaponId) {
        return 'kirka-fav-' + weaponId;
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

    function buildSkinDerivedData() {
        swappableByWeapon = {};
        for (const weaponId in WEAPON_REGISTRY) {
            swappableByWeapon[weaponId] = { none: 'Equipped' };
        }

        for (const hash in SKIN_DATABASE) {
            const skin = SKIN_DATABASE[hash];
            if (skin.swappable && swappableByWeapon[skin.weapon]) {
                swappableByWeapon[skin.weapon][hash] = skin.name;
            }
        }
        applyUserExtraSkinsToDropdown();
    }

    const USER_EXTRA_SKINS_KEY = 'kirka-user-extra-skins-v1';
    let userExtraSkinsCache = null;

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

    function isSkinInMergedDropdown(weaponId, hash) {
        return isSkinInBuiltInDropdown(weaponId, hash) || isSkinUserAdded(weaponId, hash);
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

    function getCatalogSkinDropdownState(weaponId, hash) {
        if (isSkinUserAdded(weaponId, hash)) {
            return { inDropdown: true, source: 'user' };
        }
        if (isSkinInBuiltInDropdown(weaponId, hash)) {
            return { inDropdown: true, source: 'default' };
        }
        return { inDropdown: false, source: null };
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
                dropdownState: getCatalogSkinDropdownState(skin.weapon, hash),
                rank: rank,
            });
        }

        matches.sort(function (a, b) {
            if (a.rank !== b.rank) return a.rank - b.rank;
            return a.name.localeCompare(b.name);
        });
        return matches.slice(0, max);
    }

    function getWeaponSkinOptions(weaponId) {
        return swappableByWeapon[weaponId] || { none: 'Equipped' };
    }

    function getWeaponTab(weaponId) {
        return weaponId && WEAPON_REGISTRY[weaponId] ? WEAPON_REGISTRY[weaponId].tab : null;
    }

    function isMeleeWeaponId(weaponId) {
        return getWeaponTab(weaponId) === 'melee';
    }

    function isGunWeaponId(weaponId) {
        return getWeaponTab(weaponId) === 'guns';
    }

    function syncTextureSets() {
        meleeTextureSet.clear();
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
            if (isMeleeWeaponId(weapon)) meleeTextureSet.add(lower);
        }
    }

    function getSkinMeta(textureKey) {
        const file = normalizeTextureFilename(textureKey) || textureKey;
        return file ? SKIN_DATABASE[file] : null;
    }

    function getSkinName(textureKey) {
        const meta = getSkinMeta(textureKey);
        return meta ? meta.name : (textureKey || 'Unknown');
    }

    function getSkinRarity(textureKey) {
        const meta = getSkinMeta(textureKey);
        return meta ? meta.rarity : 'Mythical';
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

    const getStorage = (key, fallback) => {
        try {
            const saved = localStorage.getItem(key);
            if (saved === null) return fallback;
            return saved === 'true' ? true : (saved === 'false' ? false : saved);
        } catch (e) { return fallback; }
    };

    const getStorageNum = (key, fallback) => {
        const raw = getStorage(key, fallback);
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : fallback;
    };

    function loadWireframeEnabled() {
        try {
            if (localStorage.getItem('kirka-wireframe-enabled') !== null) {
                return getStorage('kirka-wireframe-enabled', false);
            }
            return getStorage('kirka-wireframe-melee-enabled', false);
        } catch (e) {
            return false;
        }
    }

    function loadWireframeColorA() {
        try {
            const saved = localStorage.getItem('kirka-wireframe-color-a');
            if (saved) return saved;
            return getStorage('kirka-wireframe-melee-color', '#ffffff');
        } catch (e) {
            return '#ffffff';
        }
    }

    function loadWeaponScaleEnabled() {
        try {
            if (localStorage.getItem('kirka-weapon-scale-enabled') !== null) {
                return getStorage('kirka-weapon-scale-enabled', false);
            }
            const scale = getStorageNum('kirka-weapon-scale', 1);
            const ox = getStorageNum('kirka-weapon-offset-x', 0);
            const oy = getStorageNum('kirka-weapon-offset-y', 0);
            const oz = getStorageNum('kirka-weapon-offset-z', 0);
            return scale !== 1 || ox !== 0 || oy !== 0 || oz !== 0;
        } catch (e) {
            return false;
        }
    }

    const cfg = {
        meleeOnlyEnabled: getStorage('kirka-melee-enabled', false),
        wireframeEnabled: loadWireframeEnabled(),
        wireframeMeleeScope: getStorage('kirka-wireframe-melee-scope', true),
        wireframeGunScope: getStorage('kirka-wireframe-gun-scope', false),
        wireframeColorMode: getStorage('kirka-wireframe-color-mode', 'static'),
        wireframeColorA: loadWireframeColorA(),
        wireframeColorB: getStorage('kirka-wireframe-color-b', '#00ffff'),
        wireframePulseHz: getStorageNum('kirka-wireframe-pulse-hz', 1.5),
        weaponScale: getStorageNum('kirka-weapon-scale', 1),
        weaponOffsetX: getStorageNum('kirka-weapon-offset-x', 0),
        weaponOffsetY: getStorageNum('kirka-weapon-offset-y', 0),
        weaponOffsetZ: getStorageNum('kirka-weapon-offset-z', 0),
        weaponScaleEnabled: loadWeaponScaleEnabled(),
        skinSwap: buildSkinSwapCfg(),
    };

    let anySwapActive = false;
    const hookedGlEntries = [];
    let knifeBridgeUnregisters = [];

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

    function updateSwapActiveState() {
        recomputeAnySwapActive();
        refreshKnifeBridgeHandlers();
    }

    function setSwapTargetForWeapon(weaponId, value, skipRecompute) {
        cfg.skinSwap[weaponId] = value;
        try {
            localStorage.setItem(getSkinSwapStorageKey(weaponId), value);
        } catch (_) {}
        if (value && value !== 'none') {
            rememberWeaponSkinHash(weaponId, value);
            preloadSwapTexture(value);
        } else {
            const equipped = resolveEquippedHashFromTextures(weaponId);
            lastKnownHashByWeapon[weaponId] = equipped;
            requestRefreshWeaponSwap(weaponId);
        }
        if (!skipRecompute) updateSwapActiveState();
    }

    recomputeAnySwapActive();
    forEachActiveSavedSwap(function (weaponId, target) {
        rememberWeaponSkinHash(weaponId, target);
    });

    const DEFAULT_WIREFRAME_COLOR = '#ffffff';

    function normalizeWireframeColor(value) {
        if (typeof value !== 'string') return DEFAULT_WIREFRAME_COLOR;
        let hex = value.trim().toLowerCase();
        if (!hex.startsWith('#')) hex = `#${hex}`;
        return /^#[0-9a-f]{6}$/.test(hex) ? hex : DEFAULT_WIREFRAME_COLOR;
    }

    function normalizeWireframeColorMode(value) {
        return value === 'dual' || value === 'rgb' ? value : 'static';
    }

    function normalizeWireframePulseHz(value) {
        const n = parseFloat(value);
        if (!Number.isFinite(n)) return 1.5;
        return Math.max(0.05, Math.min(5, n));
    }

    function hexToRgb(hex) {
        const n = parseInt(normalizeWireframeColor(hex).slice(1), 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    function lerpRgb(a, b, t) {
        return {
            r: Math.round(a.r + (b.r - a.r) * t),
            g: Math.round(a.g + (b.g - a.g) * t),
            b: Math.round(a.b + (b.b - a.b) * t),
        };
    }

    function hslToRgb(h, s, l) {
        s /= 100;
        l /= 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let r = 0;
        let g = 0;
        let b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return {
            r: Math.round((r + m) * 255),
            g: Math.round((g + m) * 255),
            b: Math.round((b + m) * 255),
        };
    }

    cfg.wireframeColorMode = normalizeWireframeColorMode(cfg.wireframeColorMode);
    cfg.wireframeColorA = normalizeWireframeColor(cfg.wireframeColorA);
    cfg.wireframeColorB = normalizeWireframeColor(cfg.wireframeColorB);
    cfg.wireframePulseHz = normalizeWireframePulseHz(cfg.wireframePulseHz);
    cfg.weaponScale = normalizeWeaponScale(cfg.weaponScale);
    cfg.weaponOffsetX = normalizeWeaponOffset(cfg.weaponOffsetX);
    cfg.weaponOffsetY = normalizeWeaponOffset(cfg.weaponOffsetY);
    cfg.weaponOffsetZ = normalizeWeaponOffset(cfg.weaponOffsetZ);

    function normalizeWeaponScale(value) {
        const n = parseFloat(value);
        if (!Number.isFinite(n)) return 1;
        return Math.min(3, Math.max(0.1, n));
    }

    function normalizeWeaponOffset(value) {
        const n = parseFloat(value);
        if (!Number.isFinite(n)) return 0;
        return Math.min(0.5, Math.max(-0.5, n));
    }

    function needsGunScaleMods() {
        if (!cfg.weaponScaleEnabled) return false;
        return normalizeWeaponScale(cfg.weaponScale) !== 1
            || normalizeWeaponOffset(cfg.weaponOffsetX) !== 0
            || normalizeWeaponOffset(cfg.weaponOffsetY) !== 0
            || normalizeWeaponOffset(cfg.weaponOffsetZ) !== 0;
    }

    function columnLength3(m, i) {
        return Math.sqrt(m[i] * m[i] + m[i + 1] * m[i + 1] + m[i + 2] * m[i + 2]);
    }

    function classifyViewmodelMatrix(m) {
        if (!m || m.length < 16) return null;
        if (Math.abs(m[3]) > 0.001) return null;
        if (Math.abs(m[7]) > 0.001) return null;
        if (Math.abs(m[11]) > 0.001) return null;
        if (Math.abs(m[15] - 1.0) > 0.001) return null;

        const sx = columnLength3(m, 0);
        const sy = columnLength3(m, 4);
        const sz = columnLength3(m, 8);
        if (sx < 0.001 || sx > 15.0) return null;
        if (sy < 0.001 || sy > 15.0) return null;
        if (sz < 0.001 || sz > 15.0) return null;

        const distance = Math.sqrt(m[12] * m[12] + m[13] * m[13] + m[14] * m[14]);
        if (distance < 0.001 || distance > 0.6) return null;

        const maxScale = Math.max(sx, sy, sz);
        if (maxScale < 1.7) return 'weapon';

        const minScale = Math.min(sx, sy, sz);
        return maxScale / minScale < 1.05 ? 'weapon' : 'arms';
    }

    const gunScaleScratchMatrix = new Float32Array(16);
    let spectatingCached = false;

    setInterval(function () {
        spectatingCached = !!document.querySelector('.infos .fps');
    }, 250);

    let lastGunScaleModsActive = needsGunScaleMods();

    function persistGunScaleSettings() {
        try {
            localStorage.setItem('kirka-weapon-scale-enabled', String(!!cfg.weaponScaleEnabled));
            localStorage.setItem('kirka-weapon-scale', String(cfg.weaponScale));
            localStorage.setItem('kirka-weapon-offset-x', String(cfg.weaponOffsetX));
            localStorage.setItem('kirka-weapon-offset-y', String(cfg.weaponOffsetY));
            localStorage.setItem('kirka-weapon-offset-z', String(cfg.weaponOffsetZ));
        } catch (_) {}
    }

    function syncGunScaleHookState() {
        const active = needsGunScaleMods();
        if (active !== lastGunScaleModsActive) {
            lastGunScaleModsActive = active;
            refreshKnifeBridgeHandlers();
        }
    }

    function setWeaponScaleEnabled(enabled) {
        cfg.weaponScaleEnabled = !!enabled;
        persistGunScaleSettings();
        syncGunScaleHookState();
    }

    function applyGunScaleSettings() {
        cfg.weaponScale = normalizeWeaponScale(cfg.weaponScale);
        cfg.weaponOffsetX = normalizeWeaponOffset(cfg.weaponOffsetX);
        cfg.weaponOffsetY = normalizeWeaponOffset(cfg.weaponOffsetY);
        cfg.weaponOffsetZ = normalizeWeaponOffset(cfg.weaponOffsetZ);
        persistGunScaleSettings();
        syncGunScaleHookState();
    }

    let meleeOnlyOn = !!cfg.meleeOnlyEnabled;
    let wireframeOn = false;
    let wireframeColorHex = cfg.wireframeColorA;

    function persistWireframeEnabled(value) {
        try {
            localStorage.setItem('kirka-wireframe-enabled', value);
            localStorage.setItem('kirka-wireframe-melee-enabled', value);
        } catch (_) {}
    }

    function needsViewmodelHooks() {
        return meleeOnlyOn || wireframeOn;
    }

    function needsTextureHooks() {
        return true;
    }

    function syncCfgFlags() {
        meleeOnlyOn = !!cfg.meleeOnlyEnabled;
        wireframeOn = !!cfg.wireframeEnabled;
        wireframeColorHex = normalizeWireframeColor(cfg.wireframeColorA);
        refreshKnifeBridgeHandlers();
    }

    function skinSwapActive() {
        return anySwapActive;
    }

    function getSwapTargetForWeapon(weapon) {
        return (cfg.skinSwap && cfg.skinSwap[weapon]) || 'none';
    }

    function loadFavoriteSkins(storageKey) {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(function (k) { return k && k !== 'none'; });
        } catch (e) {
            return [];
        }
    }

    function saveFavoriteSkins(storageKey, keys) {
        try {
            localStorage.setItem(storageKey, JSON.stringify(keys));
        } catch (e) {}
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

    function copyTextWithFallback(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).catch(() => copyTextFallback(text));
        }
        return copyTextFallback(text);
    }

    function copyTextFallback(text) {
        return new Promise((resolve, reject) => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                if (ok) resolve();
                else reject();
            } catch (e) {
                reject(e);
            }
        });
    }


    //  limits how many draw calls used
    // (prevents it from hiding random map nd ui stuff)
    const VIEWMODEL_DRAW_LIMIT = 8;

    
    // internal things (don't need to touch this)
    // ------------------------------------------------
    //  keeps track of textures and webgl contexts
    

    const glToEntry = new WeakMap();
    const trackedGlTextures = new Set();
    const textureSources = new WeakMap();
    const textureOriginalFile = new WeakMap();
    const textureWeapon = new WeakMap();
    const textureGlEntry = new WeakMap();
    const textureMipmapped = new WeakMap();
    let textureMeleeCache = new WeakMap();
    const textureGunCache = new WeakMap();
    const previewBubbleControllers = [];
    const refreshBindExtras = new Set();
    let refreshWeaponFilter = null;
    const textureReuploadQueue = [];
    let textureReuploadRaf = null;
    const TEXTURE_REUPLOADS_PER_FRAME = 1;
    const wireframeColorTexByGl = new WeakMap();

    function getWireframeAnimatedRgbNow() {
        const mode = normalizeWireframeColorMode(cfg.wireframeColorMode);
        const hz = normalizeWireframePulseHz(cfg.wireframePulseHz);
        const t = performance.now() / 1000;
        if (mode === 'dual') {
            const mix = (Math.sin(t * Math.PI * 2 * hz) + 1) / 2;
            return lerpRgb(hexToRgb(cfg.wireframeColorA), hexToRgb(cfg.wireframeColorB), mix);
        }
        return hslToRgb((t * 60 * hz) % 360, 100, 55);
    }

    function isAnimatedWireframeMode() {
        const mode = normalizeWireframeColorMode(cfg.wireframeColorMode);
        return mode === 'rgb' || mode === 'dual';
    }

    function invalidateAllWireframeColorTexes() {
        for (let i = 0; i < hookedGlEntries.length; i++) {
            const gl = hookedGlEntries[i].gl;
            const cached = wireframeColorTexByGl.get(gl);
            if (cached && cached.tex) {
                try { gl.deleteTexture(cached.tex); } catch (_) {}
            }
            wireframeColorTexByGl.delete(gl);
        }
    }

    function uploadWireframeColorPixels(gl, entry, tex, rgb) {
        const pixels = new Uint8Array([rgb.r, rgb.g, rgb.b, 255]);
        entry.natives.bindTexture.call(gl, entry.TEXTURE_2D, tex);
        entry.natives.texImage2D.call(
            gl,
            entry.TEXTURE_2D,
            0,
            gl.RGBA,
            1,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels
        );
    }

    function createWireframeColorTexture(gl, entry, rgb) {
        const tex = gl.createTexture();
        uploadWireframeColorPixels(gl, entry, tex, rgb);
        return tex;
    }

    function getWireframeColorTex(gl, entry) {
        const mode = normalizeWireframeColorMode(cfg.wireframeColorMode);

        if (mode === 'static') {
            const hex = wireframeColorHex;
            let cached = wireframeColorTexByGl.get(gl);
            if (cached && cached.hex === hex && cached.tex) return cached.tex;
            if (cached && cached.tex) {
                try { gl.deleteTexture(cached.tex); } catch (_) {}
            }
            const tex = createWireframeColorTexture(gl, entry, hexToRgb(hex));
            wireframeColorTexByGl.set(gl, { hex: hex, tex: tex, mode: 'static' });
            return tex;
        }

        let cached = wireframeColorTexByGl.get(gl);
        if (cached && cached.mode === mode && cached.tex) return cached.tex;
        if (cached && cached.tex) {
            try { gl.deleteTexture(cached.tex); } catch (_) {}
        }
        const tex = createWireframeColorTexture(gl, entry, getWireframeAnimatedRgbNow());
        wireframeColorTexByGl.set(gl, { mode: mode, tex: tex });
        return tex;
    }

    function refreshAnimatedWireframeTexAtDraw(gl, entry) {
        const mode = normalizeWireframeColorMode(cfg.wireframeColorMode);
        if (mode === 'static') return;
        const rgb = getWireframeAnimatedRgbNow();
        let cached = wireframeColorTexByGl.get(gl);
        if (!cached || !cached.tex || cached.mode !== mode) {
            const tex = createWireframeColorTexture(gl, entry, rgb);
            cached = { mode: mode, tex: tex };
            wireframeColorTexByGl.set(gl, cached);
        } else {
            uploadWireframeColorPixels(gl, entry, cached.tex, rgb);
        }
        entry.natives.bindTexture.call(gl, entry.TEXTURE_2D, cached.tex);
    }

    function extractTextureFilename(url) {
        if (!url) return null;
        const match = String(url).match(TEXTURE_FILE_RE);
        return match ? match[0].toLowerCase() : null;
    }

    function normalizeTextureFilename(file) {
        const match = String(file || '').match(TEXTURE_FILE_RE);
        return match ? match[0].toLowerCase() : null;
    }

    function isMeleeTextureUrl(url) {
        const file = extractTextureFilename(url);
        if (!file) return false;
        if (meleeTextureSet.has(file)) return true;
        return isMeleeWeaponId(getWeaponForFile(file));
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
        textureMeleeCache.set(tex, isMeleeWeaponId(weapon));
        textureGunCache.set(tex, isGunWeaponId(weapon));
        trackedGlTextures.add(tex);
        glTexturesByWeapon[weapon].add(tex);
        rememberWeaponSkinHash(weapon, file);
        latestEquippedHashByWeapon[weapon] = file;
        if (anySwapActive) {
            const swap = getSwapTargetForWeapon(weapon);
            if (swap && swap !== 'none') {
                const t = Date.now();
                if (!swapRefreshBumpAt[weapon] || t - swapRefreshBumpAt[weapon] > 450) {
                    swapRefreshBumpAt[weapon] = t;
                    preloadSwapTexture(swap, function () { requestRefreshWeaponSwap(weapon); });
                }
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
        textureMeleeCache.delete(tex);
        textureGunCache.delete(tex);
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

    function closeAllPreviewBubbles() {
        for (let i = 0; i < previewBubbleControllers.length; i++) {
            previewBubbleControllers[i].forceClose();
        }
    }

    const skinDropdownClosers = [];

    function registerSkinDropdownCloser(closeFn) {
        skinDropdownClosers.push(closeFn);
    }

    function closeOtherSkinDropdowns(keepCloseFn) {
        for (let i = 0; i < skinDropdownClosers.length; i++) {
            const closeFn = skinDropdownClosers[i];
            if (closeFn !== keepCloseFn) closeFn();
        }
    }

    function closeAllSkinLists() {
        closeOtherSkinDropdowns(null);
    }

    function closeAllSkinSearchSuggestions() {
        document.querySelectorAll('.melee-vm-skin-search-list').forEach((el) => {
            el.style.display = 'none';
        });
    }

    function closeAllSkinPopups() {
        closeAllSkinLists();
        closeAllSkinSearchSuggestions();
    }

    function isMeleeTexture(tex) {
        if (!tex) return false;
        if (textureMeleeCache.has(tex)) return textureMeleeCache.get(tex);
        const result = isMeleeTextureUrl(textureSources.get(tex));
        textureMeleeCache.set(tex, result);
        return result;
    }

    function isGunTexture(tex) {
        if (!tex) return false;
        if (textureGunCache.has(tex)) return textureGunCache.get(tex);
        const weapon = textureWeapon.get(tex);
        if (weapon) {
            const result = isGunWeaponId(weapon);
            textureGunCache.set(tex, result);
            return result;
        }
        const file = extractTextureFilename(textureSources.get(tex));
        if (!file) return false;
        const result = isGunWeaponId(getWeaponForFile(file));
        textureGunCache.set(tex, result);
        return result;
    }

    function getTextureWeapon(tex) {
        return textureWeapon.get(tex) || null;
    }

    function isGunViewmodelTexture(tex) {
        return isGunTexture(tex);
    }

    syncCfgFlags();

    
    // texture replacer (swaps melee uploads at texImage2D time)
    

    const preloadedSwapImages = new Map();
    const decodedSwapImages = new Set();

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

    function warmVisibleLoadoutSwaps() {
        if (!anySwapActive) return;
        document.querySelectorAll('#bottom-right .weapons-cont .weapon-name.text-1').forEach(function (el) {
            const weaponId = lookupWeaponIdByLabel((el.textContent || '').trim());
            if (!weaponId) return;
            const target = getSwapTargetForWeapon(weaponId);
            if (target && target !== 'none') preloadSwapTexture(target);
        });
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

        const weapons = weaponFilter
            ? [weaponFilter]
            : Object.keys(WEAPON_REGISTRY);

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


    
    // =========================================================================
    // WEBGL HOOK HANDLERS — register on shared bridge (see ensureWebGlBridge above)
    // =========================================================================
    // ------------------------------------------------

    function captureTextureUpload(args, entry) {
        const gl = entry.gl;
        const pixels = args[args.length - 1];
        if (!pixels || typeof pixels !== 'object' || !pixels.src) {
            return;
        }

        const src = String(pixels.src);
        const file = extractTextureFilename(src);
        if (!file || !fileToWeapon.has(file)) {
            return;
        }

        const tex = entry.activeTexture2D;
        if (!tex) {
            return;
        }

        registerWeaponTexture(tex, gl, file, src);

        if (!anySwapActive && !meleeOnlyOn && !wireframeOn) {
            return;
        }

        const weapon = getWeaponForFile(file);
        if (weapon) {
            entry.vm.lastMeleeUpload = { weapon: weapon, file: file };
        }
    }

    function trackRefreshBind(entry, texture) {
        const vm = entry.vm;
        if (!refreshWeaponFilter || !vm.inViewmodelPass || !texture) {
            return;
        }
        if (textureWeapon.has(texture) && !isLiveGlTexture(entry.gl, texture)) {
            unregisterWeaponTexture(texture);
            return;
        }
        const weapon = textureWeapon.get(texture);
        if (weapon !== refreshWeaponFilter) {
            return;
        }
        refreshBindExtras.add(texture);
        if (!textureGlEntry.has(texture)) {
            textureGlEntry.set(texture, entry);
        }
        if (weapon && glTexturesByWeapon[weapon]) {
            glTexturesByWeapon[weapon].add(texture);
        }
    }

    function resolveViewmodelDraw(entry, mode) {
        const gl = entry.gl;
        const vm = entry.vm;
        const isTriangle = entry.TRIANGLE_MODES.has(mode);

        if (!vm.meleeActive && isTriangle && vm.boundTexture) {
            const bound = vm.boundTexture;
            const boundIsMelee = textureMeleeCache.has(bound)
                ? textureMeleeCache.get(bound)
                : isMeleeTexture(bound);
            if (boundIsMelee) {
                vm.meleeActive = true;
            }
        }

        const hide = meleeOnlyOn && isTriangle && !vm.meleeActive
            && vm.viewmodelDrawCount < VIEWMODEL_DRAW_LIMIT;

        const wireframeDraw = wireframeOn && isTriangle && (
            (cfg.wireframeMeleeScope && vm.meleeActive) ||
            (cfg.wireframeGunScope && vm.gunActive)
        );

        const drawMode = (!hide && wireframeDraw) ? gl.LINES : mode;

        return { hide: hide, drawMode: drawMode, wireframeDraw: !hide && wireframeDraw };
    }

    function onKnifeUniformMatrix4fv(ctx) {
        if (spectatingCached || !cfg.weaponScaleEnabled) {
            return;
        }

        const gl = ctx.gl;
        if (!gl || !gl.canvas || gl.canvas.id !== 'game') {
            return;
        }

        const entry = glToEntry.get(gl);
        const vm = entry ? entry.vm : null;

        const callArgs = ctx.args;
        const data = callArgs[2];
        if (!data || data.length < 16) {
            return;
        }

        const srcOffset = callArgs[3] || 0;
        let slice;
        if (srcOffset === 0 && data.length === 16) {
            slice = data;
        } else if (data.subarray) {
            slice = data.subarray(srcOffset, srcOffset + 16);
        } else {
            slice = Array.prototype.slice.call(data, srcOffset, srcOffset + 16);
        }

        const kind = classifyViewmodelMatrix(slice);
        let shouldScale = kind === 'weapon';
        // Melee viewmodels (tomahawk/bayonet) often classify as "arms" due to matrix scale.
        if (!shouldScale && kind === 'arms' && vm && vm.meleeActive) {
            shouldScale = true;
        }
        if (!shouldScale) {
            return;
        }

        const scale = normalizeWeaponScale(cfg.weaponScale);
        const offsetX = normalizeWeaponOffset(cfg.weaponOffsetX);
        const offsetY = normalizeWeaponOffset(cfg.weaponOffsetY);
        const offsetZ = normalizeWeaponOffset(cfg.weaponOffsetZ);

        if (scale === 1 && offsetX === 0 && offsetY === 0 && offsetZ === 0) {
            return;
        }

        gunScaleScratchMatrix.set(slice);
        gunScaleScratchMatrix[0] *= scale;
        gunScaleScratchMatrix[1] *= scale;
        gunScaleScratchMatrix[2] *= scale;
        gunScaleScratchMatrix[4] *= scale;
        gunScaleScratchMatrix[5] *= scale;
        gunScaleScratchMatrix[6] *= scale;
        gunScaleScratchMatrix[8] *= scale;
        gunScaleScratchMatrix[9] *= scale;
        gunScaleScratchMatrix[10] *= scale;
        gunScaleScratchMatrix[12] += offsetX;
        gunScaleScratchMatrix[13] += offsetY;
        gunScaleScratchMatrix[14] += offsetZ;

        ctx.matrixOverride = gunScaleScratchMatrix;
    }

    function onKnifeClear(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) {
            return;
        }
        const mask = ctx.args[0];
        const vm = entry.vm;
        vm.inViewmodelPass = (mask === ctx.gl.DEPTH_BUFFER_BIT);
        if (vm.inViewmodelPass) {
            vm.viewmodelDrawCount = 0;
            vm.meleeActive = false;
            vm.gunActive = false;
        }
    }

    function onKnifeBindTexture(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) {
            return;
        }
        const gl = ctx.gl;
        const target = ctx.args[0];
        let texture = ctx.args[1];
        const TEXTURE_2D = gl.TEXTURE_2D;
        const vm = entry.vm;

        if (target === TEXTURE_2D) {
            entry.activeTexture2D = texture || null;
            trackRefreshBind(entry, texture);
        }
        if (target !== TEXTURE_2D) {
            return;
        }
        if (!vm.inViewmodelPass) {
            vm.boundTexture = texture || null;
            return;
        }

        let bindTex = texture;
        if (texture) {
            const isMelee = textureMeleeCache.has(texture)
                ? textureMeleeCache.get(texture)
                : isMeleeTexture(texture);
            if (isMelee) {
                vm.meleeActive = true;
                if (wireframeOn && cfg.wireframeMeleeScope) {
                    bindTex = getWireframeColorTex(gl, entry);
                }
            } else {
                const isGun = textureGunCache.has(texture)
                    ? textureGunCache.get(texture)
                    : isGunTexture(texture);
                if (isGun) {
                    vm.gunActive = true;
                    if (wireframeOn && cfg.wireframeGunScope) {
                        bindTex = getWireframeColorTex(gl, entry);
                    }
                }
            }
        }
        vm.boundTexture = bindTex || null;
        if (bindTex !== texture) {
            ctx.args[1] = bindTex;
        }
    }

    function onKnifeTexImage2D(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) {
            return;
        }
        captureTextureUpload(ctx.args, entry);
        if (anySwapActive) {
            trySwapTextureUpload(ctx.args);
        }
    }

    function onKnifeTexSubImage2D(ctx) {
        onKnifeTexImage2D(ctx);
    }

    function onKnifeCopyTexImage2D(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) {
            return;
        }
        const gl = ctx.gl;
        const TEXTURE_2D = gl.TEXTURE_2D;

        if (ctx.phase === 'before') {
            if (ctx.args[0] === TEXTURE_2D) {
                ctx.meta.dstTex = entry.activeTexture2D;
            }
            return;
        }

        try {
            const lastMeleeUpload = entry.vm.lastMeleeUpload;
            if (ctx.meta.dstTex && lastMeleeUpload && lastMeleeUpload.file) {
                registerWeaponTexture(
                    ctx.meta.dstTex,
                    gl,
                    lastMeleeUpload.file,
                    TEXTURE_CDN + lastMeleeUpload.file
                );
            }
        } catch (_) {}
    }

    function onKnifeGenerateMipmap(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) {
            return;
        }
        const gl = ctx.gl;
        const target = ctx.args[0];
        if (target !== gl.TEXTURE_2D) {
            return;
        }
        const tex = entry.activeTexture2D;
        if (tex && textureWeapon.has(tex)) {
            textureMipmapped.set(tex, true);
        }
    }

    function onKnifeDeleteTexture(ctx) {
        const tex = ctx.args[0];
        if (tex) unregisterWeaponTexture(tex);
    }

    function onKnifeDraw(ctx) {
        const entry = glToEntry.get(ctx.gl);
        if (!entry) {
            return;
        }
        const vm = entry.vm;
        if (!vm.inViewmodelPass) {
            return;
        }

        const mode = ctx.args[0];
        const resolved = resolveViewmodelDraw(entry, mode);
        if (resolved.hide) {
            ctx.skip = true;
            vm.viewmodelDrawCount++;
            return;
        }
        if (resolved.wireframeDraw && isAnimatedWireframeMode()) {
            refreshAnimatedWireframeTexAtDraw(ctx.gl, entry);
        }
        if (entry.TRIANGLE_MODES.has(mode)) {
            vm.viewmodelDrawCount++;
        }
        if (resolved.drawMode !== mode) {
            ctx.modeOverride = resolved.drawMode;
        }
    }

    function clearKnifeBridgeHandlers() {
        for (let i = 0; i < knifeBridgeUnregisters.length; i += 1) {
            knifeBridgeUnregisters[i]();
        }
        knifeBridgeUnregisters = [];
    }

    function resetAllKnifeViewmodelState() {
        for (let i = 0; i < hookedGlEntries.length; i += 1) {
            const vm = hookedGlEntries[i].vm;
            vm.inViewmodelPass = false;
            vm.viewmodelDrawCount = 0;
            vm.meleeActive = false;
            vm.gunActive = false;
            vm.boundTexture = null;
        }
    }

    function refreshKnifeBridgeHandlers() {
        const bridge = ensureWebGlBridge();

        clearKnifeBridgeHandlers();

        function registerBridgeHandler(method, handler) {
            try {
                return bridge.register(method, handler);
            } catch (err) {
                if (method === 'deleteTexture') {
                    return function () {};
                }
                throw err;
            }
        }

        if (!needsViewmodelHooks()) {
            resetAllKnifeViewmodelState();
        }

        if (needsTextureHooks()) {
            knifeBridgeUnregisters.push(
                registerBridgeHandler('texImage2D', onKnifeTexImage2D),
                registerBridgeHandler('texSubImage2D', onKnifeTexSubImage2D),
                registerBridgeHandler('copyTexImage2D', onKnifeCopyTexImage2D),
                registerBridgeHandler('generateMipmap', onKnifeGenerateMipmap),
                registerBridgeHandler('deleteTexture', onKnifeDeleteTexture)
            );
        }

        if (needsViewmodelHooks() || anySwapActive || needsGunScaleMods()) {
            knifeBridgeUnregisters.push(
                registerBridgeHandler('bindTexture', onKnifeBindTexture)
            );
        }

        if (needsGunScaleMods()) {
            knifeBridgeUnregisters.push(
                registerBridgeHandler('uniformMatrix4fv', onKnifeUniformMatrix4fv)
            );
        }

        if (needsViewmodelHooks() || needsGunScaleMods()) {
            knifeBridgeUnregisters.push(
                registerBridgeHandler('clear', onKnifeClear)
            );
        }

        if (needsViewmodelHooks()) {
            knifeBridgeUnregisters.push(
                registerBridgeHandler('drawElements', onKnifeDraw),
                registerBridgeHandler('drawArrays', onKnifeDraw)
            );
        }

        lastGunScaleModsActive = needsGunScaleMods();
    }

    function onKnifeBridgeContext(gl, natives) {
        if (glToEntry.has(gl)) {
            return;
        }

        const entry = {
            gl: gl,
            natives: natives,
            TEXTURE_2D: gl.TEXTURE_2D,
            activeTexture2D: null,
            vm: {
                inViewmodelPass: false,
                viewmodelDrawCount: 0,
                meleeActive: false,
                gunActive: false,
                boundTexture: null,
                lastMeleeUpload: null,
            },
            TRIANGLE_MODES: new Set([
                gl.TRIANGLES,
                gl.TRIANGLE_STRIP,
                gl.TRIANGLE_FAN,
            ]),
        };

        hookedGlEntries.push(entry);
        glToEntry.set(gl, entry);
        scheduleSavedSwapBootstrap();
        requestAnimationFrame(function () {
            if (anySwapActive) {
                refreshAllSavedSwapWeapons();
            }
        });
    }

    function initKnifeWebGlBridge() {
        const bridge = ensureWebGlBridge();
        bridge.onContext(onKnifeBridgeContext);
        refreshKnifeBridgeHandlers();
    }

    initKnifeWebGlBridge();

    
    // menu
    

    let swapperMenuHost = null;
    let swapperMenuOverlay = null;
    let swapperMenuMountObserver = null;
    let menuInitialized = false;

    function ensureMenuInitialized() {
        if (menuInitialized) return true;
        if (!skinsCatalogReady || !document.body) return false;
        try {
            initMenu();
            menuInitialized = true;
            return true;
        } catch (err) {
            console.error('[ShowOnlyKnife] initMenu failed:', err);
            return false;
        }
    }

    function ensureSwapperMenuMounted() {
        if (!swapperMenuHost) return false;
        if (!swapperMenuHost.isConnected && document.body) {
            document.body.appendChild(swapperMenuHost);
        }
        return swapperMenuHost.isConnected;
    }

    function setSwapperMenuOpen(open) {
        if (!ensureSwapperMenuMounted()) return;
        swapperMenuHost.style.display = open ? 'block' : 'none';
        swapperMenuHost.style.pointerEvents = open ? 'auto' : 'none';
        if (swapperMenuOverlay) swapperMenuOverlay.classList.toggle('is-open', !!open);
        if (!open) {
            closeAllSkinPopups();
            closeAllPreviewBubbles();
        }
        if (open) preloadSavedSwapTargetsOnce();
    }

    function closeSwapperMenu() {
        setSwapperMenuOpen(false);
    }

    function toggleSwapperMenu() {
        if (!ensureMenuInitialized()) return;
        if (!swapperMenuHost) return;
        setSwapperMenuOpen(swapperMenuHost.style.display !== 'block');
    }

    // Optional global handle so other userscripts can open/close the menu.
    function publishSwapperMenuApi() {
        window.__kirkaSwapperMenu = {
            toggle: toggleSwapperMenu,
            open: function () {
                if (!ensureMenuInitialized()) return;
                setSwapperMenuOpen(true);
            },
            close: closeSwapperMenu,
        };
    }

    function watchSwapperMenuMount() {
        if (swapperMenuMountObserver) return;
        swapperMenuMountObserver = new MutationObserver(function () {
            ensureSwapperMenuMounted();
        });
        swapperMenuMountObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function bindSwapperMenuHotkeys() {
        if (window.__kirkaSwapperMenuHotkeyBound) return;
        window.__kirkaSwapperMenuHotkeyBound = true;
        document.addEventListener('keydown', function (event) {
            if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            if (event.key.toLowerCase() !== 'o') return;
            event.preventDefault();
            event.stopPropagation();
            toggleSwapperMenu();
        }, true);
    }

    function initMenu() {
        try {
            const legacyHost = document.getElementById('melee-vm-menu-host');
            if (legacyHost) legacyHost.remove();
            const legacyOverlay = document.getElementById('melee-vm-overlay');
            if (legacyOverlay && !legacyOverlay.closest('#melee-vm-menu-host')) legacyOverlay.remove();
            const legacyStyles = document.getElementById('melee-vm-menu-styles');
            if (legacyStyles) legacyStyles.remove();
        } catch (e) {}
        swapperMenuHost = null;
        swapperMenuOverlay = null;

        try {
            localStorage.removeItem('kirka-swapper-panel-size');
        } catch (e) {}

        const MENU_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const NEO = {
            bg: 'rgba(17, 17, 17, 0.85)',
            bgDeep: '#0a0a0c',
            bgPanel: '#141418',
            bgHeader: 'rgba(255,255,255,0.03)',
            text: '#ffffff',
            muted: 'rgba(255,255,255,0.52)',
            purple: '#e3292f',
            purpleStrong: '#ff3860',
            purpleSoft: '#ff8e95',
            purpleHeader: 'rgba(255,255,255,0.75)',
            purpleBorder: 'rgba(227,41,47,0.45)',
            purpleBorderSoft: 'rgba(255,255,255,0.08)',
            purpleFill: 'rgba(227,41,47,0.14)',
            radiusLg: '14px',
            radiusMd: '8px',
            radiusSm: '8px',
        };
        const PURPLE_LIGHT = '#2cff7c';

        const TAB_KEY = 'kirka-melee-menu-tab';
        const savedTab = localStorage.getItem(TAB_KEY);
        let activeTab = (savedTab === 'main' || savedTab === 'guns' || savedTab === 'swapper') ? savedTab : 'swapper';

        const oldStyles = document.getElementById('melee-vm-menu-styles');
        if (oldStyles) oldStyles.remove();

        const styleTag = document.createElement('style');
        styleTag.id = 'melee-vm-menu-styles';
        styleTag.textContent = `
                :host {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    z-index: 2147483647;
                    margin: 0;
                    padding: 0;
                    border: 0;
                    background: transparent;
                    pointer-events: none;
                    box-sizing: border-box;
                }
                #melee-vm-overlay {
                    position: absolute;
                    inset: 0;
                    width: 100%;
                    height: 100%;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.82);
                    backdrop-filter: blur(6px);
                    box-sizing: border-box;
                }
                #melee-vm-overlay.is-open { display: flex; }
                #melee-vm-overlay.is-light { background: rgba(0, 0, 0, 0.1); backdrop-filter: none; }
                #melee-vm-overlay.is-light .melee-vm-panel { background: rgba(12, 12, 16, 0.38); box-shadow: none; }
                #melee-vm-overlay.is-light .melee-vm-card,
                #melee-vm-overlay.is-light .melee-vm-header,
                #melee-vm-overlay.is-light .melee-vm-tab-bar,
                #melee-vm-overlay.is-light .melee-vm-footer { background: rgba(14, 14, 18, 0.52); }
                #melee-vm-overlay.is-light .melee-vm-title { color: #6eb6ff; }
                #melee-vm-overlay.is-light .melee-vm-tab-active,
                #melee-vm-overlay.is-light .melee-vm-set-action-btn.is-primary,
                #melee-vm-overlay.is-light .melee-vm-mode-btn.is-active,
                #melee-vm-overlay.is-light .melee-vm-toggle-btn.is-on {
                    background: rgba(110, 182, 255, 0.18) !important;
                    border-color: rgba(110, 182, 255, 0.5) !important;
                    color: #9eceff !important;
                }
                #melee-vm-overlay.is-light .melee-vm-toggle-btn:not(.is-on),
                #melee-vm-overlay.is-light .melee-vm-neo-action-reset {
                    background: rgba(160, 120, 255, 0.14);
                    border-color: rgba(160, 120, 255, 0.45);
                    color: #c9a8ff;
                }
                #melee-vm-overlay.is-light .melee-vm-set-action-btn,
                #melee-vm-overlay.is-light .melee-vm-mode-btn,
                #melee-vm-overlay.is-light .melee-vm-neo-action-random,
                #melee-vm-overlay.is-light .melee-vm-copy-btn { border-color: rgba(110, 182, 255, 0.35); color: #8ec4ff; }
                #melee-vm-overlay.is-light .melee-vm-skin-search-input:focus,
                #melee-vm-overlay.is-light .melee-vm-scope-check input,
                #melee-vm-overlay.is-light .melee-vm-speed-row input[type="range"] { accent-color: #6eb6ff; }
                #melee-vm-overlay.is-light .melee-vm-skin-search-input:focus { border-color: rgba(110, 182, 255, 0.45); }
                .melee-vm-panel {
                    width: min(660px, 94vw);
                    min-height: min(720px, 88vh);
                    max-height: 90vh;
                    height: min(720px, 88vh);
                    background: linear-gradient(165deg, #141418 0%, #0a0a0c 100%);
                    color: #fff;
                    border-radius: 14px;
                    border: 1px solid rgba(255, 255, 255, 0.14);
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    box-shadow: 0 24px 90px rgba(0, 0, 0, 0.85);
                    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                .melee-vm-panel, .melee-vm-panel * {
                    -webkit-tap-highlight-color: transparent !important;
                }
                .melee-vm-panel input:not([type="checkbox"]):not([type="color"]):not([type="range"]),
                .melee-vm-panel textarea {
                    -webkit-user-select: text;
                    user-select: text;
                    outline: none !important;
                    caret-color: #ff8e95;
                }
                .melee-vm-panel button:focus,
                .melee-vm-panel button:focus-visible,
                .melee-vm-panel input:focus,
                .melee-vm-panel input:focus-visible,
                .melee-vm-panel textarea:focus,
                .melee-vm-panel textarea:focus-visible,
                .melee-vm-panel select:focus,
                .melee-vm-panel select:focus-visible,
                .melee-vm-panel summary:focus,
                .melee-vm-panel summary:focus-visible {
                    outline: none !important;
                    box-shadow: none !important;
                }
                .melee-vm-tab-body::-webkit-scrollbar,
                .melee-vm-skin-list::-webkit-scrollbar,
                .melee-vm-skin-search-list::-webkit-scrollbar,
                .melee-vm-fav-list::-webkit-scrollbar { width: 8px; }
                .melee-vm-tab-body::-webkit-scrollbar-track,
                .melee-vm-skin-list::-webkit-scrollbar-track,
                .melee-vm-skin-search-list::-webkit-scrollbar-track,
                .melee-vm-fav-list::-webkit-scrollbar-track { background: transparent; }
                .melee-vm-tab-body::-webkit-scrollbar-thumb,
                .melee-vm-skin-list::-webkit-scrollbar-thumb,
                .melee-vm-skin-search-list::-webkit-scrollbar-thumb,
                .melee-vm-fav-list::-webkit-scrollbar-thumb {
                    background: #3a3a42;
                    border-radius: 4px;
                }
                .melee-vm-tab-body::-webkit-scrollbar-thumb:hover,
                .melee-vm-skin-list::-webkit-scrollbar-thumb:hover,
                .melee-vm-skin-search-list::-webkit-scrollbar-thumb:hover,
                .melee-vm-fav-list::-webkit-scrollbar-thumb:hover { background: #4a4a55; }
                .melee-vm-tab-body { transition: opacity 0.2s ease, visibility 0.2s ease; }
                .melee-vm-header {
                    display: grid;
                    grid-template-columns: 1fr auto 1fr;
                    align-items: center;
                    gap: 16px;
                    padding: 22px 24px 20px;
                    flex-shrink: 0;
                    background: rgba(255, 255, 255, 0.03);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }
                .melee-vm-title-wrap { grid-column: 2; text-align: center; min-width: 0; }
                .melee-vm-title {
                    font-size: 24px;
                    font-weight: 800;
                    letter-spacing: 0.5px;
                    color: #ff3860;
                    line-height: 1.15;
                }
                .melee-vm-header-close {
                    flex-shrink: 0;
                    width: 40px;
                    height: 40px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 22px;
                    font-weight: 700;
                    border-radius: 8px;
                    border: 1px solid rgba(120, 20, 28, 0.45);
                    background: rgba(0, 0, 0, 0.35);
                    color: rgba(255, 140, 145, 0.85);
                    cursor: pointer;
                    font-family: inherit;
                    transition: background 0.15s, color 0.15s, border-color 0.15s;
                    outline: none;
                }
                .melee-vm-header-close:hover {
                    background: #ff3860;
                    color: #000;
                    border-color: #ff3860;
                }
                .melee-vm-header-actions { grid-column: 3; justify-self: end; display: flex; gap: 8px; flex-shrink: 0; }
                .melee-vm-header-theme {
                    width: 40px;
                    height: 40px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 17px;
                    border-radius: 8px;
                    border: 1px solid rgba(110, 182, 255, 0.4);
                    background: rgba(0, 0, 0, 0.35);
                    color: #6eb6ff;
                    cursor: pointer;
                    font-family: inherit;
                    outline: none;
                }
                .melee-vm-header-theme.is-on {
                    background: rgba(110, 182, 255, 0.18);
                    border-color: rgba(110, 182, 255, 0.65);
                }
                .melee-vm-tab-bar {
                    display: flex;
                    gap: 8px;
                    padding: 12px 24px 0;
                    flex-shrink: 0;
                }
                .melee-vm-tab {
                    flex: 1;
                    padding: 10px 14px;
                    border-radius: 8px 8px 0 0;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-bottom: none;
                    background: rgba(255, 255, 255, 0.03);
                    color: rgba(255, 255, 255, 0.55);
                    cursor: pointer;
                    font-family: inherit;
                    font-size: 13px;
                    font-weight: 700;
                    letter-spacing: 0.8px;
                    text-transform: uppercase;
                    transition: background 0.15s, color 0.15s, border-color 0.15s;
                    outline: none;
                }
                .melee-vm-tab:hover:not(.melee-vm-tab-active) { color: rgba(255, 255, 255, 0.82); }
                .melee-vm-tab-active {
                    background: rgba(227, 41, 47, 0.14) !important;
                    color: #ff8e95 !important;
                    border-color: rgba(227, 41, 47, 0.45) !important;
                }
                .melee-vm-body-wrap {
                    flex: 1 1 auto;
                    min-height: 320px;
                    overflow: hidden;
                    position: relative;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    background: rgba(17, 17, 17, 0.85);
                }
                .melee-vm-footer {
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 8px 14px;
                    padding: 12px 24px;
                    font-size: 13px;
                    color: rgba(255, 255, 255, 0.55);
                    flex-shrink: 0;
                    background: rgba(255, 255, 255, 0.02);
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                }
                .melee-vm-card {
                    background: rgba(255, 255, 255, 0.04);
                    border: 1px solid rgba(255, 255, 255, 0.09);
                    border-radius: 10px;
                    padding: 16px 18px;
                    margin-bottom: 14px;
                }
                .melee-vm-hint {
                    margin-bottom: 14px;
                    font-size: 12px;
                    font-weight: 500;
                    line-height: 1.55;
                    letter-spacing: 0.15px;
                    color: rgba(255, 255, 255, 0.52);
                }
                .melee-vm-tab-link {
                    display: inline;
                    padding: 0;
                    margin: 0;
                    border: none;
                    background: none;
                    font: inherit;
                    font-size: inherit;
                    font-weight: 600;
                    line-height: inherit;
                    color: #6eb6ff;
                    cursor: pointer;
                    text-decoration: underline;
                    text-underline-offset: 2px;
                }
                .melee-vm-tab-link:hover { color: #9eceff; }
                .melee-vm-section-title {
                    margin-bottom: 12px;
                    font-size: 13px;
                    font-weight: 700;
                    letter-spacing: 1.2px;
                    text-transform: uppercase;
                    color: rgba(255, 255, 255, 0.75);
                }
                .melee-vm-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 10px 0;
                }
                .melee-vm-row-label {
                    font-size: 14px;
                    font-weight: 600;
                    color: rgba(255, 255, 255, 0.75);
                }
                .melee-vm-toggle-btn {
                    min-width: 96px;
                    padding: 6px 12px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 700;
                    font-size: 12px;
                    letter-spacing: 0.5px;
                    font-family: inherit;
                    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
                    outline: none;
                    box-shadow: none;
                    background: rgba(255, 56, 96, 0.12);
                    color: #ff3860;
                    border: 1px solid rgba(255, 56, 96, 0.45);
                }
                .melee-vm-toggle-btn.is-on {
                    background: rgba(44, 255, 124, 0.12);
                    color: #2cff7c;
                    border: 1px solid rgba(44, 255, 124, 0.45);
                }
                .melee-vm-toggle-btn:hover { filter: brightness(1.08); }
                .melee-vm-toggle-btn-sm {
                    min-width: 72px;
                    padding: 5px 10px;
                    font-size: 11px;
                }
                .melee-vm-color-picker {
                    width: 42px;
                    height: 32px;
                    padding: 2px;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 8px;
                    background: rgba(0, 0, 0, 0.35);
                    cursor: pointer;
                }
                .melee-vm-wireframe-sub {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    margin-top: 8px;
                    padding-top: 12px;
                    border-top: 1px solid rgba(255, 255, 255, 0.08);
                }
                .melee-vm-wireframe-subtitle {
                    margin: 4px 0 6px;
                    font-size: 12px;
                    font-weight: 600;
                    letter-spacing: 0.04em;
                    color: rgba(255, 255, 255, 0.6);
                }
                .melee-vm-mode-row {
                    flex-wrap: wrap;
                    align-items: flex-start;
                    gap: 10px;
                }
                .melee-vm-mode-group {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-left: auto;
                    justify-content: flex-end;
                }
                .melee-vm-mode-btn {
                    padding: 6px 12px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.03);
                    color: rgba(255, 255, 255, 0.55);
                    font-family: inherit;
                    font-size: 12px;
                    font-weight: 700;
                    cursor: pointer;
                    transition: background 0.15s, color 0.15s, border-color 0.15s;
                    outline: none;
                }
                .melee-vm-mode-btn.is-active {
                    background: rgba(227, 41, 47, 0.14);
                    border-color: rgba(227, 41, 47, 0.45);
                    color: #ff8e95;
                }
                .melee-vm-speed-row input[type="range"] {
                    flex: 1;
                    min-width: 120px;
                    max-width: 200px;
                    accent-color: #e3292f;
                    cursor: pointer;
                }
                .melee-vm-speed-value {
                    min-width: 40px;
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.52);
                    text-align: right;
                }
                .melee-vm-gunscale-placeholder {
                    min-width: 36px;
                    font-size: 10px;
                    color: rgba(255, 255, 255, 0.52);
                    text-align: right;
                    opacity: 0.75;
                }
                .melee-vm-scope-row { justify-content: flex-start; gap: 16px; }
                .melee-vm-scope-check {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 13px;
                    color: rgba(255, 255, 255, 0.75);
                    cursor: pointer;
                }
                .melee-vm-scope-check input {
                    width: 14px;
                    height: 14px;
                    margin: 0;
                    accent-color: #e3292f;
                    cursor: pointer;
                }
                .melee-vm-set-actions {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                    margin-top: 4px;
                }
                .melee-vm-set-action-btn {
                    flex: 1 1 140px;
                    padding: 8px 12px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    background: rgba(255, 255, 255, 0.03);
                    color: rgba(255, 255, 255, 0.75);
                    font-family: inherit;
                    font-size: 12px;
                    font-weight: 700;
                    cursor: pointer;
                    transition: background 0.15s, color 0.15s, border-color 0.15s;
                    outline: none;
                }
                .melee-vm-set-action-btn:hover { background: rgba(255, 255, 255, 0.06); }
                .melee-vm-set-action-btn.is-primary {
                    background: rgba(227, 41, 47, 0.14);
                    border-color: rgba(227, 41, 47, 0.45);
                    color: #ff8e95;
                }
                .melee-vm-gun-empty {
                    padding: 12px 0;
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.52);
                    font-style: italic;
                }
                .melee-vm-gun-list { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
                .melee-vm-dropdown-btn,
                .melee-vm-fav-btn {
                    background: rgba(0, 0, 0, 0.35);
                    color: #fff;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    padding: 8px 12px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-family: inherit;
                    font-size: 13px;
                    font-weight: 500;
                    width: 100%;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    box-sizing: border-box;
                    transition: background 0.15s, border-color 0.15s;
                    outline: none;
                }
                .melee-vm-dropdown-btn:hover,
                .melee-vm-fav-btn:hover {
                    background: rgba(255, 255, 255, 0.06);
                    border-color: rgba(255, 255, 255, 0.22);
                }
                .melee-vm-gun-row {
                    background: rgba(255, 255, 255, 0.04);
                    border: 1px solid rgba(255, 255, 255, 0.09);
                    border-radius: 10px;
                    padding: 12px 14px;
                    box-sizing: border-box;
                }
                .melee-vm-gun-toggle-label {
                    color: #fff;
                    font-weight: 600;
                    font-size: 14px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    text-align: left;
                }
                .melee-vm-gun-body.is-collapsed { display: none; }
                .melee-vm-gun-body.is-open {
                    display: block;
                    padding: 10px 0 2px;
                    margin-top: 8px;
                    border-top: 1px solid rgba(255, 255, 255, 0.08);
                }
                .melee-vm-skin-list,
                .melee-vm-skin-search-list,
                .melee-vm-fav-list {
                    background: #16161a !important;
                    border: 1px solid rgba(255, 255, 255, 0.15) !important;
                    border-radius: 8px !important;
                    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6) !important;
                }
                .melee-vm-skin-list > div:hover,
                .melee-vm-skin-search-list > div:hover,
                .melee-vm-fav-list > div:hover {
                    background: rgba(255, 255, 255, 0.07) !important;
                }
                .melee-vm-skin-search-input {
                    background: rgba(0, 0, 0, 0.35);
                    color: #fff;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    padding: 8px 12px;
                    border-radius: 8px;
                    font-family: inherit;
                    font-size: 13px;
                    width: 100%;
                    box-sizing: border-box;
                    outline: none !important;
                }
                .melee-vm-skin-search-input::placeholder { color: rgba(255, 255, 255, 0.35); }
                .melee-vm-skin-search-input:focus { border-color: rgba(227, 41, 47, 0.45); }
                .melee-vm-neo-action-reset {
                    padding: 7px 10px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-family: inherit;
                    font-size: 11px;
                    font-weight: 700;
                    white-space: nowrap;
                    border: 1px solid rgba(255, 56, 96, 0.45);
                    background: rgba(255, 56, 96, 0.12);
                    color: #ff3860;
                    outline: none;
                }
                .melee-vm-neo-action-random {
                    padding: 7px 10px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-family: inherit;
                    font-size: 11px;
                    font-weight: 700;
                    white-space: nowrap;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    background: rgba(0, 0, 0, 0.35);
                    color: #fff;
                    outline: none;
                }
                .melee-vm-weapon-layout {
                    display: flex;
                    align-items: flex-start;
                    gap: 16px;
                }
                .melee-vm-weapon-controls { flex: 1 1 auto; min-width: 0; }
                .melee-vm-weapon-preview { flex: 0 0 112px; width: 112px; min-width: 112px; }
                .melee-vm-weapon-card-compact { padding-bottom: 0 !important; }
                .melee-vm-preview-box {
                    border-radius: 8px;
                    border: none;
                    background: rgba(0, 0, 0, 0.35);
                }
                .melee-vm-preview-box img { border: none; outline: none; }
                .melee-vm-preview-bubble {
                    background: #16161a !important;
                    border: 1px solid rgba(255, 255, 255, 0.15) !important;
                    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6) !important;
                }
                .melee-vm-copy-btn {
                    flex: 1;
                    min-width: 0;
                    padding: 6px 10px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    background: rgba(255, 255, 255, 0.03);
                    color: rgba(255, 255, 255, 0.75);
                    font-family: inherit;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    outline: none;
                }
                .melee-vm-copy-btn:hover { background: rgba(255, 255, 255, 0.07); color: #fff; }
                .melee-vm-copy-btn.is-done {
                    background: rgba(44, 255, 124, 0.12);
                    border-color: rgba(44, 255, 124, 0.45);
                    color: #2cff7c;
                }
                .melee-vm-catalog-selected {
                    display: none;
                    align-items: flex-start;
                    gap: 16px;
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid rgba(255, 255, 255, 0.08);
                }
                .melee-vm-catalog-selected.is-visible { display: flex; }
                .melee-vm-catalog-selected-info {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .melee-vm-catalog-selected-name {
                    font-size: 15px;
                    font-weight: 700;
                    color: #fff;
                    line-height: 1.3;
                }
                .melee-vm-catalog-selected-weapon {
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.52);
                }
                .melee-vm-catalog-search-wrap {
                    position: relative;
                    width: 100%;
                }
                .melee-vm-catalog-actions {
                    margin-top: 8px;
                }
                .melee-vm-catalog-suggestion-sub {
                    font-size: 11px;
                    color: rgba(255, 255, 255, 0.45);
                    margin-left: 8px;
                    flex-shrink: 0;
                }
                .melee-vm-catalog-suggestion-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                }
                .melee-vm-set-action-btn.is-added {
                    background: rgba(255, 255, 255, 0.05);
                    border-color: rgba(255, 255, 255, 0.14);
                    color: rgba(255, 255, 255, 0.55);
                }
                .melee-vm-set-action-btn.is-just-added {
                    background: rgba(44, 255, 124, 0.12);
                    border-color: rgba(44, 255, 124, 0.45);
                    color: #2cff7c;
                }
                .melee-vm-catalog-add-status.is-success {
                    color: #2cff7c;
                }
                .melee-vm-catalog-actions { margin-bottom: 4px; }
                .melee-vm-catalog-hint { margin-top: 14px; margin-bottom: 0; }
                .melee-vm-catalog-add-status {
                    font-size: 11px;
                    color: rgba(255, 255, 255, 0.52);
                    line-height: 1.45;
                }
                @media (max-width: 720px) {
                    .melee-vm-weapon-layout { flex-direction: column; gap: 10px; }
                    .melee-vm-weapon-preview { width: 100%; min-width: 0; flex-basis: auto; }
                    .melee-vm-catalog-selected { flex-direction: column; align-items: center; }
                }
            `;

        const menuHost = document.createElement('div');
        menuHost.id = 'melee-vm-menu-host';
        menuHost.style.cssText = [
            'position:fixed',
            'top:0',
            'left:0',
            'right:0',
            'bottom:0',
            'width:100vw',
            'height:100vh',
            'z-index:2147483647',
            'display:none',
            'pointer-events:none',
            'margin:0',
            'padding:0',
            'border:0',
            'background:transparent',
        ].join(';');

        const menuShadow = menuHost.attachShadow({ mode: 'open' });
        menuShadow.appendChild(styleTag);

        const overlay = document.createElement('div');
        overlay.id = 'melee-vm-overlay';
        overlay.className = 'melee-vm-overlay';

        const panel = document.createElement('div');
        panel.className = 'melee-vm-panel';
        Object.assign(panel.style, {
            fontFamily: MENU_FONT,
        });

        function clearMenuSelection() {
            try {
                const sel = window.getSelection && window.getSelection();
                if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
            } catch (_) {}
        }

        panel.addEventListener('mousedown', function (e) {
            const t = e.target;
            if (!(t instanceof Element) || !panel.contains(t)) return;
            if (t.closest('input, textarea')) return;
            clearMenuSelection();
            if (
                t.closest('button, .melee-vm-skin-list, .melee-vm-skin-search-list, .melee-vm-fav-list')
            ) {
                e.preventDefault();
            }
        }, true);

        const header = document.createElement('div');
        header.className = 'melee-vm-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'melee-vm-title-wrap';

        const brandTitle = document.createElement('div');
        brandTitle.className = 'melee-vm-title';
        brandTitle.textContent = 'Texture Swapper';

        titleWrap.appendChild(brandTitle);
        header.appendChild(titleWrap);

        let menuLightOn = getStorage('kirka-menu-light', getStorage('kirka-mods-peek', false));

        const headerActions = document.createElement('div');
        headerActions.className = 'melee-vm-header-actions';

        const themeBtn = document.createElement('button');
        themeBtn.type = 'button';
        themeBtn.className = 'melee-vm-header-theme';
        themeBtn.title = menuLightOn ? 'Toggle dark mode' : 'Toggle light mode';
        themeBtn.textContent = menuLightOn ? '\u2600' : '\u263E';
        themeBtn.addEventListener('click', function () {
            menuLightOn = !menuLightOn;
            try { localStorage.setItem('kirka-menu-light', menuLightOn); } catch (_) {}
            paintTabs();
            themeBtn.blur();
        });

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'melee-vm-header-close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', () => {
            closeSwapperMenu();
            closeBtn.blur();
        });
        headerActions.appendChild(themeBtn);
        headerActions.appendChild(closeBtn);
        header.appendChild(headerActions);
        panel.appendChild(header);

        const tabBar = document.createElement('div');
        tabBar.className = 'melee-vm-tab-bar';

        function createTabButton(label) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'melee-vm-tab';
            btn.textContent = label;
            btn.addEventListener('click', (e) => { e.currentTarget.blur(); });
            return btn;
        }

        const tabSwapper = createTabButton('Melee');
        const tabGuns = createTabButton('Guns');
        const tabMain = createTabButton('Mods');

        tabBar.appendChild(tabSwapper);
        tabBar.appendChild(tabGuns);
        tabBar.appendChild(tabMain);
        panel.appendChild(tabBar);

        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'melee-vm-body-wrap';
        panel.appendChild(bodyWrap);

        const mainTab = document.createElement('div');
        const swapperTab = document.createElement('div');
        const gunTab = document.createElement('div');
        const tabBodyBase = {
            position: 'absolute',
            top: '0',
            left: '0',
            right: '0',
            bottom: '0',
            padding: '20px 24px 28px',
            overflowX: 'hidden',
            boxSizing: 'border-box',
            opacity: '0',
            visibility: 'hidden',
            pointerEvents: 'none',
        };
        [mainTab, swapperTab, gunTab].forEach((el) => {
            el.className = 'melee-vm-tab-body';
            Object.assign(el.style, tabBodyBase);
        });
        mainTab.style.overflowY = 'auto';
        swapperTab.style.overflowY = 'auto';
        gunTab.style.overflowY = 'auto';
        bodyWrap.appendChild(mainTab);
        bodyWrap.appendChild(swapperTab);
        bodyWrap.appendChild(gunTab);
        mainTab.addEventListener('scroll', closeAllSkinPopups, { passive: true });
        swapperTab.addEventListener('scroll', closeAllSkinPopups, { passive: true });
        gunTab.addEventListener('scroll', closeAllSkinPopups, { passive: true });

        const SWAPPER_PREVIEW_RESERVE = '176px';

        function paintTabs() {
            const tabButtons = { swapper: tabSwapper, guns: tabGuns, main: tabMain };
            const tabBodies = { swapper: swapperTab, guns: gunTab, main: mainTab };

            for (const tabId in tabButtons) {
                const isActive = activeTab === tabId;
                tabButtons[tabId].classList.toggle('melee-vm-tab-active', isActive);
                tabBodies[tabId].style.opacity = isActive ? '1' : '0';
                tabBodies[tabId].style.visibility = isActive ? 'visible' : 'hidden';
                tabBodies[tabId].style.pointerEvents = isActive ? 'auto' : 'none';
            }
            overlay.classList.toggle('is-light', menuLightOn);
            if (themeBtn) {
                themeBtn.classList.toggle('is-on', menuLightOn);
                themeBtn.textContent = menuLightOn ? '\u2600' : '\u263E';
                themeBtn.title = menuLightOn ? 'Toggle dark mode' : 'Toggle light mode';
            }
        }

        function switchTab(tab) {
            if (tab === activeTab) return;
            closeAllSkinPopups();
            closeAllPreviewBubbles();
            activeTab = tab;
            localStorage.setItem(TAB_KEY, tab);
            paintTabs();
        }

        tabSwapper.addEventListener('click', () => switchTab('swapper'));
        tabGuns.addEventListener('click', () => switchTab('guns'));
        tabMain.addEventListener('click', () => switchTab('main'));
        paintTabs();

        const footer = document.createElement('div');
        footer.className = 'melee-vm-footer';

        const footerCredit = document.createElement('span');
        footerCredit.textContent = 'inhib#KLKLYH';

        const footerVersion = document.createElement('span');
        footerVersion.textContent = 'v' + VM_VERSION;

        const footerDivider = document.createElement('span');
        footerDivider.textContent = '\u00b7';
        footerDivider.style.cssText = 'opacity: 0.35; flex-shrink: 0;';

        const footerHint = document.createElement('span');
        footerHint.textContent = 'Press CTRL+O to toggle this menu';

        const footerHookCredit = document.createElement('span');
        footerHookCredit.textContent = 'imnotkoolkid (webgl hook base from gunscale-rgb script)';

        const footerRenderCredit = document.createElement('span');
        footerRenderCredit.textContent = 'kirka.lukeskywalk.com · renders';

        footer.appendChild(footerCredit);
        footer.appendChild(footerDivider.cloneNode(true));
        footer.appendChild(footerVersion);
        footer.appendChild(footerDivider.cloneNode(true));
        footer.appendChild(footerHint);
        footer.appendChild(footerDivider.cloneNode(true));
        footer.appendChild(footerHookCredit);
        footer.appendChild(footerDivider.cloneNode(true));
        footer.appendChild(footerRenderCredit);
        panel.appendChild(footer);

        overlay.appendChild(panel);
        menuShadow.appendChild(overlay);
        document.body.appendChild(menuHost);
        swapperMenuHost = menuHost;
        swapperMenuOverlay = overlay;
        watchSwapperMenuMount();
        setSwapperMenuOpen(false);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSwapperMenu();
        });

        const skinOptionsRefreshListeners = [];

        function registerSkinOptionsRefreshListener(fn) {
            skinOptionsRefreshListeners.push(fn);
        }

        function notifySkinOptionsChanged() {
            for (let i = 0; i < skinOptionsRefreshListeners.length; i++) {
                try { skinOptionsRefreshListeners[i](); } catch (_) {}
            }
        }

        function makeCard(target) {
            const card = document.createElement('div');
            card.className = 'melee-vm-card';
            target.appendChild(card);
            return card;
        }

        const MUTED_LABEL = 'melee-vm-row-label';

        function createSubsectionLabel(target, text) {
            const row = document.createElement('div');
            row.className = 'melee-vm-wireframe-subtitle';
            row.textContent = text;
            target.appendChild(row);
        }

        function createOption(target, label, initial, cb) {
            const row = document.createElement('div');
            row.className = 'melee-vm-row';
            if (label) {
                const labelSpan = document.createElement('span');
                labelSpan.className = MUTED_LABEL;
                labelSpan.textContent = label;
                row.appendChild(labelSpan);
            } else {
                row.style.justifyContent = 'flex-end';
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'melee-vm-toggle-btn';
            let on = initial;

            function paint() {
                btn.textContent = on ? 'ENABLED' : 'ENABLE';
                btn.classList.toggle('is-on', on);
            }
            paint();

            btn.onclick = () => { on = !on; paint(); cb(on); btn.blur(); };
            row.appendChild(btn);
            target.appendChild(row);
        }

        function createWireframeColorRow(target, labelText, initialHex, onChange) {
            const row = document.createElement('div');
            row.className = 'melee-vm-row';
            const labelSpan = document.createElement('span');
            labelSpan.className = MUTED_LABEL;
            labelSpan.textContent = labelText;
            row.appendChild(labelSpan);

            const picker = document.createElement('input');
            picker.type = 'color';
            picker.className = 'melee-vm-color-picker';
            picker.value = normalizeWireframeColor(initialHex);
            picker.addEventListener('input', () => {
                onChange(picker.value);
            });
            row.appendChild(picker);
            target.appendChild(row);
            return row;
        }

        function createWireframeModeRow(target, initialMode, onChange) {
            const row = document.createElement('div');
            row.className = 'melee-vm-row melee-vm-mode-row';
            const labelSpan = document.createElement('span');
            labelSpan.className = MUTED_LABEL;
            labelSpan.textContent = 'Color mode';
            row.appendChild(labelSpan);

            const group = document.createElement('div');
            group.className = 'melee-vm-mode-group';
            const modes = [
                { id: 'static', label: 'Static' },
                { id: 'dual', label: '2-color' },
                { id: 'rgb', label: 'RGB' },
            ];
            const buttons = [];

            function paint(activeId) {
                for (let i = 0; i < buttons.length; i++) {
                    buttons[i].classList.toggle('is-active', buttons[i].dataset.mode === activeId);
                }
            }

            for (let i = 0; i < modes.length; i++) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'melee-vm-mode-btn';
                btn.dataset.mode = modes[i].id;
                btn.textContent = modes[i].label;
                btn.addEventListener('click', () => {
                    paint(modes[i].id);
                    onChange(modes[i].id);
                    btn.blur();
                });
                group.appendChild(btn);
                buttons.push(btn);
            }

            paint(normalizeWireframeColorMode(initialMode));
            row.appendChild(group);
            target.appendChild(row);
            return row;
        }

        function createWireframeSpeedRow(target, initialHz, onChange) {
            const row = document.createElement('div');
            row.className = 'melee-vm-row melee-vm-speed-row';
            const labelSpan = document.createElement('span');
            labelSpan.className = MUTED_LABEL;
            labelSpan.textContent = 'Pulse speed';
            row.appendChild(labelSpan);

            const controls = document.createElement('div');
            controls.style.cssText = 'display:flex;align-items:center;gap:10px;margin-left:auto;';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0.05';
            slider.max = '5';
            slider.step = '0.05';
            slider.value = String(normalizeWireframePulseHz(initialHz));

            const valueLabel = document.createElement('span');
            valueLabel.className = 'melee-vm-speed-value';

            function paint() {
                const hz = normalizeWireframePulseHz(slider.value);
                slider.value = String(hz);
                valueLabel.textContent = `${hz < 1 ? hz.toFixed(2) : hz.toFixed(1)} Hz`;
            }
            paint();

            slider.addEventListener('input', () => {
                paint();
                onChange(normalizeWireframePulseHz(slider.value));
            });

            controls.appendChild(slider);
            controls.appendChild(valueLabel);
            row.appendChild(controls);
            target.appendChild(row);
            return row;
        }

        function createGunScaleSliderRow(target, labelText, initialValue, min, max, step, formatValue, normalizeValue, defaultValue, onChange) {
            const row = document.createElement('div');
            row.className = 'melee-vm-row melee-vm-speed-row';
            const labelSpan = document.createElement('span');
            labelSpan.className = MUTED_LABEL;
            labelSpan.textContent = labelText;
            row.appendChild(labelSpan);

            const controls = document.createElement('div');
            controls.style.cssText = 'display:flex;align-items:center;gap:10px;margin-left:auto;';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = String(min);
            slider.max = String(max);
            slider.step = String(step);
            slider.value = String(normalizeValue(initialValue));

            const valueLabel = document.createElement('span');
            valueLabel.className = 'melee-vm-speed-value';
            let placeholderMode = false;

            function paintValue() {
                const value = normalizeValue(slider.value);
                slider.value = String(value);
                if (placeholderMode) {
                    valueLabel.textContent = 'edit';
                    valueLabel.className = 'melee-vm-gunscale-placeholder';
                    return;
                }
                valueLabel.className = 'melee-vm-speed-value';
                valueLabel.textContent = formatValue(value);
            }

            function revealValue() {
                if (!placeholderMode) return;
                placeholderMode = false;
                paintValue();
            }

            paintValue();

            slider.addEventListener('pointerdown', revealValue);
            slider.addEventListener('input', () => {
                revealValue();
                paintValue();
                onChange(normalizeValue(slider.value));
            });

            controls.appendChild(slider);
            controls.appendChild(valueLabel);
            row.appendChild(controls);
            target.appendChild(row);

            return {
                row: row,
                setValue: function (value) {
                    placeholderMode = false;
                    slider.value = String(normalizeValue(value != null ? value : defaultValue));
                    paintValue();
                },
                resetToDefault: function () {
                    placeholderMode = true;
                    slider.value = String(normalizeValue(defaultValue));
                    paintValue();
                },
            };
        }

        function createSectionDescription(target, text) {
            const row = document.createElement('div');
            row.className = 'melee-vm-hint';
            row.textContent = text;
            target.appendChild(row);
        }

        function createMeleeGunsFinderHint(target) {
            const row = document.createElement('div');
            row.className = 'melee-vm-hint';
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'melee-vm-tab-link';
            link.textContent = 'Guns tab';
            link.addEventListener('click', function (e) {
                e.preventDefault();
                switchTab('guns');
                link.blur();
            });
            row.appendChild(link);
            row.appendChild(document.createTextNode(' > find any skin to add any other skins you would like to be swappable.'));
            target.appendChild(row);
        }

        function createSectionHeader(target, text) {
            const row = document.createElement('div');
            row.className = 'melee-vm-section-title';
            row.textContent = text;
            target.appendChild(row);
        }

        function filterSkinOptionsByQuery(options, query) {
            const q = String(query || '').trim().toLowerCase();
            if (!q) return [];

            const matches = [];
            for (const key in options) {
                if (key === 'none' || key === '') continue;
                const name = String(options[key] || '');
                const lower = name.toLowerCase();
                if (!lower.includes(q)) continue;

                let rank = 2;
                if (lower.endsWith(q)) rank = 0;
                else if (lower.startsWith(q)) rank = 1;
                matches.push({ key, name, rank });
            }

            matches.sort((a, b) => {
                if (a.rank !== b.rank) return a.rank - b.rank;
                return a.name.localeCompare(b.name);
            });

            return matches.slice(0, 12);
        }

        function createSkinSearchBar(target, options, onSelect) {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; justify-content: flex-end; padding: 4px 0 2px;';

            const controls = document.createElement('div');
            controls.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-shrink: 0; width: 100%;';

            const wrap = document.createElement('div');
            wrap.style.cssText = 'position: relative; width: 100%; flex: 1;';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Find skin…';
            input.autocomplete = 'off';
            input.spellcheck = false;
            input.className = 'melee-vm-skin-search-input';

            const list = document.createElement('div');
            list.className = 'melee-vm-skin-search-list';
            list.style.cssText = 'display: none; position: absolute; top: calc(100% + 4px); right: 0; width: 100%; min-width: 175px; max-height: 148px; overflow-y: auto; z-index: 100001;';

            let optionMap = options;

            function focusSearchInput() {
                requestAnimationFrame(() => {
                    try {
                        input.focus({ preventScroll: true });
                        const end = typeof input.value === 'string' ? input.value.length : 0;
                        if (typeof input.setSelectionRange === 'function') {
                            input.setSelectionRange(end, end);
                        }
                    } catch (_) {}
                });
            }

            function closeSuggestions() {
                list.style.display = 'none';
                list.textContent = '';
            }

            function pickSkin(key) {
                closeSuggestions();
                input.value = '';
                onSelect(key);
                input.blur();
            }

            function renderSuggestions() {
                const matches = filterSkinOptionsByQuery(optionMap, input.value);
                list.textContent = '';

                if (!matches.length) {
                    if (input.value.trim()) {
                        const empty = document.createElement('div');
                        empty.textContent = 'None';
                        empty.style.cssText = 'padding: 8px 12px; font-size: 13px; color: ' + NEO.muted + ';';
                        list.appendChild(empty);
                        list.style.display = 'block';
                    } else {
                        closeSuggestions();
                    }
                    return;
                }

                closeAllSkinLists();
                closeAllPreviewBubbles();

                for (let i = 0; i < matches.length; i++) {
                    const match = matches[i];
                    const item = document.createElement('div');
                    item.textContent = match.name;
                    item.dataset.key = match.key;
                    item.style.cssText = 'padding: 8px 12px; cursor: pointer; font-size: 13px; color: ' + NEO.text + '; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
                    item.onmouseenter = () => {};
                    item.onmouseleave = () => {};
                    item.onmousedown = (e) => e.preventDefault();
                    item.onclick = (e) => {
                        e.stopPropagation();
                        pickSkin(match.key);
                    };
                    list.appendChild(item);
                }

                list.style.display = 'block';
            }

            function updateInputValueFromKey(event) {
                const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
                const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;

                if (event.key === 'Backspace') {
                    if (start === end && start > 0) {
                        input.value = input.value.slice(0, start - 1) + input.value.slice(end);
                        input.setSelectionRange(start - 1, start - 1);
                    } else {
                        input.value = input.value.slice(0, start) + input.value.slice(end);
                        input.setSelectionRange(start, start);
                    }
                    return true;
                }

                if (event.key === 'Delete') {
                    if (start === end) {
                        input.value = input.value.slice(0, start) + input.value.slice(Math.min(input.value.length, end + 1));
                        input.setSelectionRange(start, start);
                    } else {
                        input.value = input.value.slice(0, start) + input.value.slice(end);
                        input.setSelectionRange(start, start);
                    }
                    return true;
                }

                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    input.value = input.value.slice(0, start) + event.key + input.value.slice(end);
                    const next = start + event.key.length;
                    input.setSelectionRange(next, next);
                    return true;
                }

                return false;
            }

            input.addEventListener('input', renderSuggestions);
            input.addEventListener('focus', () => {
                if (input.value.trim()) renderSuggestions();
            });
            input.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                focusSearchInput();
            });
            input.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                focusSearchInput();
            });
            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();

                if (e.key === 'Escape') {
                    e.preventDefault();
                    input.value = '';
                    closeSuggestions();
                    input.blur();
                    return;
                }

                if (e.key === 'Enter') {
                    const first = list.querySelector('[data-key]');
                    if (first) {
                        e.preventDefault();
                        pickSkin(first.dataset.key);
                    }
                    return;
                }

                if (!e.defaultPrevented) return;
                if (!updateInputValueFromKey(e)) return;
                e.preventDefault();
                renderSuggestions();
            });
            input.addEventListener('keyup', (e) => e.stopPropagation());
            input.addEventListener('keypress', (e) => e.stopPropagation());
            wrap.addEventListener('click', (e) => e.stopPropagation());

            wrap.appendChild(input);
            wrap.appendChild(list);
            controls.appendChild(wrap);
            row.appendChild(controls);
            target.appendChild(row);

            return {
                refreshOptions(newOptions) {
                    optionMap = newOptions;
                    closeSuggestions();
                    input.value = '';
                },
                close: closeSuggestions,
            };
        }

        function createCustomDropdown(target, label, options, current, cb, settings) {
            const withRandom = !!(settings && settings.random);
            const colorForKey = (settings && settings.colorForKey) || (() => PURPLE_LIGHT);

            const row = document.createElement('div');
            row.style.cssText = 'display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px solid ' + NEO.purpleBorderSoft + ';';
            let labelSpan = null;
            if (label) {
                labelSpan = document.createElement('span');
                labelSpan.className = 'melee-vm-row-label';
                labelSpan.textContent = label;
                row.appendChild(labelSpan);
            } else if (!withRandom) {
                row.style.borderTop = 'none';
                row.style.paddingTop = '4px';
            }

            const controls = document.createElement('div');
            controls.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; width: 100%;';

            const wrap = document.createElement('div');
            wrap.style.cssText = 'position: relative; flex: 1 1 140px; min-width: 0;';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'melee-vm-dropdown-btn';
            btn.style.cssText = 'width: 100%; min-width: 0;';

            const btnLabel = document.createElement('span');
            btnLabel.textContent = options[current] || current;
            btnLabel.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;';

            const caret = document.createElement('span');
            caret.className = 'melee-vm-skin-caret';
            caret.textContent = '▾';
            caret.style.cssText = 'margin-left: 8px; opacity: 0.6; flex-shrink: 0;';

            btn.appendChild(btnLabel);
            btn.appendChild(caret);

            const list = document.createElement('div');
            list.className = 'melee-vm-skin-list';
            list.style.cssText = 'display: none; position: absolute; top: calc(100% + 4px); bottom: auto; right: 0; width: 100%; min-width: 175px; max-height: 148px; overflow-y: auto; z-index: 100001;';

            let selectedKey = current;
            let optionMap = options;

            function paintSelection(key) {
                selectedKey = key;
                btnLabel.textContent = optionMap[key] || key;
                btnLabel.style.color = colorForKey(key);
                for (let i = 0; i < list.children.length; i++) {
                    const child = list.children[i];
                    const sel = child.dataset.key === key;
                    if (sel) {
                        child.style.color = colorForKey(key);
                        child.style.fontWeight = '700';
                    } else {
                        child.style.color = NEO.text;
                        child.style.fontWeight = '';
                    }
                }
            }

            function closeList() {
                list.style.display = 'none';
                list.style.position = 'absolute';
                list.style.top = 'calc(100% + 4px)';
                list.style.bottom = 'auto';
                list.style.left = '';
                list.style.right = '0';
                list.style.width = '100%';
                list.style.minWidth = '175px';
                caret.textContent = '▾';
            }

            function openList() {
                closeOtherSkinDropdowns(closeList);
                closeAllSkinSearchSuggestions();
                list.style.display = 'block';
                caret.textContent = '▴';

                const wrapRect = wrap.getBoundingClientRect();
                const listHeight = Math.min(list.scrollHeight, 148);
                const spaceBelow = window.innerHeight - wrapRect.bottom - 8;
                const spaceAbove = wrapRect.top - 8;
                const openUp = spaceBelow < listHeight && spaceAbove >= spaceBelow;

                list.style.position = 'fixed';
                list.style.width = `${wrapRect.width}px`;
                list.style.minWidth = `${wrapRect.width}px`;
                list.style.left = `${wrapRect.left}px`;
                list.style.right = 'auto';

                if (openUp) {
                    list.style.top = 'auto';
                    list.style.bottom = `${window.innerHeight - wrapRect.top + 4}px`;
                } else {
                    list.style.top = `${wrapRect.bottom + 4}px`;
                    list.style.bottom = 'auto';
                }

                const sel = list.querySelector(`[data-key="${selectedKey}"]`);
                if (sel) {
                    list.scrollTop = Math.max(0, sel.offsetTop - (list.clientHeight - sel.offsetHeight) / 2);
                }
            }

            function applySelection(key) {
                paintSelection(key);
                closeList();
                cb(key);
                btn.blur();
            }

            let resetBtn = null;
            let randomBtn = null;
            if (withRandom) {
                resetBtn = document.createElement('button');
                resetBtn.type = 'button';
                resetBtn.className = 'melee-vm-neo-action-reset';
                resetBtn.textContent = 'Rst';
                resetBtn.onclick = (e) => {
                    e.stopPropagation();
                    applySelection('none');
                    resetBtn.blur();
                };

                randomBtn = document.createElement('button');
                randomBtn.type = 'button';
                randomBtn.className = 'melee-vm-neo-action-random';
                randomBtn.textContent = 'Rnd';
                randomBtn.onclick = (e) => {
                    e.stopPropagation();
                    const keys = Object.keys(optionMap).filter(k => k !== 'none' && k !== '');
                    if (!keys.length) return;
                    applySelection(keys[Math.floor(Math.random() * keys.length)]);
                    randomBtn.blur();
                };
            }

            function rebuildListItems() {
                list.textContent = '';
                for (let k in optionMap) {
                    const item = document.createElement('div');
                    item.textContent = optionMap[k];
                    item.dataset.key = k;
                    const isSelected = k === selectedKey;
                    item.style.cssText = 'padding: 8px 12px; cursor: pointer; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' + (isSelected ? 'color: ' + colorForKey(k) + '; font-weight: 700;' : 'color: ' + NEO.text + ';');
                    item.onmouseenter = () => {};
                    item.onmouseleave = () => {};
                    item.onmousedown = (e) => e.preventDefault();
                    item.onclick = (e) => {
                        e.stopPropagation();
                        applySelection(k);
                    };
                    list.appendChild(item);
                }
            }

            rebuildListItems();

            list.addEventListener('mousedown', (e) => e.stopPropagation());

            btn.onclick = (e) => {
                e.stopPropagation();
                if (list.style.display === 'none') openList();
                else closeList();
                btn.blur();
            };

            wrap.appendChild(btn);
            wrap.appendChild(list);
            if (resetBtn) controls.appendChild(resetBtn);
            if (randomBtn) controls.appendChild(randomBtn);
            controls.appendChild(wrap);
            row.appendChild(controls);
            target.appendChild(row);

            registerSkinDropdownCloser(closeList);

            paintSelection(current);

            return {
                get value() { return selectedKey; },
                setValue: paintSelection,
                applyValue: applySelection,
                close: closeList,
                refreshOptions(newOptions, newCurrent) {
                    optionMap = newOptions;
                    rebuildListItems();
                    const nextKey = newCurrent !== undefined
                        ? newCurrent
                        : (optionMap[selectedKey] !== undefined ? selectedKey : '');
                    paintSelection(nextKey in optionMap ? nextKey : (Object.keys(optionMap)[0] || ''));
                },
                setLabel(newLabel) {
                    if (labelSpan) labelSpan.textContent = newLabel;
                },
            };
        }

        function createSkinDropdown(target, label, options, current, cb) {
            return createCustomDropdown(target, label, options, current, cb, {
                random: true,
                colorForKey: (key) => (key === 'none' ? '#ff6b7a' : PURPLE_LIGHT),
            });
        }

        function createFavoritesDropdown(target, allOptions, storageKey, onSelect) {
            let optionMap = allOptions;
            let favStorageKey = storageKey;
            const row = document.createElement('div');
            row.style.cssText = 'padding: 0 0 8px;';

            const wrap = document.createElement('div');
            wrap.style.cssText = 'position: relative; width: 100%;';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'melee-vm-fav-btn';

            const btnLabel = document.createElement('span');
            btnLabel.textContent = 'Fav';

            const caret = document.createElement('span');
            caret.className = 'melee-vm-fav-caret';
            caret.textContent = '▾';
            caret.style.cssText = 'margin-left: 6px; opacity: 0.45; flex-shrink: 0; font-size: 10px;';

            btn.appendChild(btnLabel);
            btn.appendChild(caret);

            const list = document.createElement('div');
            list.className = 'melee-vm-fav-list';
            list.style.cssText = 'display: none; position: absolute; top: calc(100% + 4px); right: 0; width: 100%; min-width: 120px; max-height: 120px; overflow-y: auto; z-index: 100001;';

            function getFavoriteOptions() {
                return buildFavoritesOptions(optionMap, loadFavoriteSkins(favStorageKey));
            }

            function closeList() {
                list.style.display = 'none';
                list.style.position = 'absolute';
                list.style.top = 'calc(100% + 4px)';
                list.style.bottom = 'auto';
                list.style.left = '';
                list.style.right = '0';
                list.style.width = '100%';
                list.style.minWidth = '120px';
                caret.textContent = '▾';
            }

            function openList() {
                closeOtherSkinDropdowns(closeList);
                closeAllSkinSearchSuggestions();
                rebuildListItems();
                list.style.display = 'block';
                caret.textContent = '▴';

                const wrapRect = wrap.getBoundingClientRect();
                const listHeight = Math.min(list.scrollHeight, 120);
                const spaceBelow = window.innerHeight - wrapRect.bottom - 8;
                const spaceAbove = wrapRect.top - 8;
                const openUp = spaceBelow < listHeight && spaceAbove >= spaceBelow;

                list.style.position = 'fixed';
                list.style.width = wrapRect.width + 'px';
                list.style.minWidth = wrapRect.width + 'px';
                list.style.left = wrapRect.left + 'px';
                list.style.right = 'auto';

                if (openUp) {
                    list.style.top = 'auto';
                    list.style.bottom = (window.innerHeight - wrapRect.top + 4) + 'px';
                } else {
                    list.style.top = (wrapRect.bottom + 4) + 'px';
                    list.style.bottom = 'auto';
                }
            }

            function rebuildListItems() {
                list.textContent = '';
                const favOptions = getFavoriteOptions();
                const keys = Object.keys(favOptions);

                if (!keys.length) {
                    const empty = document.createElement('div');
                    empty.textContent = 'None';
                    empty.style.cssText = 'padding: 8px 10px; font-size: 11px; color: ' + NEO.muted + '; cursor: default;';
                    list.appendChild(empty);
                    return;
                }

                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    const item = document.createElement('div');
                    item.textContent = favOptions[k];
                    item.dataset.key = k;
                    item.style.cssText = 'padding: 7px 10px; cursor: pointer; font-size: 11px; color: ' + NEO.text + '; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
                    item.onmouseenter = function () {};
                    item.onmouseleave = function () {};
                    item.onmousedown = function (e) { e.preventDefault(); };
                    item.onclick = function (e) {
                        e.stopPropagation();
                        closeList();
                        onSelect(k);
                        btn.blur();
                    };
                    list.appendChild(item);
                }
            }

            btn.onclick = function (e) {
                e.stopPropagation();
                if (list.style.display === 'none') openList();
                else closeList();
                btn.blur();
            };

            list.addEventListener('mousedown', function (e) { e.stopPropagation(); });

            wrap.appendChild(btn);
            wrap.appendChild(list);
            row.appendChild(wrap);
            target.appendChild(row);

            registerSkinDropdownCloser(closeList);

            return {
                refresh: rebuildListItems,
                close: closeList,
                rebind(newOptions, newStorageKey) {
                    optionMap = newOptions;
                    favStorageKey = newStorageKey;
                    closeList();
                },
            };
        }

        document.addEventListener('click', (e) => {
            if (
                e.target instanceof Element
                && e.target.closest('.melee-vm-dropdown-btn, .melee-vm-fav-btn, .melee-vm-skin-list, .melee-vm-fav-list, .melee-vm-skin-search-list, .melee-vm-skin-search-input')
            ) {
                return;
            }
            closeAllSkinPopups();
            closeAllPreviewBubbles();
        });

        function makeRarityPill(rarity) {
            const style = RARITY_STYLES[rarity] || RARITY_STYLES.Mythical;
            const pill = document.createElement('span');
            pill.textContent = rarity;
            Object.assign(pill.style, {
                display: 'inline-block',
                padding: '4px 14px',
                borderRadius: '20px',
                fontSize: '12px',
                fontWeight: '700',
                letterSpacing: '0.3px',
                background: style.bg,
                color: style.text,
                border: `1px solid ${style.border}`,
                textShadow: style.shadow,
                boxShadow: '0 2px 6px rgba(0,0,0,0.45)',
            });
            return pill;
        }

        function makeInfoRow(label, value) {
            const row = document.createElement('div');
            row.style.cssText = 'margin-bottom: 8px; font-size: 12px; line-height: 1.45;';
            row.innerHTML = '<span style="color: ' + NEO.muted + ';">' + label + '</span><br>';
            const val = document.createElement('span');
            val.textContent = value;
            val.style.cssText = 'color: ' + NEO.text + '; font-weight: 600; word-break: break-all;';
            row.appendChild(val);
            return row;
        }

        function makeSkinPreviewBox(target, weaponId, weaponType, skinOptions, favoriteStorageKey, onFavoritesChanged, previewSize, previewOpts) {
            const size = previewSize || 110;
            const renderOnlyPreview = !!(previewOpts && previewOpts.renderOnly);
            let previewWeaponId = weaponId;
            let weaponLabel = weaponType;
            let optionMap = skinOptions;
            let favStorageKey = favoriteStorageKey;
            const wrap = document.createElement('div');
            Object.assign(wrap.style, {
                display: 'flex',
                justifyContent: 'center',
                marginTop: size <= 72 ? '6px' : '8px',
                marginBottom: '0',
                position: 'relative',
            });

            const box = document.createElement('div');
            box.className = 'melee-vm-preview-box';
            Object.assign(box.style, {
                width: size + 'px',
                height: size + 'px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                boxSizing: 'border-box',
                cursor: 'pointer',
            });

            const img = document.createElement('img');
            Object.assign(img.style, {
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'none',
                pointerEvents: 'none',
            });
            img.alt = '';

            const bubble = document.createElement('div');
            bubble.className = 'melee-vm-preview-bubble';
            Object.assign(bubble.style, {
                display: 'none',
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: '50%',
                transform: 'translateX(-50%)',
                width: '220px',
                padding: '14px 16px',
                borderRadius: NEO.radiusSm,
                zIndex: '100002',
                boxSizing: 'border-box',
            });
            bubble.onclick = (e) => e.stopPropagation();

            const bubbleBody = document.createElement('div');
            bubble.appendChild(bubbleBody);

            box.appendChild(img);
            wrap.appendChild(box);
            wrap.appendChild(bubble);
            target.appendChild(wrap);

            let currentKey = 'none';
            let bubbleOpen = false;

            function renderBubble() {
                bubbleBody.textContent = '';
                if (currentKey === 'none') {
                    const msg = document.createElement('div');
                    msg.textContent = 'Equipped skin active. Pick a swap to inspect.';
                    msg.style.cssText = 'font-size: 12px; line-height: 1.5; color: ' + NEO.muted + ';';
                    bubbleBody.appendChild(msg);
                    return;
                }
                const file = normalizeTextureFilename(currentKey) || currentKey;
                const name = optionMap[currentKey] || getSkinName(currentKey);
                const rarity = getSkinRarity(file);

                const title = document.createElement('div');
                title.textContent = name;
                title.style.cssText = 'font-size: 15px; font-weight: 700; margin-bottom: 10px; color: ' + NEO.text + ';';
                bubbleBody.appendChild(title);

                const rarityRow = document.createElement('div');
                rarityRow.style.cssText = 'margin-bottom: 10px;';
                rarityRow.appendChild(makeRarityPill(rarity));
                bubbleBody.appendChild(rarityRow);

                const setLabels = WEAPON_REGISTRY[previewWeaponId] && WEAPON_REGISTRY[previewWeaponId].tab === 'guns'
                    ? getGunSetLabelsForSkin(previewWeaponId, currentKey)
                    : [];
                if (setLabels.length) {
                    const setRow = document.createElement('div');
                    setRow.style.cssText = 'margin-bottom: 10px; font-size: 12px; line-height: 1.45; color: ' + NEO.muted + ';';
                    setRow.textContent = setLabels.length === 1
                        ? 'In ' + setLabels[0] + ' set'
                        : 'In sets: ' + setLabels.join(', ');
                    bubbleBody.appendChild(setRow);
                }

                bubbleBody.appendChild(makeInfoRow('Wpn', weaponLabel));
                bubbleBody.appendChild(makeInfoRow('Tex', file));

                const actionRow = document.createElement('div');
                actionRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 10px;';

                const copyBtn = document.createElement('button');
                copyBtn.type = 'button';
                copyBtn.className = 'melee-vm-copy-btn';
                copyBtn.textContent = 'Copy';

                const favBtn = document.createElement('button');
                favBtn.type = 'button';
                favBtn.title = 'Favorite';
                favBtn.style.cssText = 'flex-shrink: 0; width: 28px; height: 28px; padding: 0; border: none; background: transparent; font-family: inherit; font-size: 16px; line-height: 1; cursor: pointer; outline: none; box-shadow: none; transition: color 0.15s, text-shadow 0.15s, transform 0.12s;';

                function paintFavoriteBtn() {
                    const favorited = isFavoriteSkin(favStorageKey, currentKey);
                    favBtn.textContent = favorited ? '\u2665' : '\u2661';
                    favBtn.style.color = favorited ? '#ff6b9d' : 'rgba(255,255,255,0.35)';
                    favBtn.style.textShadow = favorited ? '0 0 10px rgba(255,107,157,0.65)' : 'none';
                }

                paintFavoriteBtn();

                favBtn.onmouseenter = function () {
                    if (!isFavoriteSkin(favStorageKey, currentKey)) {
                        favBtn.style.color = 'rgba(255,255,255,0.55)';
                    }
                };
                favBtn.onmouseleave = function () {
                    paintFavoriteBtn();
                };
                favBtn.onclick = function (e) {
                    e.stopPropagation();
                    toggleFavoriteSkin(favStorageKey, currentKey);
                    paintFavoriteBtn();
                    if (onFavoritesChanged) onFavoritesChanged();
                    favBtn.blur();
                };

                const fullUrl = TEXTURE_CDN + file;
                let copyTimer = null;
                copyBtn.onclick = (e) => {
                    e.stopPropagation();
                    copyTextWithFallback(fullUrl).then(() => {
                        copyBtn.textContent = 'Done';
                        copyBtn.classList.add('is-done');
                        if (copyTimer) clearTimeout(copyTimer);
                        copyTimer = setTimeout(() => {
                            copyBtn.textContent = 'Copy';
                            copyBtn.classList.remove('is-done');
                            copyTimer = null;
                        }, 1200);
                    }).catch(() => {});
                    copyBtn.blur();
                };

                actionRow.appendChild(copyBtn);
                actionRow.appendChild(favBtn);
                bubbleBody.appendChild(actionRow);
            }

            function positionBubble() {
                const boxRect = box.getBoundingClientRect();
                const gap = 6;
                bubble.style.position = 'fixed';
                bubble.style.width = '220px';
                bubble.style.left = (boxRect.left + boxRect.width / 2) + 'px';
                bubble.style.transform = 'translateX(-50%)';
                bubble.style.bottom = 'auto';

                const bubbleH = bubble.offsetHeight || 210;
                const top = boxRect.bottom + gap;
                if (top + bubbleH > window.innerHeight - 8 && boxRect.top > bubbleH + gap + 8) {
                    bubble.style.top = 'auto';
                    bubble.style.bottom = (window.innerHeight - boxRect.top + gap) + 'px';
                } else {
                    bubble.style.top = top + 'px';
                    bubble.style.bottom = 'auto';
                }
            }

            function resetBubblePosition() {
                bubble.style.position = 'absolute';
                bubble.style.top = 'calc(100% + 6px)';
                bubble.style.left = '50%';
                bubble.style.transform = 'translateX(-50%)';
                bubble.style.bottom = 'auto';
            }

            function setBubbleOpen(open) {
                if (open) {
                    closeAllPreviewBubbles();
                    bubbleOpen = true;
                    renderBubble();
                    bubble.style.display = 'block';
                    positionBubble();
                } else {
                    bubbleOpen = false;
                    bubble.style.display = 'none';
                    resetBubblePosition();
                }
            }

            box.onclick = (e) => {
                e.stopPropagation();
                setBubbleOpen(!bubbleOpen);
            };
            box.onmousedown = (e) => e.preventDefault();

            previewBubbleControllers.push({
                forceClose: function () {
                    bubbleOpen = false;
                    bubble.style.display = 'none';
                    resetBubblePosition();
                },
            });

            const updatePreview = (textureKey) => {
                currentKey = textureKey || 'none';
                const file = normalizeTextureFilename(textureKey);
                if (!file || textureKey === 'none') {
                    img.style.display = 'none';
                    img.removeAttribute('src');
                    setBubbleOpen(false);
                    return;
                }
                preloadSwapTexture(textureKey);
                loadPreviewImageWithFallback(
                    img,
                    box,
                    getSkinPreviewLoadCandidates(textureKey, previewWeaponId, renderOnlyPreview ? { renderOnly: true } : null),
                    0
                );
                if (bubbleOpen) {
                    renderBubble();
                    positionBubble();
                }
            };

            updatePreview.rebind = function (newWeaponId, newWeaponLabel, newOptions, newFavKey) {
                previewWeaponId = newWeaponId;
                weaponLabel = newWeaponLabel;
                optionMap = newOptions;
                favStorageKey = newFavKey;
                setBubbleOpen(false);
            };

            return updatePreview;
        }

        function makeSwapperDivider(target) {
            const divider = document.createElement('div');
            Object.assign(divider.style, {
                height: '1px',
                background: NEO.purpleBorderSoft,
                margin: '12px 0 4px',
            });
            target.appendChild(divider);
            return divider;
        }

        function createWeaponSwapperCard(target, weaponId, options) {
            const opts = options || {};
            const includeSearch = !!opts.includeSearch;
            const showDivider = !!opts.showDivider;
            const reusable = !!opts.reusable;
            const compactLayout = !!opts.compactLayout;
            const previewSize = opts.previewSize || 128;
            const meta = WEAPON_REGISTRY[weaponId];
            if (!meta) return null;

            let activeWeaponId = weaponId;

            function getWeaponContext(wid) {
                const weaponMeta = WEAPON_REGISTRY[wid];
                if (!weaponMeta) return null;
                return {
                    label: weaponMeta.label,
                    skinOptions: getWeaponSkinOptions(wid),
                    favKey: getFavStorageKey(wid),
                    swapKey: getSkinSwapStorageKey(wid),
                    current: cfg.skinSwap[wid] || 'none',
                };
            }

            let ctx = getWeaponContext(activeWeaponId);
            const card = document.createElement('div');
            card.style.overflow = 'visible';
            target.appendChild(card);

            if (showDivider) makeSwapperDivider(card);

            let controlsMount = card;
            let previewMount = card;
            if (compactLayout) {
                card.classList.add('melee-vm-weapon-card-compact');

                const layout = document.createElement('div');
                layout.className = 'melee-vm-weapon-layout';

                controlsMount = document.createElement('div');
                controlsMount.className = 'melee-vm-weapon-controls';

                previewMount = document.createElement('div');
                previewMount.className = 'melee-vm-weapon-preview';

                layout.appendChild(controlsMount);
                layout.appendChild(previewMount);
                card.appendChild(layout);
            } else {
                card.style.paddingBottom = SWAPPER_PREVIEW_RESERVE;
            }

            let updatePreview = function () {};
            const applySkin = function (v) {
                const live = getWeaponContext(activeWeaponId);
                if (!live) return;
                setSwapTargetForWeapon(activeWeaponId, v);
                if (v !== 'none') {
                    preloadSwapTexture(v, function () {
                        requestRefreshWeaponSwap(activeWeaponId);
                    });
                }
                requestRefreshWeaponSwap(activeWeaponId);
                updatePreview(v);
            };

            let searchBar = null;
            if (includeSearch) {
                searchBar = createSkinSearchBar(controlsMount, ctx.skinOptions, function (key) {
                    dropdown.applyValue(key);
                });
            }

            let dropdown = createSkinDropdown(controlsMount, ctx.label, ctx.skinOptions, ctx.current, applySkin);
            let favoritesDropdown = createFavoritesDropdown(controlsMount, ctx.skinOptions, ctx.favKey, function (key) {
                dropdown.applyValue(key);
            });
            updatePreview = makeSkinPreviewBox(previewMount, activeWeaponId, ctx.label, ctx.skinOptions, ctx.favKey, function () {
                favoritesDropdown.refresh();
            }, previewSize);
            updatePreview(ctx.current);

            registerSkinOptionsRefreshListener(function () {
                const live = getWeaponContext(activeWeaponId);
                if (!live) return;
                ctx = live;
                if (searchBar) searchBar.refreshOptions(ctx.skinOptions);
                dropdown.refreshOptions(ctx.skinOptions, ctx.current);
                favoritesDropdown.rebind(ctx.skinOptions, ctx.favKey);
                updatePreview.rebind(activeWeaponId, ctx.label, ctx.skinOptions, ctx.favKey);
            });

            function switchWeapon(newWeaponId) {
                const next = getWeaponContext(newWeaponId);
                if (!next) return;
                activeWeaponId = newWeaponId;
                ctx = next;
                closeAllSkinPopups();
                closeAllPreviewBubbles();
                if (searchBar) searchBar.refreshOptions(ctx.skinOptions);
                dropdown.setLabel(ctx.label);
                dropdown.refreshOptions(ctx.skinOptions, ctx.current);
                favoritesDropdown.rebind(ctx.skinOptions, ctx.favKey);
                updatePreview.rebind(activeWeaponId, ctx.label, ctx.skinOptions, ctx.favKey);
                updatePreview(ctx.current);
            }

            return {
                applySkin: applySkin,
                updatePreview: updatePreview,
                dropdown: dropdown,
                favoritesDropdown: favoritesDropdown,
                switchWeapon: reusable ? switchWeapon : null,
                card: card,
            };
        }

        const meleeCard = makeCard(mainTab);
        // --- Mods tab: Melee only (hide gun viewmodels in first person) ---
        createSectionHeader(meleeCard, 'Melee only');
        createOption(meleeCard, '', cfg.meleeOnlyEnabled, v => {
            cfg.meleeOnlyEnabled = v;
            syncCfgFlags();
            localStorage.setItem('kirka-melee-enabled', v);
        });
        createSectionDescription(meleeCard, 'Hides all weapons except Bayonet/Toma - works best with "weapon" selected in Kirka settings dropdown (General>Camera>Arms)');

        const wireframeCard = makeCard(mainTab);
        const wireframeTitle = document.createElement('div');
        wireframeTitle.className = 'melee-vm-section-title';
        wireframeTitle.appendChild(document.createTextNode('Wireframe '));
        const wireframeTitleNote = document.createElement('span');
        wireframeTitleNote.style.cssText = 'font-weight: 400; font-size: 0.85em; color: ' + NEO.muted + ';';
        wireframeTitleNote.textContent = '(draws your weapons as wireframe lines)';
        wireframeTitle.appendChild(wireframeTitleNote);
        wireframeCard.appendChild(wireframeTitle);
        createSectionDescription(wireframeCard, 'One color(static), 2 Color cycle, or RGB. seperate melee/gun toggles');

        const wireframeSub = document.createElement('div');
        wireframeSub.className = 'melee-vm-wireframe-sub';

        function refreshWireframeUi() {
            const on = !!cfg.wireframeEnabled;
            wireframeSub.style.display = on ? '' : 'none';
            const mode = normalizeWireframeColorMode(cfg.wireframeColorMode);
            wireframeColorRow.style.display = (mode === 'static' || mode === 'dual') ? '' : 'none';
            wireframeColorBRow.style.display = mode === 'dual' ? '' : 'none';
            wireframeSpeedRow.style.display = (mode === 'rgb' || mode === 'dual') ? '' : 'none';
            wireframeColorLabelSpan.textContent = mode === 'dual' ? 'Color A' : 'Wireframe color';
        }

        function applyWireframeColorChange() {
            wireframeColorHex = normalizeWireframeColor(cfg.wireframeColorA);
            invalidateAllWireframeColorTexes();
        }

        function applyWireframeModeChange(mode) {
            cfg.wireframeColorMode = normalizeWireframeColorMode(mode);
            try {
                localStorage.setItem('kirka-wireframe-color-mode', cfg.wireframeColorMode);
            } catch (_) {}
            invalidateAllWireframeColorTexes();
            refreshWireframeUi();
        }

        createOption(wireframeCard, '', cfg.wireframeEnabled, v => {
            cfg.wireframeEnabled = v;
            syncCfgFlags();
            persistWireframeEnabled(v);
            refreshWireframeUi();
        });

        wireframeCard.appendChild(wireframeSub);

        createSubsectionLabel(wireframeSub, 'Apply to');
        createOption(wireframeSub, 'Melee', cfg.wireframeMeleeScope, v => {
            cfg.wireframeMeleeScope = v;
            syncCfgFlags();
            try { localStorage.setItem('kirka-wireframe-melee-scope', v); } catch (_) {}
        });
        createOption(wireframeSub, 'Guns', cfg.wireframeGunScope, v => {
            cfg.wireframeGunScope = v;
            syncCfgFlags();
            try { localStorage.setItem('kirka-wireframe-gun-scope', v); } catch (_) {}
        });

        createSubsectionLabel(wireframeSub, 'Appearance');
        createWireframeModeRow(wireframeSub, cfg.wireframeColorMode, applyWireframeModeChange);

        const wireframeColorRow = document.createElement('div');
        wireframeColorRow.className = 'melee-vm-row';
        const wireframeColorLabelSpan = document.createElement('span');
        wireframeColorLabelSpan.className = MUTED_LABEL;
        wireframeColorLabelSpan.textContent = 'Wireframe color';
        wireframeColorRow.appendChild(wireframeColorLabelSpan);
        const wireframeColorPicker = document.createElement('input');
        wireframeColorPicker.type = 'color';
        wireframeColorPicker.className = 'melee-vm-color-picker';
        wireframeColorPicker.value = normalizeWireframeColor(cfg.wireframeColorA);
        wireframeColorPicker.addEventListener('input', () => {
            cfg.wireframeColorA = normalizeWireframeColor(wireframeColorPicker.value);
            applyWireframeColorChange();
            try {
                localStorage.setItem('kirka-wireframe-color-a', cfg.wireframeColorA);
                localStorage.setItem('kirka-wireframe-melee-color', cfg.wireframeColorA);
            } catch (_) {}
        });
        wireframeColorRow.appendChild(wireframeColorPicker);
        wireframeSub.appendChild(wireframeColorRow);

        const wireframeColorBRow = createWireframeColorRow(wireframeSub, 'Color B', cfg.wireframeColorB, (hex) => {
            cfg.wireframeColorB = normalizeWireframeColor(hex);
            invalidateAllWireframeColorTexes();
            try { localStorage.setItem('kirka-wireframe-color-b', cfg.wireframeColorB); } catch (_) {}
        });

        const wireframeSpeedRow = createWireframeSpeedRow(wireframeSub, cfg.wireframePulseHz, (hz) => {
            cfg.wireframePulseHz = normalizeWireframePulseHz(hz);
            try { localStorage.setItem('kirka-wireframe-pulse-hz', cfg.wireframePulseHz); } catch (_) {}
        });

        refreshWireframeUi();

        const gunScaleCard = makeCard(mainTab);
        // --- Mods tab: Gun scale (uniformMatrix4fv hook on viewmodel) ---
        createSectionHeader(gunScaleCard, 'Gun scale mod');

        const gunScaleSub = document.createElement('div');
        gunScaleSub.className = 'melee-vm-wireframe-sub';

        function refreshGunScaleUi() {
            gunScaleSub.style.display = cfg.weaponScaleEnabled ? '' : 'none';
        }

        createOption(gunScaleCard, '', cfg.weaponScaleEnabled, (enabled) => {
            setWeaponScaleEnabled(enabled);
            refreshGunScaleUi();
        });

        createSectionDescription(gunScaleCard, 'Resize & Reposition weapon/melee');
        gunScaleCard.appendChild(gunScaleSub);

        const gunScaleScaleRow = createGunScaleSliderRow(
            gunScaleSub,
            'Scale',
            cfg.weaponScale,
            0.1,
            3,
            0.01,
            (value) => value.toFixed(2) + 'x',
            normalizeWeaponScale,
            1,
            (value) => {
                cfg.weaponScale = value;
                applyGunScaleSettings();
            }
        );

        const gunScaleOffsetXRow = createGunScaleSliderRow(
            gunScaleSub,
            'Offset X',
            cfg.weaponOffsetX,
            -0.5,
            0.5,
            0.01,
            (value) => value.toFixed(2),
            normalizeWeaponOffset,
            0,
            (value) => {
                cfg.weaponOffsetX = value;
                applyGunScaleSettings();
            }
        );

        const gunScaleOffsetYRow = createGunScaleSliderRow(
            gunScaleSub,
            'Offset Y',
            cfg.weaponOffsetY,
            -0.5,
            0.5,
            0.01,
            (value) => value.toFixed(2),
            normalizeWeaponOffset,
            0,
            (value) => {
                cfg.weaponOffsetY = value;
                applyGunScaleSettings();
            }
        );

        const gunScaleOffsetZRow = createGunScaleSliderRow(
            gunScaleSub,
            'Offset Z',
            cfg.weaponOffsetZ,
            -0.5,
            0.5,
            0.01,
            (value) => value.toFixed(2),
            normalizeWeaponOffset,
            0,
            (value) => {
                cfg.weaponOffsetZ = value;
                applyGunScaleSettings();
            }
        );

        const gunScaleResetRow = document.createElement('div');
        gunScaleResetRow.className = 'melee-vm-row';
        gunScaleResetRow.style.justifyContent = 'flex-end';

        const gunScaleResetBtn = document.createElement('button');
        gunScaleResetBtn.type = 'button';
        gunScaleResetBtn.className = 'melee-vm-set-action-btn';
        gunScaleResetBtn.textContent = 'Reset to default';
        gunScaleResetBtn.addEventListener('click', () => {
            cfg.weaponScale = 1;
            cfg.weaponOffsetX = 0;
            cfg.weaponOffsetY = 0;
            cfg.weaponOffsetZ = 0;
            applyGunScaleSettings();
            gunScaleScaleRow.resetToDefault();
            gunScaleOffsetXRow.resetToDefault();
            gunScaleOffsetYRow.resetToDefault();
            gunScaleOffsetZRow.resetToDefault();
            gunScaleResetBtn.blur();
        });
        gunScaleResetRow.appendChild(gunScaleResetBtn);
        gunScaleSub.appendChild(gunScaleResetRow);

        refreshGunScaleUi();

        const swapperCard = makeCard(swapperTab);
        // --- Melee tab: bayonet/toma skin dropdowns + preview ---
        createSectionDescription(swapperCard, 'Select entries from the dropdowns, to instantly swap skins.');

        createWeaponSwapperCard(swapperCard, 'bayonet', { includeSearch: true, compactLayout: true, previewSize: 104 });
        createWeaponSwapperCard(swapperCard, 'tomahawk', { includeSearch: true, showDivider: true, compactLayout: true, previewSize: 104 });
        createMeleeGunsFinderHint(swapperCard);

        const gunCard = makeCard(gunTab);
        createSectionHeader(gunCard, 'Guns');
        createSectionDescription(gunCard, 'Select a Weapon from the main dropdown, than choose from the second dropdown or Search to instantly swap skins.');

        let activeGunWeaponId = localStorage.getItem('kirka-gun-tab-weapon') || 'ar9';
        if (!WEAPON_REGISTRY[activeGunWeaponId] || WEAPON_REGISTRY[activeGunWeaponId].tab !== 'guns') {
            activeGunWeaponId = 'ar9';
        }

        const gunWeaponPickerWrap = document.createElement('div');
        gunWeaponPickerWrap.className = 'melee-vm-gun-weapon-picker';
        gunCard.appendChild(gunWeaponPickerWrap);

        const gunSwapperMount = document.createElement('div');
        gunSwapperMount.className = 'melee-vm-gun-swapper-mount';
        gunCard.appendChild(gunSwapperMount);

        const gunWeaponOptions = { '': 'Select weapon…' };
        for (let i = 0; i < GUN_TAB_WEAPON_ORDER.length; i++) {
            const wid = GUN_TAB_WEAPON_ORDER[i];
            gunWeaponOptions[wid] = WEAPON_REGISTRY[wid].label;
        }

        let gunWeaponPicker = null;
        let gunSwapperUi = null;

        function mountGunSwapperCard(weaponId) {
            if (!weaponId || !WEAPON_REGISTRY[weaponId]) {
                gunSwapperMount.innerHTML = '';
                const empty = document.createElement('div');
                empty.className = 'melee-vm-gun-empty';
                empty.textContent = 'Select a weapon above to swap skins.';
                gunSwapperMount.appendChild(empty);
                gunSwapperUi = null;
                return;
            }
            activeGunWeaponId = weaponId;
            try { localStorage.setItem('kirka-gun-tab-weapon', weaponId); } catch (_) {}

            if (gunSwapperUi && gunSwapperUi.switchWeapon) {
                gunSwapperUi.switchWeapon(weaponId);
                return;
            }

            gunSwapperMount.innerHTML = '';
            gunSwapperUi = createWeaponSwapperCard(gunSwapperMount, weaponId, {
                reusable: true,
                includeSearch: true,
                showDivider: false,
                compactLayout: true,
                previewSize: 104,
            });
        }

        gunWeaponPicker = createCustomDropdown(
            gunWeaponPickerWrap,
            'Weapon',
            gunWeaponOptions,
            activeGunWeaponId,
            function (weaponId) {
                mountGunSwapperCard(weaponId);
            }
        );

        mountGunSwapperCard(activeGunWeaponId);
        gunWeaponPicker.setValue(activeGunWeaponId);

        // --- Guns tab: find any skin catalog finder ---
        const catalogFinderCard = makeCard(gunTab);
        createSectionHeader(catalogFinderCard, 'Find any skin');

        function buildFindAnySkinDescription() {
            const count = String(Object.keys(SKIN_DATABASE).length).padStart(3, '0');
            return 'Search FULL skin catalog, press "add to dropdown" to add into its respective dropdown(saves locally). almost all weapon .webps searchable (' + count + '), updated 7/2/26.';
        }

        const catalogSearchWrap = document.createElement('div');
        catalogSearchWrap.className = 'melee-vm-catalog-search-wrap';

        const catalogSearchInput = document.createElement('input');
        catalogSearchInput.type = 'text';
        catalogSearchInput.placeholder = 'Search any skin name…';
        catalogSearchInput.autocomplete = 'off';
        catalogSearchInput.spellcheck = false;
        catalogSearchInput.className = 'melee-vm-skin-search-input';

        const catalogSuggestionList = document.createElement('div');
        catalogSuggestionList.className = 'melee-vm-skin-search-list';
        catalogSuggestionList.style.cssText = 'display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; width: 100%; max-height: 220px; overflow-y: auto; z-index: 100003;';

        catalogSearchWrap.appendChild(catalogSearchInput);
        catalogSearchWrap.appendChild(catalogSuggestionList);
        catalogFinderCard.appendChild(catalogSearchWrap);

        const catalogActionsRow = document.createElement('div');
        catalogActionsRow.className = 'melee-vm-set-actions melee-vm-catalog-actions';

        const catalogResetBtn = document.createElement('button');
        catalogResetBtn.type = 'button';
        catalogResetBtn.className = 'melee-vm-set-action-btn';
        catalogResetBtn.textContent = 'Reset';

        const catalogAddBtn = document.createElement('button');
        catalogAddBtn.type = 'button';
        catalogAddBtn.className = 'melee-vm-set-action-btn is-primary';
        catalogAddBtn.textContent = 'Add to dropdown';
        catalogAddBtn.disabled = true;

        catalogActionsRow.appendChild(catalogResetBtn);
        catalogActionsRow.appendChild(catalogAddBtn);
        catalogFinderCard.appendChild(catalogActionsRow);

        const catalogAddStatus = document.createElement('div');
        catalogAddStatus.className = 'melee-vm-catalog-add-status';
        catalogAddStatus.style.display = 'none';
        catalogFinderCard.appendChild(catalogAddStatus);

        const catalogSelected = document.createElement('div');
        catalogSelected.className = 'melee-vm-catalog-selected';

        const catalogPreviewMount = document.createElement('div');
        catalogPreviewMount.className = 'melee-vm-weapon-preview';
        catalogPreviewMount.style.flex = '0 0 112px';

        const catalogSelectedInfo = document.createElement('div');
        catalogSelectedInfo.className = 'melee-vm-catalog-selected-info';

        const catalogSelectedName = document.createElement('div');
        catalogSelectedName.className = 'melee-vm-catalog-selected-name';
        catalogSelectedName.textContent = 'Select a skin above';

        const catalogSelectedWeapon = document.createElement('div');
        catalogSelectedWeapon.className = 'melee-vm-catalog-selected-weapon';

        catalogSelectedInfo.appendChild(catalogSelectedName);
        catalogSelectedInfo.appendChild(catalogSelectedWeapon);
        catalogSelected.appendChild(catalogPreviewMount);
        catalogSelected.appendChild(catalogSelectedInfo);
        catalogFinderCard.appendChild(catalogSelected);

        const catalogFinderHint = document.createElement('div');
        catalogFinderHint.className = 'melee-vm-hint melee-vm-catalog-hint';
        catalogFinderHint.textContent = buildFindAnySkinDescription();
        catalogFinderCard.appendChild(catalogFinderHint);

        let catalogSelectedHash = null;
        let catalogSelectedWeaponId = null;
        let catalogAddJustSucceeded = false;

        const catalogPreviewStubOptions = { none: 'Equipped' };
        let updateCatalogPreview = makeSkinPreviewBox(
            catalogPreviewMount,
            'bayonet',
            'Bayonet',
            catalogPreviewStubOptions,
            getFavStorageKey('bayonet'),
            null,
            104,
            { renderOnly: true }
        );

        function clearCatalogAddFeedback() {
            catalogAddJustSucceeded = false;
            catalogAddStatus.classList.remove('is-success');
        }

        function showCatalogAddSuccess() {
            catalogAddJustSucceeded = true;
            catalogAddBtn.disabled = true;
            catalogAddBtn.textContent = 'Added to dropdown';
            catalogAddBtn.classList.remove('is-added', 'is-primary');
            catalogAddBtn.classList.add('is-just-added');
            catalogAddStatus.textContent = 'Saved to the ' + WEAPON_REGISTRY[catalogSelectedWeaponId].label + ' dropdown on Melee/Guns tabs.';
            catalogAddStatus.style.display = '';
            catalogAddStatus.classList.add('is-success');
        }

        function clearCatalogSelection() {
            closeAllPreviewBubbles();
            closeCatalogSuggestions();
            catalogSearchInput.value = '';
            catalogSelectedHash = null;
            catalogSelectedWeaponId = null;
            clearCatalogAddFeedback();
            catalogSelectedName.textContent = 'Select a skin above';
            catalogSelectedWeapon.textContent = '';
            catalogSelected.classList.remove('is-visible');
            updateCatalogPreview.rebind('bayonet', 'Bayonet', catalogPreviewStubOptions, getFavStorageKey('bayonet'));
            updateCatalogPreview('none');
            paintCatalogAddButton();
        }

        function closeCatalogSuggestions() {
            catalogSuggestionList.style.display = 'none';
            catalogSuggestionList.textContent = '';
        }

        function paintCatalogAddButton() {
            if (!catalogSelectedHash || !catalogSelectedWeaponId) {
                catalogAddBtn.disabled = true;
                catalogAddBtn.textContent = 'Add to dropdown';
                catalogAddBtn.classList.remove('is-added', 'is-just-added');
                catalogAddBtn.classList.add('is-primary');
                catalogAddStatus.classList.remove('is-success');
                catalogAddStatus.style.display = 'none';
                catalogAddStatus.textContent = '';
                return;
            }
            if (catalogAddJustSucceeded) {
                return;
            }
            const state = getCatalogSkinDropdownState(catalogSelectedWeaponId, catalogSelectedHash);
            catalogAddBtn.classList.remove('is-just-added');
            catalogAddStatus.style.display = '';
            if (state.inDropdown) {
                catalogAddBtn.disabled = true;
                catalogAddBtn.classList.remove('is-primary');
                catalogAddBtn.classList.add('is-added');
                catalogAddStatus.classList.remove('is-success');
                if (state.source === 'user') {
                    catalogAddBtn.textContent = 'Already added';
                    catalogAddStatus.textContent = 'This skin is already in your ' + WEAPON_REGISTRY[catalogSelectedWeaponId].label + ' dropdown.';
                } else {
                    catalogAddBtn.textContent = 'In default list';
                    catalogAddStatus.textContent = 'This skin is already in the ' + WEAPON_REGISTRY[catalogSelectedWeaponId].label + ' dropdown by default.';
                }
                return;
            }
            catalogAddBtn.disabled = false;
            catalogAddBtn.textContent = 'Add to dropdown';
            catalogAddBtn.classList.remove('is-added');
            catalogAddBtn.classList.add('is-primary');
            catalogAddStatus.classList.remove('is-success');
            catalogAddStatus.textContent = 'Adds to the ' + WEAPON_REGISTRY[catalogSelectedWeaponId].label + ' dropdown on Melee/Guns tabs.';
        }

        function selectCatalogSkin(match) {
            if (!match) return;
            closeAllPreviewBubbles();
            closeCatalogSuggestions();
            clearCatalogAddFeedback();
            catalogSearchInput.value = match.name;

            catalogSelectedHash = match.hash;
            catalogSelectedWeaponId = match.weaponId;

            catalogSelectedName.textContent = match.name;
            catalogSelectedWeapon.textContent = match.weaponLabel;

            catalogSelected.classList.add('is-visible');

            const weaponMeta = WEAPON_REGISTRY[match.weaponId];
            const previewOptions = {};
            previewOptions[match.hash] = match.name;
            updateCatalogPreview.rebind(
                match.weaponId,
                weaponMeta ? weaponMeta.label : match.weaponLabel,
                previewOptions,
                getFavStorageKey(match.weaponId)
            );
            updateCatalogPreview(match.hash);
            paintCatalogAddButton();
        }

        function renderCatalogSuggestions() {
            const matches = searchFullSkinCatalog(catalogSearchInput.value, 18);
            catalogSuggestionList.textContent = '';

            if (!matches.length) {
                if (catalogSearchInput.value.trim()) {
                    const empty = document.createElement('div');
                    empty.textContent = 'No matching skins';
                    empty.style.cssText = 'padding: 8px 12px; font-size: 13px; color: ' + NEO.muted + ';';
                    catalogSuggestionList.appendChild(empty);
                    catalogSuggestionList.style.display = 'block';
                } else {
                    closeCatalogSuggestions();
                }
                return;
            }

            closeAllSkinLists();
            closeAllPreviewBubbles();

            for (let i = 0; i < matches.length; i++) {
                const match = matches[i];
                const item = document.createElement('div');
                item.style.cssText = 'padding: 8px 12px; cursor: pointer; font-size: 13px; color: ' + NEO.text + ';';
                item.onmouseenter = function () { item.style.background = 'rgba(255,255,255,0.07)'; };
                item.onmouseleave = function () { item.style.background = ''; };
                item.onmousedown = function (e) { e.preventDefault(); };

                const row = document.createElement('div');
                row.className = 'melee-vm-catalog-suggestion-row';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = match.name;
                nameSpan.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

                const sub = document.createElement('span');
                sub.className = 'melee-vm-catalog-suggestion-sub';
                if (match.dropdownState.inDropdown) {
                    sub.textContent = match.weaponLabel + (match.dropdownState.source === 'user' ? ' · added' : ' · default');
                } else {
                    sub.textContent = match.weaponLabel;
                }

                row.appendChild(nameSpan);
                row.appendChild(sub);
                item.appendChild(row);

                item.onclick = function (e) {
                    e.stopPropagation();
                    selectCatalogSkin(match);
                    catalogSearchInput.blur();
                };
                catalogSuggestionList.appendChild(item);
            }
            catalogSuggestionList.style.display = 'block';
        }

        catalogSearchInput.addEventListener('input', renderCatalogSuggestions);
        catalogSearchInput.addEventListener('focus', function () {
            if (catalogSearchInput.value.trim()) renderCatalogSuggestions();
        });
        catalogSearchInput.addEventListener('click', function (e) { e.stopPropagation(); });
        catalogSearchWrap.addEventListener('click', function (e) { e.stopPropagation(); });
        catalogSearchInput.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                clearCatalogSelection();
                catalogSearchInput.blur();
                return;
            }
            if (e.key === 'Enter') {
                const first = catalogSuggestionList.querySelector('.melee-vm-catalog-suggestion-row');
                if (first && first.parentElement) {
                    e.preventDefault();
                    first.parentElement.click();
                }
            }
        });

        catalogResetBtn.addEventListener('click', function () {
            clearCatalogSelection();
            catalogResetBtn.blur();
        });

        catalogAddBtn.addEventListener('click', function () {
            if (!catalogSelectedHash || !catalogSelectedWeaponId) return;
            if (addUserExtraSkin(catalogSelectedWeaponId, catalogSelectedHash)) {
                notifySkinOptionsChanged();
                showCatalogAddSuccess();
                if (catalogSuggestionList.style.display !== 'none') renderCatalogSuggestions();
            }
            catalogAddBtn.blur();
        });

        console.log('[ShowOnlyKnife] Menu ready — Ctrl+O to toggle');
    }

    function bootSwapper() {
        bindSwapperMenuHotkeys();
        publishSwapperMenuApi();
        scheduleSavedSwapBootstrap();
        console.log('[ShowOnlyKnife] Swapper ready — Ctrl+O for menu');
    }

    loadSkinCatalog().then(bootSwapper).catch(function (err) {
        console.error('[ShowOnlyKnife] Could not start — skin catalog unavailable:', err);
    });

    let matchWarmDone = false;
    let loadoutWarmTimer = null;
    let lobbyWarmAttempts = 0;

    function runMatchWarm() {
        preloadSavedSwapTargetsOnce();
        warmVisibleLoadoutSwaps();
        refreshAllSavedSwapWeapons();
    }

    function runLobbyWarm() {
        if (!anySwapActive || !hookedGlEntries.length) return;
        preloadSavedSwapTargetsOnce();
        warmVisibleLoadoutSwaps();
        refreshAllSavedSwapWeapons();
    }

    setInterval(function () {
        const inGame = !!document.querySelector('.desktop-game-interface');
        const inLobby = !!document.querySelector('.interface') && !inGame;
        if (!inGame) {
            matchWarmDone = false;
            if (loadoutWarmTimer) {
                clearInterval(loadoutWarmTimer);
                loadoutWarmTimer = null;
            }
        }
        if (inLobby && anySwapActive) {
            lobbyWarmAttempts += 1;
            if (lobbyWarmAttempts <= 30 || (lobbyWarmAttempts <= 46 && lobbyWarmAttempts % 4 === 0)) {
                runLobbyWarm();
            }
        } else {
            lobbyWarmAttempts = 0;
        }
        if (!inGame) {
            return;
        }
        if (matchWarmDone) return;
        matchWarmDone = true;
        runMatchWarm();
        let attempts = 0;
        loadoutWarmTimer = setInterval(function () {
            if (!document.querySelector('.desktop-game-interface')) {
                clearInterval(loadoutWarmTimer);
                loadoutWarmTimer = null;
                return;
            }
            warmVisibleLoadoutSwaps();
            attempts += 1;
            if (attempts >= 10) {
                clearInterval(loadoutWarmTimer);
                loadoutWarmTimer = null;
            }
        }, 350);
    }, 250);

})();
