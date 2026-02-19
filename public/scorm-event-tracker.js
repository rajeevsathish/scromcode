/**
 * SCORM Event Tracker
 * Injected into every HTML file of a SCORM package.
 * Fires timestamped events for every user interaction and SCORM API call.
 * Events are sent to:
 *   1. window.parent via postMessage  (for the player shell to relay to server)
 *   2. console.log                    (for DevTools debugging)
 */
(function () {
    'use strict';

    // ── Session identity ──────────────────────────────────────────────────────
    // Passed in by the player shell via URL param ?sessionId=xxx, or fallback
    const urlParams = new URLSearchParams(window.location.search);
    const SESSION_ID = urlParams.get('sessionId') ||
        (window.__scormSessionId) ||
        'unknown';

    // ── Core emit function ────────────────────────────────────────────────────
    function emit(type, detail) {
        const event = {
            type: 'scorm_event',
            eventType: type,
            timestamp: new Date().toISOString(),
            sessionId: SESSION_ID,
            url: window.location.href,
            detail: detail || {}
        };
        // 1. Send to parent window (player shell)
        try { window.parent.postMessage(event, '*'); } catch (_) { }
        // 2. Console log
        console.log(`[SCORM-TRACKER] ${event.timestamp} | ${type}`, detail || '');
        // 3. POST to server log endpoint
        sendToServer(event);
    }

    // Send event to server — use sendBeacon for unload events, fetch for others
    function sendToServer(event) {
        const url = '/log-event';
        const body = JSON.stringify(event);
        if (event.eventType === 'page_unload' && navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        } else {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body,
                keepalive: true
            }).catch(function () { }); // silently ignore network errors
        }
    }

    // ── Page lifecycle ────────────────────────────────────────────────────────
    emit('page_load', { title: document.title, referrer: document.referrer });

    window.addEventListener('beforeunload', function () {
        emit('page_unload', { title: document.title });
    });

    document.addEventListener('visibilitychange', function () {
        emit('visibility_change', { hidden: document.hidden, state: document.visibilityState });
    });

    window.addEventListener('focus', function () { emit('window_focus', {}); });
    window.addEventListener('blur', function () { emit('window_blur', {}); });

    // ── User interactions ─────────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
        const target = e.target;
        emit('click', {
            tag: target.tagName,
            id: target.id || null,
            text: (target.innerText || target.value || '').slice(0, 100),
            x: e.clientX,
            y: e.clientY
        });
    }, true);

    document.addEventListener('keydown', function (e) {
        emit('keydown', {
            key: e.key,
            code: e.code,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            shiftKey: e.shiftKey
        });
    }, true);

    document.addEventListener('scroll', function () {
        emit('scroll', {
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            pageHeight: document.body ? document.body.scrollHeight : null
        });
    }, true);

    // ── SCORM API interception ────────────────────────────────────────────────
    // We wrap both SCORM 1.2 (API) and SCORM 2004 (API_1484_11) if present.
    // We wait for them to be available (they may be on window.parent).
    function wrapAPI(apiObj, apiName) {
        if (!apiObj || apiObj.__trackerWrapped) return;
        apiObj.__trackerWrapped = true;

        const methods = [
            'Initialize', 'Terminate', 'GetValue', 'SetValue',
            'Commit', 'GetLastError', 'GetErrorString', 'GetDiagnostic',
            // SCORM 1.2 names
            'LMSInitialize', 'LMSFinish', 'LMSGetValue', 'LMSSetValue',
            'LMSCommit', 'LMSGetLastError', 'LMSGetErrorString', 'LMSGetDiagnostic'
        ];

        methods.forEach(function (method) {
            if (typeof apiObj[method] !== 'function') return;
            const original = apiObj[method].bind(apiObj);
            apiObj[method] = function () {
                const args = Array.prototype.slice.call(arguments);
                const returnValue = original.apply(apiObj, args);
                emit('scorm_api_call', {
                    api: apiName,
                    method: method,
                    params: args,
                    returnValue: returnValue
                });
                return returnValue;
            };
        });
    }

    // Try to wrap immediately, then poll for late-arriving APIs
    function tryWrapAPIs() {
        // SCORM 1.2
        if (window.API) wrapAPI(window.API, 'SCORM_1.2 (window)');
        if (window.parent && window.parent.API) wrapAPI(window.parent.API, 'SCORM_1.2 (parent)');
        // SCORM 2004
        if (window.API_1484_11) wrapAPI(window.API_1484_11, 'SCORM_2004 (window)');
        if (window.parent && window.parent.API_1484_11) wrapAPI(window.parent.API_1484_11, 'SCORM_2004 (parent)');
    }

    tryWrapAPIs();

    // Poll every 500ms for up to 10s to catch APIs that load after us
    let pollCount = 0;
    const pollInterval = setInterval(function () {
        tryWrapAPIs();
        if (++pollCount >= 20) clearInterval(pollInterval);
    }, 500);

    // ── Media events (if any <video>/<audio> in the content) ─────────────────
    function attachMediaListeners(el) {
        ['play', 'pause', 'ended', 'seeked', 'timeupdate'].forEach(function (evt) {
            el.addEventListener(evt, function () {
                emit('media_' + evt, {
                    tag: el.tagName,
                    src: el.currentSrc || el.src || null,
                    currentTime: el.currentTime,
                    duration: el.duration
                });
            });
        });
    }

    document.querySelectorAll('video, audio').forEach(attachMediaListeners);

    // Watch for dynamically added media
    if (window.MutationObserver) {
        const observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
                        attachMediaListeners(node);
                    }
                });
            });
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    console.log('[SCORM-TRACKER] Initialized. Session:', SESSION_ID);
})();
