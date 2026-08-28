// Configuration and URL handling, shared by the browser and Node tests.
(function (root) {
    'use strict';
    const DEFAULTS = Object.freeze({
        album: '', view: 'folders', sort: 'filename', interval: 5, imageMode: 'fit',
        shuffle: false, autoRefresh: true, refreshInterval: 60, tvMode: false,
        autoplay: false, rememberPreferences: true, controls: true, showFilenames: true
    });
    const BOOLEAN_KEYS = ['shuffle', 'autoRefresh', 'tvMode', 'autoplay', 'rememberPreferences', 'controls', 'showFilenames'];
    const SAVED_KEYS = ['album', 'view', 'sort', 'interval', 'imageMode', 'shuffle', 'autoRefresh'];
    const INTERVALS = [3, 5, 10, 15, 30, 60, 300, 900, 3600];

    function object(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function normalizeAlbum(value) {
        if (typeof value !== 'string' || /[\\\x00-\x1f]/.test(value)) throw new Error('Invalid album path');
        const parts = value.split('/').filter(Boolean);
        if (parts.some(part => part === '.' || part === '..')) throw new Error('Album must stay within its source');
        return parts.join('/');
    }

    function validateSettings(value, sources) {
        if (!object(value)) throw new Error('Settings must be a JSON object');
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (BOOLEAN_KEYS.includes(key)) {
                if (typeof item !== 'boolean') throw new Error(`${key} must be true or false`);
            } else if (key === 'source') {
                if (!sources.some(source => source.id === item)) throw new Error(`Unknown source: ${item}`);
            } else if (key === 'album') {
                result.album = normalizeAlbum(item);
                continue;
            } else if (key === 'view') {
                if (!['all', 'folders'].includes(item)) throw new Error('view must be all or folders');
            } else if (key === 'sort') {
                if (!['newest', 'oldest', 'filename'].includes(item)) throw new Error('sort must be newest, oldest, or filename');
            } else if (key === 'imageMode') {
                if (!['fit', 'original'].includes(item)) throw new Error('imageMode must be fit or original');
            } else if (key === 'refreshInterval') {
                if (!Number.isInteger(item) || item < 1 || item > 86400) throw new Error('refreshInterval must be an integer from 1 to 86400 seconds');
            } else if (key === 'interval') {
                if (!INTERVALS.includes(item)) throw new Error('interval must be 3, 5, 10, 15, 30, 60, 300, 900, or 3600');
            } else {
                throw new Error(`Unknown setting: ${key}`);
            }
            result[key] = item;
        }
        return result;
    }

    function normalizeConfig(raw, pageUrl) {
        if (!object(raw)) throw new Error('Configuration must be a JSON object');
        for (const key of Object.keys(raw)) {
            if (!['sources', 'defaults', 'index', 'embed'].includes(key)) throw new Error(`Unknown configuration section: ${key}`);
        }
        const baseUrl = new URL('./', pageUrl).href;
        const entries = raw.sources === undefined ? [{ id: 'photos', label: 'Photos', path: 'photos/' }] : raw.sources;
        if (!Array.isArray(entries) || !entries.length) throw new Error('sources must be a nonempty array');
        const ids = new Set();
        const sources = entries.map(entry => {
            if (!object(entry) || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.id) || ids.has(entry.id)) {
                throw new Error('Each source needs a unique id using letters, numbers, hyphens, or underscores');
            }
            if (typeof entry.label !== 'string' || !entry.label.trim()) throw new Error('Each source needs a label');
            if (typeof entry.path !== 'string' || !entry.path.trim() || /[\\\x00-\x1f]/.test(entry.path)) throw new Error('Each source needs a web directory path');
            const url = new URL(entry.path, baseUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
                throw new Error('Source paths must be HTTP(S) directories without credentials, query strings, or fragments');
            }
            if (!url.pathname.endsWith('/')) url.pathname += '/';
            ids.add(entry.id);
            return { id: entry.id, label: entry.label.trim(), path: entry.path, url: url.href };
        });
        return {
            baseUrl, sources,
            defaults: validateSettings(raw.defaults === undefined ? {} : raw.defaults, sources),
            index: validateSettings(raw.index === undefined ? {} : raw.index, sources),
            embed: validateSettings(raw.embed === undefined ? {} : raw.embed, sources)
        };
    }

    function applyLayer(settings, layer) {
        // TV mode is a preset; explicit fields in the same layer take priority.
        const preset = layer.tvMode === true
            ? { imageMode: 'fit', shuffle: true, autoRefresh: true, autoplay: true } : {};
        return { ...settings, ...preset, ...layer };
    }

    function urlSettings(params, sources, warnings) {
        const aliases = { source: 'source', album: 'album', view: 'view', sort: 'sort', interval: 'interval',
            imageMode: 'imageMode', shuffle: 'shuffle', autorefresh: 'autoRefresh',
            tv: 'tvMode', autoplay: 'autoplay', remember: 'rememberPreferences', controls: 'controls', showFilenames: 'showFilenames' };
        const layer = {};
        for (const [param, key] of Object.entries(aliases)) {
            if (!params.has(param)) continue;
            let value = params.get(param);
            try {
                if (BOOLEAN_KEYS.includes(key)) {
                    if (value !== '0' && value !== '1') throw new Error(`${param} must be 0 or 1`);
                    value = value === '1';
                }
                if (key === 'interval') value = Number(value);
                Object.assign(layer, validateSettings({ [key]: value }, sources));
            } catch (error) { warnings.push(`Ignored URL option: ${error.message}`); }
        }
        return layer;
    }

    function resolveSettings(config, search, readStored = () => null) {
        const warnings = [];
        const params = new URLSearchParams(search);
        const profile = params.get('profile') === 'embed' ? 'embed' : 'index';
        if (params.has('profile') && !['index', 'embed'].includes(params.get('profile'))) warnings.push('Unknown profile; using index');
        let settings = { ...DEFAULTS, source: config.sources[0].id, refreshInterval: profile === 'embed' ? 300 : 60, rememberPreferences: profile === 'index' };
        settings = applyLayer(settings, config.defaults);
        settings = applyLayer(settings, config[profile]);
        const overrides = urlSettings(params, config.sources, warnings);
        const source = config.sources.find(item => item.id === (overrides.source || settings.source));
        settings.source = source.id;
        const remember = overrides.rememberPreferences ?? settings.rememberPreferences;
        const preferenceKey = `folderframe.preferences:${config.baseUrl}:${profile}:${source.id}:${source.url}`;
        if (remember) {
            try {
                let raw = readStored(preferenceKey);
                // Preserve pre-config preferences only for the original Photos source in index.
                if (!raw && profile === 'index' && source.id === 'photos' && source.url === new URL('photos/', config.baseUrl).href) {
                    const legacy = readStored('gallery.preferences');
                    if (legacy) {
                        const old = JSON.parse(legacy);
                        raw = JSON.stringify({ album: old.folder, view: old.galleryViewMode,
                            interval: old.interval, imageMode: old.imageMode, shuffle: old.shuffle,
                            autoRefresh: old.autoRefresh, tvMode: old.tvMode });
                    }
                }
                if (raw) {
                    const saved = JSON.parse(raw);
                    if (!object(saved)) throw new Error('Saved settings must be an object');
                    const selected = Object.fromEntries(SAVED_KEYS.filter(key => key in saved).map(key => [key, saved[key]]));
                    settings = applyLayer(settings, validateSettings(selected, config.sources));
                }
            } catch (error) { warnings.push(`Could not load saved preferences: ${error.message}`); }
        }
        settings = applyLayer(settings, overrides);
        return { settings, profile, source, preferenceKey, warnings };
    }

    function directoryUrl(source, folder = '') {
        const album = normalizeAlbum(folder);
        const suffix = album ? album.split('/').map(encodeURIComponent).join('/') + '/' : '';
        return new URL(suffix, source.url).href;
    }

    function mediaUrl(source, folder, filename) {
        if (!filename || /[\/\\]/.test(filename) || ['.', '..'].includes(filename)) throw new Error('Invalid media filename');
        return new URL(encodeURIComponent(filename), directoryUrl(source, folder)).href;
    }

    function relativeMediaPath(source, file) {
        const url = new URL(file);
        const base = new URL(source.url);
        return decodeURIComponent(url.origin === base.origin && url.pathname.startsWith(base.pathname)
            ? url.pathname.slice(base.pathname.length) : url.pathname.split('/').pop());
    }

    function listingEntry(href, requestedUrl) {
        // Only direct children of the requested directory; never follow parents,
        // foreign origins, query/sort links, or absolute links outside the source.
        if (!href || href.startsWith('?') || href.startsWith('#')) return null;
        try {
            const base = new URL(requestedUrl);
            const target = new URL(href, base);
            if (target.origin !== base.origin || target.search || target.hash || !target.pathname.startsWith(base.pathname)) return null;
            const directory = target.pathname.endsWith('/');
            const child = target.pathname.slice(base.pathname.length).replace(/\/$/, '');
            if (!child || child.includes('/')) return null;
            const name = decodeURIComponent(child);
            if (!name || /[\/\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) return null;
            return { name, directory };
        } catch { return null; }
    }

    const api = { normalizeConfig, resolveSettings, directoryUrl, mediaUrl, relativeMediaPath, listingEntry };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.FolderFrameSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
