// ==UserScript==
// @name         Kirka Texture Swapper 
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

    }
