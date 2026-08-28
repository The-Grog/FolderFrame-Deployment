// Shared bounded asynchronous work. No server/runtime dependencies.
(function (root) {
    'use strict';
    const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const timeoutError = message => Object.assign(new Error(message), { name: 'TimeoutError' });

    // Deadline includes response body consumption; cancellation also rejects mocks/
    // servers that fail to honor the fetch signal. Late completions are ignored.
    async function request(url, { signal, timeout = 15000, body = 'text', ...options } = {}) {
        const controller = new AbortController();
        let timer, cancel;
        try {
            return await Promise.race([
                new Promise((_, reject) => {
                    cancel = () => { controller.abort(); reject(abortError()); };
                    signal?.addEventListener('abort', cancel, { once: true });
                    if (signal?.aborted) { cancel(); return; }
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(timeoutError('Request timed out: ' + url));
                    }, timeout);
                }),
                (async () => {
                    if (signal?.aborted) throw abortError();
                    const response = await fetch(url, { ...options, signal: controller.signal });
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return await response[body]();
                })()
            ]);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
        }
    }

    function createImagePool({ download, decode, thumbnail, createURL, revokeURL,
        warn = console.warn, concurrency = 2, decodeTimeout = 30000, grace = 250,
        limits = { viewer: [32, 64 * 1024 * 1024], thumbnail: [128, 16 * 1024 * 1024] } }) {
        const caches = { viewer: new Map(), thumbnail: new Map() };
        const jobs = new Map();
        let active = 0, clock = 0;
        const error = () => timeoutError('HEIC processing stalled. Reload the page to recover.');
        function evict(kind) {
            const cache = caches[kind], [count, bytes] = limits[kind];
            let total = [...cache.values()].reduce((sum, e) => sum + e.blob.size, 0);
            const candidates = [...cache].filter(([, e]) => !e.refs).sort((a, b) => a[1].used - b[1].used);
            for (const [key, e] of candidates) {
                if (!e.stale && cache.size <= count && total <= bytes) continue;
                cache.delete(key); total -= e.blob.size; revokeURL(e.url);
            }
        }
        function lease(entry, kind) {
            entry.refs++; entry.used = ++clock;
            let released = false;
            return { url: entry.url, release() {
                if (released) return;
                released = true; entry.refs--;
                if (entry.stale && !entry.refs && !entry.revoked) { entry.revoked = true; revokeURL(entry.url); }
                evict(kind);
            } };
        }
        function put(file, kind, blob) {
            let entry = caches[kind].get(file);
            if (!entry) {
                entry = { blob, url: createURL(blob), refs: 0, used: ++clock, stale: false };
                caches[kind].set(file, entry);
            }
            return entry;
        }
        function rejectConsumer(job, consumer, reason) {
            if (!job.consumers.delete(consumer)) return;
            consumer.signal?.removeEventListener('abort', consumer.cancel);
            consumer.reject(reason);
        }
        function rejectAll(job, reason) {
            for (const c of [...job.consumers]) rejectConsumer(job, c, reason);
        }
        function orphan(job) {
            if (job.consumers.size) return;
            if (job.state === 'queued') {
                job.graceTimer = setTimeout(() => {
                    if (!job.consumers.size && job.state === 'queued') {
                        jobs.delete(job.file); pump();
                    }
                }, grace);
            } else if (job.state === 'download') {
                job.controller.abort();
                // No decode started: a new request may safely create a new job.
                if (jobs.get(job.file) === job) jobs.delete(job.file);
            }
            // Running decoding is governed solely by its deadline, not consumer count.
        }
        function pump() {
            const running = [...jobs.values()].filter(j => j.state !== 'queued');
            if (active >= concurrency && running.length >= concurrency && running.every(j => j.timedOut)) {
                for (const job of [...jobs.values()]) if (job.state === 'queued') {
                    rejectAll(job, error()); clearTimeout(job.graceTimer); jobs.delete(job.file);
                }
                return;
            }
            while (active < concurrency) {
                const queue = [...jobs.values()].filter(j => j.state === 'queued' && j.consumers.size);
                queue.sort((a, b) =>
                    Number([...b.consumers].some(c => c.kind === 'viewer')) -
                    Number([...a.consumers].some(c => c.kind === 'viewer')));
                if (!queue.length) break;
                run(queue[0]);
            }
        }
        async function run(job) {
            active++; clearTimeout(job.graceTimer);
            job.state = 'download';
            let full, small, timer;
            try {
                // Reuse a full-resolution cache entry for viewer -> thumbnail.
                const cached = caches.viewer.get(job.file);
                let held;
                if (cached && !cached.stale) {
                    held = lease(cached, 'viewer');
                    full = cached.blob;
                    job.held = held;
                } else {
                    const data = await download(job.file, job.controller.signal);
                    if (!job.consumers.size || job.controller.signal.aborted) throw abortError();
                    job.state = 'decode';
                    timer = setTimeout(() => {
                        job.timedOut = true;
                        warn('FolderFrame: HEIC job exceeded its deadline; slot remains occupied until it settles.', job.file);
                        rejectAll(job, error()); pump();
                    }, decodeTimeout);
                    full = await decode(data);
                }
                job.state = 'decode';
                if (!timer) timer = setTimeout(() => {
                    job.timedOut = true; warn('FolderFrame: thumbnail processing stalled.', job.file);
                    rejectAll(job, error()); pump();
                }, decodeTimeout);
                while (job.consumers.size && !job.timedOut) {
                    if ([...job.consumers].some(c => c.kind === 'thumbnail') && !small) small = await thumbnail(full);
                    if (job.timedOut) break;
                    for (const c of [...job.consumers]) {
                        const blob = c.kind === 'viewer' ? full : small;
                        if (!blob) continue;
                        const entry = put(job.file, c.kind, blob);
                        job.consumers.delete(c);
                        c.signal?.removeEventListener('abort', c.cancel);
                        c.resolve(lease(entry, c.kind));
                    }
                }
            } catch (err) { rejectAll(job, err); }
            finally {
                clearTimeout(timer);
                job.held?.release();
                if (jobs.get(job.file) === job) jobs.delete(job.file);
                active--;
                evict('viewer'); evict('thumbnail'); pump();
            }
        }
        function acquire(file, kind = 'viewer', signal) {
            if (!caches[kind]) return Promise.reject(new Error('Unknown image variant'));
            if (signal?.aborted) return Promise.reject(abortError());
            const cached = caches[kind].get(file);
            if (cached && !cached.stale) return Promise.resolve(lease(cached, kind));
            let job = jobs.get(file);
            if (job?.timedOut) return Promise.reject(error());
            if (!job) {
                job = { file, state: 'queued', controller: new AbortController(), consumers: new Set(), timedOut: false };
                jobs.set(file, job);
            }
            clearTimeout(job.graceTimer);
            const promise = new Promise((resolve, reject) => {
                const c = { kind, signal, resolve, reject };
                c.cancel = () => { rejectConsumer(job, c, abortError()); orphan(job); };
                job.consumers.add(c);
                signal?.addEventListener('abort', c.cancel, { once: true });
            });
            pump();
            return promise;
        }
        function invalidate(file) {
            for (const kind of Object.keys(caches)) {
                for (const [key, entry] of caches[kind]) if (!file || key === file) {
                    entry.stale = true; caches[kind].delete(key);
                    if (!entry.refs) { entry.revoked = true; revokeURL(entry.url); }
                }
                evict(kind);
            }
        }
        return { acquire, invalidate, stats: () => ({ active, jobs: jobs.size,
            viewer: caches.viewer.size, thumbnail: caches.thumbnail.size }) };
    }
    const api = { request, createImagePool, abortError, timeoutError };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.FolderFrameResilience = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
