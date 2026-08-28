// FolderFrame
// Features: directory-backed albums, HEIC/HEIF handling, shuffle slideshow,
// auto-rescan, TV/photo-frame mode, local preferences, and recursive folder browsing.

const settingsApi = window.FolderFrameSettings;
const resilience = window.FolderFrameResilience;
let scanSession = null, gridSession = null, viewerSession = null;
let failedNavigation = null;
const DIRECTORY_TIMEOUT = 15000, MEDIA_TIMEOUT = 30000;
function clearMediaSource(element) {
    if (element.removeAttribute) element.removeAttribute('src');
    else element.src = '';
    element.load?.();
}

function stopViewerSession() {
    if (!viewerSession) return;
    viewerSession.controller.abort();
    clearTimeout(viewerSession.timer);
    viewerSession = null;
}
function stopGridSession() {
    stopAlbumPreviews();
    if (!gridSession) return;
    gridSession.controller.abort();
    gridSession.observer?.disconnect();
    gridSession.cleanups.forEach(cleanup => cleanup());
    gridSession = null;
}
function startGridSession() {
    stopGridSession();
    gridSession = { controller: new AbortController(), cleanups: [], observer: null };
    return gridSession;
}

let galleryConfig;
let activeSource;
let preferenceKey;
let rememberPreferences = true;
let controlsEnabled = true;
let swipeStart = null;
let gridReturn = null;
let albumPreviewSession = null;

function stopAlbumPreviews() {
    if (!albumPreviewSession) return;
    albumPreviewSession.controller.abort();
    albumPreviewSession.items?.forEach((controller, item) => { controller.abort(); item.coverImage && (item.coverImage.src = ''); });
    albumPreviewSession.observer?.disconnect();
    albumPreviewSession.queue.length = 0;
    albumPreviewSession = null;
}

function startAlbumPreviews() {
    stopAlbumPreviews();
    const session = { controller: new AbortController(), observer: null, queue: [], active: 0, items: new Map() };
    albumPreviewSession = session;
    const pump = () => {
        if (session.controller.signal.aborted) return;
        while (session.active < 3 && session.queue.length) {
            const { item, folder, controller } = session.queue.shift();
            if (controller.signal.aborted) continue;
            session.active++;
            loadAlbumPreview(item, folder, controller.signal)
                .finally(() => { session.active--; pump(); });
        }
    };
    const enqueue = item => {
        if (session.items.has(item)) return;
        const controller = new AbortController();
        session.items.set(item, controller);
        session.queue.push({ item, folder: item.dataset.albumFolder, controller }); pump();
    };
    if ('IntersectionObserver' in window) {
        session.observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) enqueue(entry.target);
                else {
                    session.items.get(entry.target)?.abort(); session.items.delete(entry.target);
                    if (entry.target.coverImage) entry.target.coverImage.src = '';
                    entry.target.classList.remove('has-album-cover');
                }
            }
        }, { root: gridViewContainer, rootMargin: '300px' });
    }
    return item => session.observer ? session.observer.observe(item) : enqueue(item);
}

async function loadAlbumPreview(item, folder, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    let timeout;
    let preview;
    const fallback = () => {
        if (signal.aborted) return;
        if (preview) preview.hidden = true;
        item.classList.remove('has-album-cover');
    };
    try {
        if (signal.aborted) return;
        const listing = await scanDirectory(folder, { signal: controller.signal });
        // scanDirectory already sorts naturally by filename. Do not crawl descendants.
        const file = listing.filePaths.find(isImageFile);
        if (!file || signal.aborted || controller.signal.aborted) return;
        const url = isHeicFile(file) ? await getSpecialImageURL(file, signal, 'thumbnail') : file;
        if (signal.aborted || controller.signal.aborted) return;
        preview = item.coverImage || document.createElement('img');
        item.coverImage = preview;
        preview.className = 'album-cover';
        preview.alt = '';
        preview.hidden = true;
        preview.decoding = 'async';
        preview.onload = () => {
            if (signal.aborted) return;
            clearTimeout(timeout);
            preview.hidden = false;
            item.classList.add('has-album-cover');
        };
        preview.onerror = () => { clearTimeout(timeout); fallback(); };
        timeout = setTimeout(() => { fallback(); preview.src = ''; }, MEDIA_TIMEOUT);
        signal.addEventListener('abort', () => { clearTimeout(timeout); preview.src = ''; }, { once: true });
        if (!preview.parentNode) item.appendChild(preview);
        preview.src = url;
    } catch (error) {
        // An unavailable preview never prevents opening the album.
        fallback();
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}
let refreshInterval = 60; // Seconds; resolved per index/embed profile.

let mediaFiles = [];
let subfolders = [];
let currentFolder = '';
let currentIndex = 0;
let zoom = 1.0, panX = 0, panY = 0;
let isDragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
let isPinching = false, initialDist = 0, initialZoom = 1.0, initialMidX = 0, initialMidY = 0, initialPanX = 0, initialPanY = 0;
let slideshowPlaying = false, slideshowTimer = null, slideshowInterval = 5, slideProgress = 0;
let slideshowAnimationFrame = null, slideshowStartedAt = 0;
let uiVisible = true, idleTimer = null, imageMode = 'fit', isGridViewActive = true;
let shuffleEnabled = false, autoRefreshEnabled = true, tvModeEnabled = false;
let galleryViewMode = 'folders'; // 'folders' or 'all'
let sortMode = 'filename';
const modifiedDateCache = new Map();
const DATE_CACHE_TTL = 24 * 60 * 60 * 1000;
const DATE_CACHE_LIMIT = 2000;
let dateCacheKey = null;

function trimDateCache(now = Date.now()) {
    for (const [file, entry] of modifiedDateCache) {
        if (!entry || !Number.isFinite(entry.checked) || entry.checked > now ||
            now - entry.checked >= DATE_CACHE_TTL ||
            (entry.date !== null && !Number.isFinite(entry.date))) modifiedDateCache.delete(file);
    }
    const oldest = [...modifiedDateCache].sort((a, b) => a[1].checked - b[1].checked);
    for (const [file] of oldest.slice(0, Math.max(0, oldest.length - DATE_CACHE_LIMIT))) modifiedDateCache.delete(file);
}

function loadDateCache() {
    const key = `folderframe.date-cache:v1:${galleryConfig.baseUrl}:${activeSource.id}:${activeSource.url}`;
    if (dateCacheKey === key) return;
    modifiedDateCache.clear();
    dateCacheKey = key;
    try {
        const entries = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(entries)) return;
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
            const [file, value] = entry;
            // Cached metadata must never introduce URLs outside the selected source.
            if (!file.startsWith(activeSource.url) || !value || typeof value !== 'object') continue;
            modifiedDateCache.set(file, { date: value.date, checked: value.checked });
        }
        trimDateCache();
    } catch (error) {
        // Private browsing, corrupt JSON, and denied storage must not stop sorting.
        modifiedDateCache.clear();
    }
}

function saveDateCache() {
    trimDateCache();
    try {
        localStorage.setItem(dateCacheKey, JSON.stringify([...modifiedDateCache]
            .filter(([file]) => file.startsWith(activeSource.url))));
    } catch (error) {
        // Keep the bounded in-memory cache if storage is full or unavailable.
    }
}
let autoRefreshTimer = null;
let isScanning = false;
let scannedFolders = 0, scannedFiles = 0;
let mediaLoadId = 0;
let mediaFailed = false;
let imageReady = false;

// Cache only object URLs we create ourselves. Normal HTTP URLs are never revoked.
let specialImagePool = null;

const $ = (id) => document.getElementById(id);
const viewport = $('media-viewport');
const container = $('media-container');
const img = $('gallery-image');
const video = $('gallery-video');
const mediaTitle = $('media-title');
const mediaIndex = $('media-index');
const btnResetZoom = $('btn-reset-zoom');
const btnImageMode = $('btn-image-mode');
const imageModeText = $('image-mode-text');
const btnPlayPause = $('btn-play-pause');
const playIcon = btnPlayPause.querySelector('.play-icon');
const pauseIcon = btnPlayPause.querySelector('.pause-icon');
const slideshowText = $('slideshow-text');
const selectInterval = $('select-interval');
const progressBar = $('progress-bar');
const progressContainer = $('progress-container');
const btnFullscreen = $('btn-fullscreen');
const navLeft = $('nav-left');
const navRight = $('nav-right');
const helpHint = $('help-hint');
const warningOverlay = $('warning-overlay');
const btnRetryWarning = $('btn-retry-warning');
const wrapper = $('gallery-wrapper');
const gridViewContainer = $('grid-view-container');
const thumbnailGrid = $('thumbnail-grid');
const btnRefreshGrid = $('btn-refresh-grid');
const btnShowGrid = $('btn-show-grid');
const gridCount = $('grid-count');
const gridPath = $('grid-path');
const breadcrumb = $('breadcrumb');
const btnShuffle = $('btn-shuffle');
const btnAutoRefresh = $('btn-auto-refresh');
const btnViewMode = $('btn-view-mode');
const btnTvMode = $('btn-tv-mode');
const scanStatus = $('scan-status');
const videoErrorOverlay = $('video-error-overlay');
const videoErrorText = $('video-error-text');
const videoErrorFfmpeg = $('video-error-ffmpeg');
const btnCloseVideoError = $('btn-close-video-error');

window.addEventListener('DOMContentLoaded', async () => {
    await loadConfiguration();
    setupEventListeners();
    updateControlStates();
    updateFullscreenButton();
    await loadGallery({ preserveView: false });
    startAutoRefreshTimer();

    if (slideshowPlaying && mediaFiles.length > 0 && isGridViewActive) {
        enterFullScreenViewer(currentIndex);
    } else if (!mediaFiles.length) {
        stopSlideshow();
    }
});

window.addEventListener('beforeunload', () => {
    scanSession?.abort(); stopViewerSession(); stopGridSession(); clearImageBlobCache();
});

function isHeicFile(path) { return /\.(heic|heif)$/i.test(path); }
function isImageFile(path) { return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(path); }
function isVideoFile(path) { return /\.(mp4|mov)$/i.test(path); }
function isMediaFile(path) { return isImageFile(path) || isVideoFile(path); }

function currentDirectoryUrl(folder = currentFolder) {
    return settingsApi.directoryUrl(activeSource, folder);
}

function mediaUrlFor(filename, folder = currentFolder) {
    return settingsApi.mediaUrl(activeSource, folder, filename);
}

function savePreferences() {
    if (!rememberPreferences || !preferenceKey) return;
    try {
        localStorage.setItem(preferenceKey, JSON.stringify({
            album: currentFolder, interval: slideshowInterval, imageMode,
            shuffle: shuffleEnabled, autoRefresh: autoRefreshEnabled,
            view: galleryViewMode, sort: sortMode
        }));
    } catch (error) {
        // Storage can be unavailable in privacy modes and embedded contexts.
        console.warn('Could not save FolderFrame preferences:', error);
    }
}

async function loadConfiguration() {
    const warnings = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch('./folderframe.config.json', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        galleryConfig = settingsApi.normalizeConfig(await response.json(), location.href);
    } catch (error) {
        galleryConfig = settingsApi.normalizeConfig({}, location.href);
        warnings.push(`Could not use folderframe.config.json (${error.message}). Using built-in defaults.`);
    } finally {
        clearTimeout(timeout);
    }
    const resolved = settingsApi.resolveSettings(galleryConfig, location.search, key => localStorage.getItem(key));
    const startupSettings = resolved.settings;
    activeSource = resolved.source;
    preferenceKey = resolved.preferenceKey;
    rememberPreferences = startupSettings.rememberPreferences;
    controlsEnabled = startupSettings.controls;
    document.body.classList.toggle('hide-filenames', !startupSettings.showFilenames);
    document.body.classList.toggle('controls-free', !controlsEnabled);
    currentFolder = startupSettings.album;
    galleryViewMode = startupSettings.view;
    sortMode = startupSettings.sort;
    slideshowInterval = startupSettings.interval;
    imageMode = startupSettings.imageMode;
    shuffleEnabled = startupSettings.shuffle;
    autoRefreshEnabled = startupSettings.autoRefresh;
    refreshInterval = startupSettings.refreshInterval;
    tvModeEnabled = startupSettings.tvMode;
    slideshowPlaying = startupSettings.autoplay;

    const selector = $('select-source');
    selector.replaceChildren();
    galleryConfig.sources.forEach(source => {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = source.label;
        selector.appendChild(option);
    });
    selector.value = activeSource.id;
    $('source-control').hidden = galleryConfig.sources.length < 2;
    document.querySelectorAll('.configured-source-path').forEach(element => { element.textContent = activeSource.path; });
    warnings.push(...resolved.warnings);
    if (warnings.length) {
        console.warn('FolderFrame settings:', warnings);
        $('config-notice').textContent = warnings.join(' ');
        $('config-notice').hidden = false;
    }
}

function updateControlStates() {
    const sortLabels = { newest: 'Newest', oldest: 'Oldest', filename: 'Filename' };
    $('sort-label').textContent = sortLabels[sortMode];
    $('btn-sort').title = `Sorting: ${sortLabels[sortMode]}. Click to cycle Newest, Oldest, Filename.`;
    $('btn-sort').setAttribute('aria-label', `Sort: ${sortLabels[sortMode]}. Change sorting`);
    selectInterval.value = String(slideshowInterval);
    imageModeText.textContent = imageMode === 'fit' ? 'Fit' : 'Original';
    btnShuffle.classList.remove('is-active');
    btnShuffle.setAttribute('aria-pressed', String(shuffleEnabled));
    btnShuffle.querySelector('.button-label').textContent = shuffleEnabled ? 'Shuffle' : 'Shuffle Off';
    btnAutoRefresh.title = `Automatically rescan every ${refreshInterval} seconds`;
    btnAutoRefresh.classList.remove('is-active');
    btnAutoRefresh.setAttribute('aria-pressed', String(autoRefreshEnabled));
    btnAutoRefresh.querySelector('.button-label').textContent = autoRefreshEnabled ? 'Auto Refresh On' : 'Auto Refresh Off';
    btnViewMode.classList.remove('is-active');
    btnViewMode.setAttribute('aria-pressed', String(galleryViewMode === 'all'));
    // Like the other toggle buttons, the label describes the CURRENT state.
    btnViewMode.querySelector('.button-label').textContent = galleryViewMode === 'all' ? 'All Pics' : 'By Folder';
    btnViewMode.title = galleryViewMode === 'all'
        ? 'Currently showing all media recursively — click to browse by folder'
        : 'Currently browsing by folder — click to show all media recursively';
    btnTvMode.classList.toggle('is-active', tvModeEnabled);
    btnTvMode.setAttribute('aria-pressed', String(tvModeEnabled));
    btnTvMode.querySelector('.button-label').textContent = tvModeEnabled ? 'TV Mode On' : 'TV Mode';
    syncPlayButton();
}

function syncPlayButton() {
    playIcon.style.display = slideshowPlaying ? 'none' : 'inline';
    pauseIcon.style.display = slideshowPlaying ? 'inline' : 'none';
    slideshowText.textContent = slideshowPlaying ? 'Pause' : 'Play';
}

function clearImageBlobCache() { specialImagePool?.invalidate(); }
function removeCacheEntry(filepath) { specialImagePool?.invalidate(filepath); }
function detectImageFormat(arrayBuffer) {
    const b = new Uint8Array(arrayBuffer);
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
    if (b.length >= 6) {
        const gifSignature = ascii(b, 0, 6);
        if (gifSignature === 'GIF87a' || gifSignature === 'GIF89a') return 'gif';
    }

    // ISO Base Media File Format: size(4) + "ftyp" + major brand(4) + compatible brands.
    if (b.length >= 16 && ascii(b, 4, 8) === 'ftyp') {
        const brands = [];
        brands.push(ascii(b, 8, 12));
        for (let offset = 16; offset + 4 <= Math.min(b.length, 64); offset += 4) {
            brands.push(ascii(b, offset, offset + 4));
        }
        const heifBrands = new Set(['heic','heix','hevc','hevx','heim','heis','mif1','msf1']);
        if (brands.some(brand => heifBrands.has(brand))) return 'heic';
    }
    return 'unknown';
}

function ascii(bytes, start, end) {
    return String.fromCharCode(...bytes.slice(start, end));
}

function mimeForFormat(format) {
    return ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[format] || '';
}

async function makeThumbnail(blob) {
    const temporary = URL.createObjectURL(blob);
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve; image.onerror = () => reject(new Error('Thumbnail decode failed'));
            image.src = temporary;
        });
        const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve, reject) => canvas.toBlob(
            result => result ? resolve(result) : reject(new Error('Thumbnail resize failed')), 'image/jpeg', 0.8));
    } finally { URL.revokeObjectURL(temporary); }
}
function getImagePool() {
    if (!specialImagePool) specialImagePool = resilience.createImagePool({
        download: (file, signal) => resilience.request(file, { signal, timeout: MEDIA_TIMEOUT, body: 'arrayBuffer', cache: 'no-store' }),
        decode: async data => {
            const format = detectImageFormat(data);
            if (['jpeg', 'png', 'webp', 'gif'].includes(format)) return new Blob([data], { type: mimeForFormat(format) });
            if (format !== 'heic') throw new Error('Unknown or corrupt image format');
            if (typeof heic2any !== 'function') throw new Error('HEIC decoder library did not load');
            const result = await heic2any({ blob: new Blob([data], { type: 'image/heic' }), toType: 'image/jpeg', quality: 0.92 });
            return Array.isArray(result) ? result[0] : result;
        },
        thumbnail: makeThumbnail,
        createURL: blob => URL.createObjectURL(blob), revokeURL: url => URL.revokeObjectURL(url)
    });
    return specialImagePool;
}
async function getSpecialImageURL(filepath, signal, kind = 'viewer') {
    const lease = await getImagePool().acquire(filepath, kind, signal);
    if (signal?.aborted) { lease.release(); throw resilience.abortError(); }
    if (signal) signal.addEventListener('abort', lease.release, { once: true });
    else lease.release();
    return lease.url;
}

async function scanDirectory(folder = currentFolder, options = {}) {
    const url = currentDirectoryUrl(folder);
    const html = await resilience.request(url, { cache: 'no-store', timeout: DIRECTORY_TIMEOUT, ...options });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const files = new Set();
    const folders = new Set();

    for (const link of doc.querySelectorAll('a')) {
        const entry = settingsApi.listingEntry(link.getAttribute('href'), url);
        if (!entry) continue;
        if (entry.directory) {
            folders.add(entry.name);
        } else if (isMediaFile(entry.name)) {
            files.add(entry.name);
        }
    }

    const filePaths = Array.from(files)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        .map(filename => mediaUrlFor(filename, folder));
    const folderNames = Array.from(folders)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    return { filePaths, folderNames };
}

async function scanDirectoryRecursive(folder = currentFolder, visited = new Set(), listing = null, signal) {
    const normalized = folder.split('/').filter(Boolean).join('/');
    if (signal?.aborted) throw resilience.abortError();
    if (visited.has(normalized)) return { files: [], failedFolders: [] };
    visited.add(normalized);
    const { filePaths, folderNames } = listing || await scanDirectory(normalized, { signal });
    const result = { files: [...filePaths], failedFolders: [] };
    scannedFolders++; scannedFiles += filePaths.length;
    setScanStatus(`Scanning… ${scannedFolders} folders checked · ${scannedFiles} files found`);
    for (const child of folderNames) {
        if (signal?.aborted) throw resilience.abortError();
        const path = normalized ? normalized + '/' + child : child;
        try {
            const nested = await scanDirectoryRecursive(path, visited, null, signal);
            result.files.push(...nested.files);
            result.failedFolders.push(...nested.failedFolders);
        } catch (error) {
            if (signal?.aborted || error.name === 'AbortError') throw error;
            result.failedFolders.push(path);
        }
    }
    return result;
}

function compareFilenames(a, b) {
    const name = url => decodeURIComponent(url.split('/').pop());
    return name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }) ||
        a.localeCompare(b);
}

async function sortMediaFiles(files, mode, refreshDates = false, signal) {
    if (signal?.aborted) throw resilience.abortError();
    if (mode === 'filename') return [...files].sort(compareFilenames);
    loadDateCache();
    trimDateCache();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    // Bound the entire metadata pass, rather than waiting per file indefinitely.
    const timeout = setTimeout(() => controller.abort(), 8000);
    let cursor = 0;
    const now = Date.now();
    const dates = new Map();
    try {
        const worker = async () => {
            while (cursor < files.length) {
                const file = files[cursor++];
                const cached = modifiedDateCache.get(file);
                if (!refreshDates && cached && now - cached.checked < DATE_CACHE_TTL) {
                    dates.set(file, cached.date);
                    continue;
                }
                if (controller.signal.aborted) { dates.set(file, null); continue; }
                let date = null;
                try {
                    const response = await fetch(file, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
                    const header = response.ok ? response.headers?.get('Last-Modified') : null;
                    const parsed = header ? Date.parse(header) : NaN;
                    if (Number.isFinite(parsed)) date = parsed;
                } catch (error) {
                    // No metadata (including unsupported HEAD/CORS): keep the file, sorted last.
                }
                dates.set(file, date);
                if (!controller.signal.aborted) modifiedDateCache.set(file, { date, checked: now });
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); saveDateCache(); }
    if (signal?.aborted) throw resilience.abortError();
    const missing = files.filter(file => dates.get(file) == null).length;
    $('btn-sort').title = `Sorting: ${mode === 'newest' ? 'Newest' : 'Oldest'} by file modification date. ${missing} files without dates sort last by filename. Click to change sorting.`;
    return [...files].sort((a, b) => {
        const left = dates.get(a), right = dates.get(b);
        if (left == null && right != null) return 1;
        if (left != null && right == null) return -1;
        const difference = left != null && right != null ? (left - right) * (mode === 'newest' ? -1 : 1) : 0;
        return difference || compareFilenames(a, b);
    });
}

async function cycleSort() {
    if (isScanning) return;
    const modes = ['newest', 'oldest', 'filename'];
    sortMode = modes[(modes.indexOf(sortMode) + 1) % modes.length];
    updateControlStates();
    await loadGallery();
}

function showScanFailures(folders) {
    const notice = $('scan-failures');
    notice.hidden = !folders.length;
    $('scan-failure-text').textContent = folders.length
        ? 'Scan incomplete. Could not read: ' + folders.join(', ') + '. Previously loaded files from these folders were retained.'
        : '';
}

async function loadGallery({ preserveView = true, forceCacheClear = false, silent = false } = {}) {
    if (isScanning && silent) return;
    scanSession?.abort();
    const session = new AbortController();
    scanSession = session;
    const folder = currentFolder, mode = galleryViewMode;
    const current = () => scanSession === session && !session.signal.aborted;
    isScanning = true;
    scannedFolders = 0; scannedFiles = 0;
    thumbnailGrid.setAttribute('aria-busy', 'true');
    btnRefreshGrid.disabled = true; $('btn-sort').disabled = true;
    $('scan-loading').hidden = false;
    setScanStatus(mediaFiles.length || subfolders.length ? 'Refreshing folders…' : 'Scanning folders…');
    try {
        const listing = await scanDirectory(folder, { signal: session.signal });
        const result = mode === 'all'
            ? await scanDirectoryRecursive(folder, new Set(), listing, session.signal)
            : { files: listing.filePaths, failedFolders: [] };
        if (!current()) return;
        // A failed descendant is unknown, not deleted. Preserve only its previous files.
        for (const file of mediaFiles) {
            if (result.failedFolders.some(path => file.startsWith(currentDirectoryUrl(path))) && !result.files.includes(file)) result.files.push(file);
        }
        const sorted = await sortMediaFiles(result.files, sortMode, forceCacheClear, session.signal);
        if (!current()) return;
        // Capture live viewer identity after awaits: the user may have advanced meanwhile.
        const viewed = mediaFiles[currentIndex];
        const wasGrid = isGridViewActive;
        const changed = JSON.stringify(sorted) !== JSON.stringify(mediaFiles) ||
            JSON.stringify(listing.folderNames) !== JSON.stringify(subfolders);
        mediaFiles = sorted; subfolders = listing.folderNames;
        const retained = viewed && mediaFiles.includes(viewed);
        currentIndex = retained ? mediaFiles.indexOf(viewed) : Math.min(currentIndex, Math.max(0, mediaFiles.length - 1));
        if (forceCacheClear) clearImageBlobCache();
        showScanFailures(result.failedFolders);
        failedNavigation = null;
        $('warning-title').textContent = 'No Media Detected';
        $('warning-message').textContent = 'No supported media found in the selected folder/view.';
        showWarning(!result.failedFolders.length && mediaFiles.length === 0 && (subfolders.length === 0 || !controlsEnabled));
        renderBreadcrumb();
        setScanStatus(result.failedFolders.length ? 'Scan incomplete — some folders unavailable' :
            `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, Boolean(result.failedFolders.length));
        if (!preserveView || (wasGrid && (changed || forceCacheClear)) || !mediaFiles.length) {
            renderGridView();
        } else if (!wasGrid && !retained) {
            enterFullScreenViewer(currentIndex);
        } else if (!wasGrid) {
            mediaIndex.textContent = `${currentIndex + 1} / ${mediaFiles.length}`;
        }
        savePreferences();
        return true;
    } catch (error) {
        if (!current() || error.name === 'AbortError') return;
        console.error('Directory scanning error:', error);
        setScanStatus('Scan failed — check connection and retry', true);
        showScanFailures([folder || activeSource.label]);
        $('warning-title').textContent = 'Could not scan this folder';
        $('warning-message').textContent = 'Check the connection and directory listing, then choose Scan Again.';
        if (!mediaFiles.length && !subfolders.length) showWarning(true);
        return false;
    } finally {
        if (scanSession === session) {
            isScanning = false;
            thumbnailGrid.setAttribute('aria-busy', 'false');
            btnRefreshGrid.disabled = false; $('btn-sort').disabled = false;
            $('scan-loading').hidden = true;
        }
    }
}

function setScanStatus(text, isError = false) {
    if (scanStatus) {
        scanStatus.textContent = text;
        scanStatus.classList.toggle('is-error', isError);
    }
    $('scan-loading-text').textContent = text;
}

function setMediaLoading(text = '') {
    $('media-loading').hidden = !text || !controlsEnabled;
    $('media-loading-text').textContent = text;
    container.setAttribute('aria-busy', String(Boolean(text)));
}

function watchThumbnail(element, item, videoThumbnail = false) {
    const session = gridSession;
    let timer;
    item.classList.add('thumb-loading');
    const finish = () => {
        clearTimeout(timer);
        if (session?.controller.signal.aborted || element.resourceActive === false) return;
        item.classList.remove('thumb-loading'); element.classList.add('thumb-loaded');
    };
    element.onload = finish;
    if (videoThumbnail) element.onloadeddata = element.onloadedmetadata = finish;
    element.onerror = () => {
        finish();
        if (session?.controller.signal.aborted || element.resourceActive === false) return;
        item.classList.add('thumb-error');
        if (item.failedPreview) return;
        item.failedPreview = true;
        const fallback = document.createElement('span');
        fallback.className = 'thumbnail-unavailable'; fallback.textContent = 'Preview unavailable';
        item.appendChild(fallback);
    };
    // Native lazy images start their deadline only once in preload range.
    element.startDeadline = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { element.onerror?.(); element.src = ''; }, MEDIA_TIMEOUT);
    };
    element.cancelDeadline = () => clearTimeout(timer);
    if (videoThumbnail) element.startDeadline();
    session?.cleanups.push(() => {
        clearTimeout(timer);
        element.onload = element.onerror = element.onloadeddata = element.onloadedmetadata = null;
        element.pause?.(); clearMediaSource(element);
    });
}

function showWarning(show) { warningOverlay.style.display = show ? 'flex' : 'none'; }
function isPhotoActive() { return mediaFiles[currentIndex] ? isImageFile(mediaFiles[currentIndex]) : false; }

function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    const root = document.createElement('button');
    root.className = 'crumb';
    root.textContent = activeSource.label;
    root.addEventListener('click', () => navigateToFolder(''));
    breadcrumb.appendChild(root);

    const parts = currentFolder.split('/').filter(Boolean);
    let running = '';
    parts.slice(0, -1).forEach((part) => {
        const sep = document.createElement('span');
        sep.className = 'crumb-separator';
        sep.textContent = '›';
        breadcrumb.appendChild(sep);
        running = running ? `${running}/${part}` : part;
        const target = running;
        const crumb = document.createElement('button');
        crumb.className = 'crumb';
        crumb.textContent = part;
        crumb.addEventListener('click', () => navigateToFolder(target));
        breadcrumb.appendChild(crumb);
    });
    if (galleryViewMode === 'all') {
        gridPath.textContent = currentFolder
            ? `${parts[parts.length - 1]} • including subfolders`
            : 'All media • including subfolders';
    } else {
        gridPath.textContent = parts[parts.length - 1] || 'Sorted by folder';
    }
    gridPath.title = currentFolder || activeSource.label;
    gridPath.setAttribute('aria-current', currentFolder ? 'location' : 'false');
}

async function navigateToFolder(folder) {
    scanSession?.abort();
    stopViewerSession(); stopGridSession();
    const previousFolder = currentFolder;
    gridReturn = null;
    currentFolder = folder;
    gridViewContainer.scrollTop = 0;
    currentIndex = 0;
    isGridViewActive = true;
    stopSlideshow();
    const succeeded = await loadGallery({ preserveView: false });
    if (succeeded === false && currentFolder === folder) {
        failedNavigation = folder;
        currentFolder = previousFolder;
        renderBreadcrumb(); renderGridView();
    }
}

function renderGridView() {
    stopViewerSession();
    const session = startGridSession();
    const returnPosition = !isGridViewActive && gridReturn &&
        gridReturn.folder === currentFolder && gridReturn.view === galleryViewMode ? gridReturn : null;
    let returnTile = null;
    setMediaLoading();
    if (!controlsEnabled) {
        gridViewContainer.style.display = 'none';
        if (mediaFiles.length) enterFullScreenViewer(currentIndex);
        else {
            mediaLoadId++;
            stopSlideshow();
            video.pause();
            viewport.style.display = 'none';
        }
        return;
    }
    mediaLoadId++;
    mediaFailed = false;
    videoErrorOverlay.style.display = 'none';
    isGridViewActive = true;
    thumbnailGrid.innerHTML = '';
    const total = mediaFiles.length;
    const albums = galleryViewMode === 'folders' ? subfolders.length : 0;
    gridCount.textContent = galleryViewMode === 'all'
        ? `${total} file${total === 1 ? '' : 's'} • all folders`
        : `${albums ? `${albums} album${albums === 1 ? '' : 's'} • ` : ''}${total} file${total === 1 ? '' : 's'}`;

    // Album cards first when browsing by folder.
    const observeAlbum = galleryViewMode === 'folders' ? startAlbumPreviews() : null;
    if (galleryViewMode === 'folders') subfolders.forEach(folder => {
        const item = document.createElement('button');
        item.className = 'grid-item album-card';
        item.type = 'button';
        const albumFolder = currentFolder ? `${currentFolder}/${folder}` : folder;
        item.dataset.albumFolder = albumFolder;
        item.setAttribute('aria-label', `Open album ${folder}`);
        item.innerHTML = `
            <div class="album-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="54" height="54"><path fill="currentColor" d="M10 4H2c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h20c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-10l-2-2z"/></svg>
            </div>
            <div class="album-name">${escapeHtml(folder)}</div>
            <div class="album-subtitle">Open album</div>`;
        item.addEventListener('click', () => navigateToFolder(albumFolder));
        thumbnailGrid.appendChild(item);
        observeAlbum(item);
    });

    const observed = new Map();
    const updateThumbnail = (el, visible) => {
        const state = observed.get(el);
        if (!state) return;
        if (!visible) {
            if (state.heic) {
                el.resourceActive = false;
                el.cancelDeadline();
                clearMediaSource(el); state.controller?.abort(); state.controller = null;
                el.classList.remove('thumb-loaded');
            }
            return;
        }
        if (state.controller) return;
        el.resourceActive = true;
        const owner = new AbortController();
        state.controller = owner;
        if (state.heic) {
            getSpecialImageURL(state.file, owner.signal, 'thumbnail').then(url => {
                if (!owner.signal.aborted) { el.startDeadline(); el.src = url; }
            }).catch(error => { if (!owner.signal.aborted && error.name !== 'AbortError') el.onerror?.(); });
        } else {
            el.startDeadline(); el.src = state.file;
        }
    };
    if ('IntersectionObserver' in window) session.observer = new IntersectionObserver(entries => {
        if (session.controller.signal.aborted) return;
        entries.forEach(entry => updateThumbnail(entry.target, entry.isIntersecting));
    }, { root: gridViewContainer, rootMargin: '300px' });
    const observeImage = (el, file, heic = false) => {
        observed.set(el, { file, heic, controller: null });
        session.cleanups.push(() => { observed.get(el)?.controller?.abort(); });
        if (session.observer) session.observer.observe(el);
        else updateThumbnail(el, true);
    };

    mediaFiles.forEach((file, index) => {
        const filename = decodeURIComponent(file.split('/').pop());
        const item = document.createElement('button');
        item.className = 'grid-item';
        item.type = 'button';
        item.setAttribute('aria-label', `Open ${filename}`);
        if (returnPosition?.file === file) returnTile = item;

        if (isVideoFile(file)) {
            const vid = document.createElement('video');
            watchThumbnail(vid, item, true);
            vid.src = file;
            vid.preload = 'metadata';
            vid.disablePictureInPicture = true;
            vid.muted = true;
            vid.playsInline = true;
            item.appendChild(vid);
            const badge = document.createElement('div');
            badge.className = 'video-badge';
            badge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
            item.appendChild(badge);
        } else if (isHeicFile(file)) {
            const imgEl = document.createElement('img');
            watchThumbnail(imgEl, item);
            imgEl.alt = filename;
            imgEl.decoding = 'async';
            imgEl.dataset.heicSrc = file;
            imgEl.className = 'heic-thumb';
            observeImage(imgEl, file, true);
            item.appendChild(imgEl);
            const fallback = document.createElement('div');
            fallback.className = 'heic-fallback';
            fallback.textContent = 'HEIC';
            item.appendChild(fallback);
        } else {
            const imgEl = document.createElement('img');
            watchThumbnail(imgEl, item);
            observeImage(imgEl, file);
            imgEl.alt = filename;
            imgEl.loading = 'lazy';
            imgEl.decoding = 'async';
            item.appendChild(imgEl);
        }

        const caption = document.createElement('div');
        caption.className = 'grid-item-caption';
        if (galleryViewMode === 'all') {
            let relative = settingsApi.relativeMediaPath(activeSource, file);
            if (currentFolder) {
                const prefix = `${currentFolder}/`;
                if (relative.startsWith(prefix)) relative = relative.slice(prefix.length);
            }
            caption.textContent = relative;
        } else {
            caption.textContent = filename;
        }
        item.appendChild(caption);
        item.addEventListener('click', () => enterFullScreenViewer(index));
        thumbnailGrid.appendChild(item);
    });

    gridViewContainer.style.display = 'flex';
    if (returnPosition) {
        gridViewContainer.scrollTop = returnPosition.scrollTop;
        if (returnTile) {
            const tileRect = returnTile.getBoundingClientRect?.();
            const gridRect = gridViewContainer.getBoundingClientRect?.();
            if (tileRect && gridRect && (tileRect.top < gridRect.top || tileRect.bottom > gridRect.bottom)) {
                returnTile.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            }
            returnTile.focus?.({ preventScroll: true });
            returnTile.classList.add('returned-tile');
            setTimeout(() => returnTile.classList.remove('returned-tile'), 1800);
        }
        gridReturn = null;
    }
    viewport.style.display = 'none';
    $('overlay-header').style.display = 'none';
    navLeft.style.display = 'none';
    navRight.style.display = 'none';
    progressContainer.style.display = 'none';
    helpHint.style.display = 'none';
    video.pause();
    cancelSlideshowTimer();
    savePreferences();
}

function enterFullScreenViewer(index) {
    if (!mediaFiles.length) return;
    const openingViewer = isGridViewActive;
    if (openingViewer) stopGridSession();
    if (openingViewer && mediaFiles[index]) gridReturn = {
        folder: currentFolder, view: galleryViewMode,
        file: mediaFiles[index], scrollTop: gridViewContainer.scrollTop || 0
    };
    isGridViewActive = false;
    gridViewContainer.style.display = 'none';
    viewport.style.display = 'flex';
    $('overlay-header').style.display = 'flex';
    navLeft.style.display = 'flex';
    navRight.style.display = 'flex';
    progressContainer.style.display = 'block';
    helpHint.style.display = 'block';
    showMedia(index);
    if (openingViewer) showUI();
}

function showMedia(index) {
    if (!mediaFiles.length) return;
    stopViewerSession();
    const session = { controller: new AbortController(), timer: null, progress: 0 };
    viewerSession = session;
    const loadId = ++mediaLoadId;
    const isCurrent = () => loadId === mediaLoadId && !isGridViewActive && !session.controller.signal.aborted;
    const clearWatchdog = () => { clearTimeout(session.timer); session.timer = null; };
    const watch = () => {
        if (session.timer) return;
        session.timer = setTimeout(() => {
            if (isCurrent() && !mediaFailed) showMediaError('timeout', mediaFiles[currentIndex], resilience.timeoutError('Media loading stalled'));
        }, MEDIA_TIMEOUT);
    };
    mediaFailed = false;
    imageReady = false;
    cancelSlideshowTimer();
    currentIndex = (index + mediaFiles.length) % mediaFiles.length;
    const filepath = mediaFiles[currentIndex];
    const filename = decodeURIComponent(filepath.split('/').pop());
    const displayName = galleryViewMode === 'all'
        ? settingsApi.relativeMediaPath(activeSource, filepath)
        : filename;

    resetZoomAndPan();
    setMediaLoading(isHeicFile(filepath) ? 'Preparing HEIC image…' : isImageFile(filepath) ? 'Loading image…' : 'Loading video…');
    videoErrorOverlay.style.display = 'none';
    img.onload = null; img.onerror = null; img.style.display = 'none'; img.src = '';
    video.onended = null; video.ontimeupdate = null; video.onerror = null;
    video.onwaiting = null; video.onstalled = null; video.oncanplay = null; video.onplaying = null;
    video.style.display = 'none'; video.pause(); video.src = '';
    mediaTitle.textContent = displayName;
    img.alt = filename;
    mediaIndex.textContent = `${currentIndex + 1} / ${mediaFiles.length}`;

    if (isImageFile(filepath)) {
        if (!isHeicFile(filepath)) watch();
        img.classList.remove('mode-fit', 'mode-original');
        img.classList.add(imageMode === 'fit' ? 'mode-fit' : 'mode-original');
        container.classList.add('grab-mode');
        img.onload = () => {
            if (!isCurrent() || mediaFailed) return;
            clearWatchdog();
            imageReady = true;
            setMediaLoading();
            img.style.display = 'block'; mediaTitle.textContent = displayName;
            if (slideshowPlaying) startSlideshowTimer();
        };
        img.onerror = () => { if (isCurrent()) showMediaError('image', filepath); };

        if (isHeicFile(filepath)) {
            mediaTitle.textContent = `${displayName} (Preparing…)`;
            getSpecialImageURL(filepath, session.controller.signal)
                .then(url => { if (isCurrent()) { watch(); img.src = url; } })
                .catch(err => {
                    if (!isCurrent() || err.name === 'AbortError') return;
                    console.error('HEIC/HEIF image handling failed:', err);
                    if (isCurrent()) showMediaError('heic', filepath, err);
                });
        } else {
            img.src = filepath;
        }
    } else {
        container.classList.remove('grab-mode');
        watch();
        video.src = filepath;
        video.style.display = 'block';
        video.controls = controlsEnabled && !tvModeEnabled;
        video.muted = !controlsEnabled;
        video.onwaiting = video.onstalled = () => { if (isCurrent() && !mediaFailed && !video.paused) { setMediaLoading('Buffering video…'); watch(); } };
        video.onpause = clearWatchdog;
        video.oncanplay = video.onplaying = () => { if (isCurrent() && !mediaFailed) { clearWatchdog(); setMediaLoading(); } };
        video.onerror = () => {
            if (isCurrent()) showMediaError('video', filepath, video.error);
        };
        video.play().catch(err => {
            if (isCurrent() && !mediaFailed && err.name !== 'AbortError') showMediaError('video', filepath, err);
        });
        video.onended = () => { if (isCurrent() && slideshowPlaying) nextSlideshowMedia(); };
        video.ontimeupdate = () => {
            if (!isCurrent()) return;
            if (video.currentTime !== session.progress) { session.progress = video.currentTime; clearWatchdog(); if (!video.paused) watch(); }
            if (slideshowPlaying && video.duration) progressBar.style.width = `${(video.currentTime / video.duration) * 100}%`;
        };
        cancelSlideshowTimer();
        progressBar.style.width = '0%';
    }
    savePreferences();
}

function showMediaError(kind, filepath, error) {
    stopViewerSession();
    img.onload = null; img.onerror = null; img.src = '';
    video.onerror = null; video.onwaiting = null; video.onstalled = null;
    video.pause(); video.src = '';
    setMediaLoading();
    mediaFailed = true;
    cancelSlideshowTimer();
    progressBar.style.width = '0%';
    img.style.display = 'none';
    video.pause();
    video.style.display = 'none';
    let title = 'This image could not be opened';
    let message = 'The file may be unavailable, damaged, or in a format this browser cannot display.';
    let guidance = 'Retry after checking your connection, or open the original file to check it. Exporting a new JPEG or PNG copy may help.';
    if (kind === 'heic' || isHeicFile(filepath)) {
        title = 'This HEIC / HEIF image could not be opened';
        message = 'FolderFrame could not prepare this image for your browser. The file may use an unsupported HEIC variant or be damaged.';
        guidance = 'Try opening the original in your photo app and exporting a JPEG or PNG copy. Your original file is unchanged.';
        if (error?.message === 'HEIC decoder library did not load') {
            message = 'The HEIC decoder is unavailable.';
            guidance = 'Reload the page. If this continues, check that heic2any.min.js is hosted beside index.html and is not blocked.';
        } else if (/HTTP|fetch|network/i.test(error?.message || '')) {
            message = 'The image could not be downloaded.';
            guidance = 'Check your connection and that the file is still available, then retry.';
        }
    } else if (kind === 'video') {
        title = 'This video could not be played';
        message = 'The video format may be unsupported or the file may be unavailable.';
        guidance = 'Open the original in a video player to check it. For broader browser compatibility, export an MP4 copy using H.264 video and AAC audio.';
        if (error?.name === 'NotAllowedError') {
            title = 'Your browser paused video playback';
            message = 'Automatic playback was blocked. This does not mean the video is broken.';
            guidance = 'Choose Retry to start playback with a click. Embedded pages may also need permission to autoplay.';
        } else if (error?.code === 2) {
            message = 'The video download was interrupted by a network error.';
            guidance = 'Check your connection and that the file is still available, then retry.';
        } else if (error?.code === 1) {
            message = 'Video loading was interrupted.';
            guidance = 'Choose Retry to load the video again.';
        } else if (error?.code === 3) {
            message = 'The browser could not decode the video. Its codec may be unsupported, or the file may be damaged.';
        }
    }
    if (error?.name === 'TimeoutError') {
        title = 'Media took too long to load';
        message = error.message;
        guidance = 'Check your connection and retry. If HEIC processing remains stalled, reload the page. Other supported media can still play.';
    }
    $('media-error-title').textContent = title;
    $('media-error-filename').textContent = decodeURIComponent(filepath.split('/').pop());
    videoErrorText.textContent = message;
    videoErrorFfmpeg.textContent = guidance;
    $('media-error-original').href = filepath;
    $('btn-next-media-error').disabled = mediaFiles.length < 2;
    mediaTitle.textContent = decodeURIComponent(filepath.split('/').pop());
    videoErrorOverlay.style.display = 'flex';
    scheduleErrorAdvance();
    if (!slideshowPlaying) showUI();
}

function scheduleErrorAdvance() {
    cancelSlideshowTimer();
    $('media-error-status').textContent = slideshowPlaying
        ? (mediaFiles.length > 1 ? 'Slideshow continues: skipping this file in 3 seconds.' : 'Slideshow continues: retrying this file in 3 seconds.')
        : 'Choose Retry or another file. Press Play to continue the slideshow.';
    if (!slideshowPlaying || !mediaFailed || isGridViewActive) return;
    const loadId = mediaLoadId;
    slideshowTimer = setTimeout(() => {
        slideshowTimer = null;
        if (slideshowPlaying && mediaFailed && !isGridViewActive && loadId === mediaLoadId) nextSlideshowMedia();
    }, 3000);
}

function nextMedia() { showMedia(currentIndex + 1); }
function prevMedia() { showMedia(currentIndex - 1); }
function nextSlideshowMedia() {
    if (!shuffleEnabled || mediaFiles.length <= 1) return nextMedia();
    let next = currentIndex;
    while (next === currentIndex) next = Math.floor(Math.random() * mediaFiles.length);
    showMedia(next);
}

function applyTransform() {
    container.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const changed = zoom !== 1.0 || panX !== 0 || panY !== 0;
    btnResetZoom.disabled = !changed;
    container.classList.toggle('grabbing-mode', changed);
}
function resetZoomAndPan() { cancelTouchGesture(); zoom = 1.0; panX = 0; panY = 0; applyTransform(); }

function toggleImageMode() {
    imageMode = imageMode === 'fit' ? 'original' : 'fit';
    updateControlStates();
    if (isPhotoActive()) {
        img.classList.remove('mode-fit', 'mode-original');
        img.classList.add(imageMode === 'fit' ? 'mode-fit' : 'mode-original');
        resetZoomAndPan();
    }
    savePreferences();
}

function handleWheel(e) {
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;
    const prevZoom = zoom;
    const minZoom = imageMode === 'original' ? 0.1 : 1.0;
    zoom = Math.max(minZoom, Math.min(10.0, zoom * factor));
    if (zoom === 1.0 && imageMode !== 'original') { panX = 0; panY = 0; }
    else {
        panX = mouseX - (mouseX - panX) * (zoom / prevZoom);
        panY = mouseY - (mouseY - panY) * (zoom / prevZoom);
    }
    applyTransform();
}

function setupEventListeners() {
    $('btn-sort').addEventListener('click', cycleSort);
    $('btn-retry-scan').addEventListener('click', () => {
        if (failedNavigation !== null) { const target = failedNavigation; failedNavigation = null; return navigateToFolder(target); }
        return loadGallery({ forceCacheClear: true });
    });
    $('btn-gallery-home').addEventListener('click', () => navigateToFolder(''));
    $('select-source').addEventListener('change', event => {
        const url = new URL(location.href);
        url.searchParams.set('source', event.target.value);
        url.searchParams.set('album', '');
        // A new load prevents old scans, media callbacks, and timers leaking
        // into the next source. Other explicit URL options are preserved.
        location.assign(url.href);
    });
    btnShowGrid.addEventListener('click', renderGridView);
    btnRefreshGrid.addEventListener('click', () => loadGallery({ preserveView: true, forceCacheClear: true }));
    btnShuffle.addEventListener('click', () => { shuffleEnabled = !shuffleEnabled; updateControlStates(); savePreferences(); });
    btnAutoRefresh.addEventListener('click', () => { autoRefreshEnabled = !autoRefreshEnabled; updateControlStates(); startAutoRefreshTimer(); savePreferences(); });
    btnViewMode.addEventListener('click', async () => {
        scanSession?.abort();
        galleryViewMode = galleryViewMode === 'all' ? 'folders' : 'all';
        currentIndex = 0;
        stopSlideshow();
        updateControlStates();
        await loadGallery({ preserveView: false });
        savePreferences();
    });
    btnTvMode.addEventListener('click', toggleTvMode);
    navLeft.addEventListener('click', prevMedia);
    navRight.addEventListener('click', nextMedia);
    btnResetZoom.addEventListener('click', resetZoomAndPan);
    btnImageMode.addEventListener('click', toggleImageMode);
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    viewport.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewport.addEventListener('touchend', handleTouchEnd);
    viewport.addEventListener('touchcancel', cancelTouchGesture);
    $('overlay-header').addEventListener('focusin', showUI);
    $('overlay-header').addEventListener('focusout', resetIdleTimer);
    btnPlayPause.addEventListener('click', toggleSlideshow);
    selectInterval.addEventListener('change', e => {
        slideshowInterval = Number(e.target.value);
        if (slideshowPlaying && isPhotoActive()) startSlideshowTimer();
        savePreferences();
    });
    btnFullscreen.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    btnRetryWarning.addEventListener('click', () => loadGallery({ preserveView: false, forceCacheClear: true }));
    btnCloseVideoError.addEventListener('click', renderGridView);
    $('btn-retry-media-error').addEventListener('click', () => {
        removeCacheEntry(mediaFiles[currentIndex]);
        showMedia(currentIndex);
    });
    $('btn-next-media-error').addEventListener('click', nextMedia);

    window.addEventListener('keydown', e => {
        if (!controlsEnabled) return;
        if (isGridViewActive) return;
        if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.target?.isContentEditable || e.target?.closest?.('a, select, input, textarea, video, [contenteditable]:not([contenteditable="false"])')) return;
        const key = e.key.toLowerCase();
        if (!['arrowleft', 'arrowright', ' ', 'enter', 's', 'f', 't', 'g', 'escape'].includes(key)) return;
        // Viewer shortcuts own these keys even after a toolbar/arrow button is
        // clicked. Prevent native Space/Enter activation of the focused button.
        e.preventDefault();
        if (e.repeat && key !== 'arrowleft' && key !== 'arrowright') return;
        if (e.key === 'ArrowLeft') prevMedia();
        if (e.key === 'ArrowRight') nextMedia();
        if (e.key === ' ') { e.preventDefault(); toggleSlideshow(); }
        if (e.key === 'Enter') { e.preventDefault(); toggleImageMode(); }
        if (e.key.toLowerCase() === 's') { shuffleEnabled = !shuffleEnabled; updateControlStates(); savePreferences(); }
        if (e.key.toLowerCase() === 'f') toggleFullscreen();
        if (e.key.toLowerCase() === 't') toggleTvMode();
        if (e.key.toLowerCase() === 'g') renderGridView();
        if (e.key === 'Escape' && (zoom !== 1.0 || panX || panY)) resetZoomAndPan();
        resetIdleTimer();
    });

    window.addEventListener('mousemove', () => { if (!isGridViewActive) resetIdleTimer(); });
    window.addEventListener('click', () => { if (!isGridViewActive) resetIdleTimer(); });
    window.addEventListener('touchstart', () => { if (!isGridViewActive) resetIdleTimer(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && autoRefreshEnabled) loadGallery({ preserveView: true, silent: true }); });
}

function startAutoRefreshTimer() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
    if (!autoRefreshEnabled) return;
    autoRefreshTimer = setInterval(() => {
        if (!document.hidden) loadGallery({ preserveView: true, silent: true });
    }, refreshInterval * 1000);
}

async function toggleTvMode() {
    tvModeEnabled = !tvModeEnabled;
    video.controls = controlsEnabled && !tvModeEnabled;
    if (tvModeEnabled) {
        imageMode = 'fit';
        shuffleEnabled = true;
        autoRefreshEnabled = true;
        updateControlStates();
        startAutoRefreshTimer();
        if (mediaFiles.length && isGridViewActive) enterFullScreenViewer(currentIndex);
        if (!slideshowPlaying) setSlideshowPlaying(true);
        try {
            if (!document.fullscreenElement) await wrapper.requestFullscreen();
        } catch (err) {
            console.info('Fullscreen was not allowed by the browser:', err);
        }
    } else {
        // Leaving TV mode should return the browser to a normal windowed,
        // paused viewer state.
        setSlideshowPlaying(false);
        video.pause();
        progressBar.style.width = '0%';

        try {
            if (document.fullscreenElement) await document.exitFullscreen();
        } catch (err) {
            console.info('Could not exit fullscreen:', err);
        }

        updateControlStates();
        showUI();
    }
    savePreferences();
}

function handleMouseDown(e) {
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    if (zoom !== 1.0 || imageMode === 'original' || panX !== 0 || panY !== 0) {
        isDragging = true; startX = e.clientX; startY = e.clientY; startPanX = panX; startPanY = panY;
    }
}
function handleMouseMove(e) { if (isDragging) { panX = startPanX + e.clientX - startX; panY = startPanY + e.clientY - startY; applyTransform(); } }
function handleMouseUp() { isDragging = false; }

function handleTouchStart(e) {
    swipeStart = null;
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    if (e.target?.closest?.('button, a, select, input, video')) return;
    resetIdleTimer();
    if (e.touches.length === 2) {
        isPinching = true; isDragging = false;
        const [t1, t2] = e.touches;
        initialDist = Math.max(1, Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY));
        const midX = (t1.clientX + t2.clientX) / 2, midY = (t1.clientY + t2.clientY) / 2;
        // Measure in the stationary viewport, never the already-transformed image.
        const rect = viewport.getBoundingClientRect();
        initialMidX = midX - rect.left - rect.width / 2;
        initialMidY = midY - rect.top - rect.height / 2;
        initialZoom = zoom; initialPanX = panX; initialPanY = panY;
    } else if (e.touches.length === 1 && (zoom !== 1.0 || imageMode === 'original' || panX !== 0 || panY !== 0)) {
        isDragging = true; isPinching = false;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY; startPanX = panX; startPanY = panY;
    } else if (e.touches.length === 1 && imageMode === 'fit' && zoom === 1 && !panX && !panY) {
        swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, id: e.touches[0].identifier };
    }
}

function handleTouchMove(e) {
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    if (isPinching && e.touches.length === 2) {
        e.preventDefault();
        const [t1, t2] = e.touches;
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const factor = dist / initialDist;
        const minZoom = imageMode === 'original' ? 0.1 : 1.0;
        zoom = Math.max(minZoom, Math.min(10.0, initialZoom * factor));
        if (zoom === 1.0 && imageMode !== 'original') { panX = 0; panY = 0; }
        else {
            panX = initialMidX - (initialMidX - initialPanX) * (zoom / initialZoom);
            panY = initialMidY - (initialMidY - initialPanY) * (zoom / initialZoom);
            const midX = (t1.clientX + t2.clientX) / 2, midY = (t1.clientY + t2.clientY) / 2;
            const rect = viewport.getBoundingClientRect();
            panX += (midX - rect.left - rect.width / 2) - initialMidX;
            panY += (midY - rect.top - rect.height / 2) - initialMidY;
        }
        applyTransform();
    } else if (isDragging && e.touches.length === 1) {
        e.preventDefault();
        panX = startPanX + e.touches[0].clientX - startX;
        panY = startPanY + e.touches[0].clientY - startY;
        applyTransform();
    }
}
function cancelTouchGesture() { isDragging = false; isPinching = false; swipeStart = null; }
function handleTouchEnd(e) {
    if (e.touches.length === 0) {
        const start = swipeStart;
        const end = Array.from(e.changedTouches || []).find(touch => touch.identifier === start?.id);
        const eligible = controlsEnabled && !mediaFailed && !isGridViewActive && isPhotoActive() &&
            imageMode === 'fit' && zoom === 1 && !panX && !panY && !isPinching && !isDragging;
        cancelTouchGesture();
        if (start && end && eligible) {
            const dx = end.clientX - start.x, dy = end.clientY - start.y;
            if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (dx < 0) nextMedia(); else prevMedia();
                resetIdleTimer();
            }
        }
        return;
    }
    if (e.touches.length === 1 && isPinching) {
        isPinching = false;
        isDragging = true;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        startPanX = panX; startPanY = panY;
    }
}

function toggleSlideshow() { setSlideshowPlaying(!slideshowPlaying); }
function setSlideshowPlaying(value) {
    slideshowPlaying = Boolean(value);
    syncPlayButton();
    if (mediaFailed) {
        scheduleErrorAdvance();
        return;
    }
    if (slideshowPlaying) {
        if (!isPhotoActive()) video.play().catch(() => {});
        else startSlideshowTimer();
    } else stopSlideshow(false);
}
function stopSlideshow(updateButton = true) {
    slideshowPlaying = false;
    cancelSlideshowTimer();
    if (!isPhotoActive()) video.pause();
    progressBar.style.width = '0%';
    if (updateButton) syncPlayButton();
}

function cancelSlideshowTimer() {
    if (slideshowTimer) {
        clearTimeout(slideshowTimer);
        slideshowTimer = null;
    }
    if (slideshowAnimationFrame) {
        cancelAnimationFrame(slideshowAnimationFrame);
        slideshowAnimationFrame = null;
    }
}

function startSlideshowTimer() {
    if (mediaFailed) { scheduleErrorAdvance(); return; }
    cancelSlideshowTimer();
    if (!imageReady || mediaFailed || isGridViewActive) return;
    slideProgress = 0;
    progressBar.style.width = '0%';

    const duration = slideshowInterval * 1000;
    slideshowStartedAt = performance.now();

    const tick = (now) => {
        if (!slideshowPlaying || !isPhotoActive()) {
            slideshowAnimationFrame = null;
            return;
        }

        const elapsed = now - slideshowStartedAt;
        const percent = Math.min(100, (elapsed / duration) * 100);
        slideProgress = percent;
        progressBar.style.width = `${percent}%`;

        if (elapsed >= duration) {
            slideshowAnimationFrame = null;
            nextSlideshowMedia();
        } else {
            slideshowAnimationFrame = requestAnimationFrame(tick);
        }
    };

    slideshowAnimationFrame = requestAnimationFrame(tick);
}

function handleFullscreenChange() {
    updateFullscreenButton();
    if (!document.fullscreenElement && tvModeEnabled) {
        tvModeEnabled = false;
        stopSlideshow();
        video.pause();
        video.controls = controlsEnabled;
        updateControlStates();
        showUI();
        savePreferences();
    }
}

function updateFullscreenButton() {
    const label = btnFullscreen.querySelector('.button-label');
    const isFullscreen = Boolean(document.fullscreenElement);
    if (label) label.textContent = isFullscreen ? 'Exit Full' : 'Full';
    btnFullscreen.setAttribute('aria-pressed', String(isFullscreen));
    btnFullscreen.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
}

async function toggleFullscreen() {
    try {
        if (!document.fullscreenElement) await wrapper.requestFullscreen();
        else await document.exitFullscreen();
    } catch (err) {
        console.log('Fullscreen blocked:', err);
    }
}

function showUI() {
    if (!controlsEnabled) return;
    if (isGridViewActive) return;
    uiVisible = true;
    $('overlay-header').classList.remove('ui-hidden');
    progressContainer.classList.remove('ui-hidden');
    navLeft.classList.remove('ui-hidden'); navRight.classList.remove('ui-hidden');
    helpHint.classList.remove('ui-hidden');
    document.body.classList.remove('cursor-hidden');
    resetIdleTimer();
}
function hideUI() {
    if (isGridViewActive || isDragging || isPinching || mediaFailed) return;
    if (document.activeElement?.matches?.(':focus-visible') &&
        document.activeElement?.closest?.('#overlay-header, .nav-arrow')) return;
    uiVisible = false;
    $('overlay-header').classList.add('ui-hidden');
    progressContainer.classList.add('ui-hidden');
    navLeft.classList.add('ui-hidden'); navRight.classList.add('ui-hidden');
    helpHint.classList.add('ui-hidden');
    document.body.classList.add('cursor-hidden');
}
function resetIdleTimer() {
    if (!controlsEnabled) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (isGridViewActive) return;
    if (!uiVisible) {
        uiVisible = true;
        $('overlay-header').classList.remove('ui-hidden');
        progressContainer.classList.remove('ui-hidden');
        navLeft.classList.remove('ui-hidden'); navRight.classList.remove('ui-hidden');
        helpHint.classList.remove('ui-hidden');
        document.body.classList.remove('cursor-hidden');
    }
    idleTimer = setTimeout(hideUI, tvModeEnabled ? 1800 : 3000);
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}
