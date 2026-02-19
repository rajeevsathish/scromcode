/**
 * SCORM API Shim — injected into repaired SCORM content
 * Supports SCORM 1.2 (API) and SCORM 2004 (API_1484_11)
 * Persists CMI data in localStorage; posts status to parent window.
 * Console logs every SCORM event with full details.
 */
(function () {
    'use strict';

    // ── Storage key ──────────────────────────────────────────────────────────
    const STORAGE_KEY = 'scorm_cmi_' + (window.location.pathname.split('/')[2] || 'default');

    // ── Logger ───────────────────────────────────────────────────────────────
    const LOG_STYLES = {
        init: 'background:#4CAF50;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        finish: 'background:#9C27B0;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        get: 'background:#2196F3;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        set: 'background:#FF9800;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        commit: 'background:#00BCD4;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        error: 'background:#F44336;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        info: 'background:#607D8B;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
    };

    function log(type, event, details) {
        const style = LOG_STYLES[type] || LOG_STYLES.info;
        const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
        console.groupCollapsed(
            `%c SCORM %c ${event} %c ${timestamp}`,
            style,
            'background:#eee;color:#333;padding:2px 6px;border-radius:3px;font-weight:bold',
            'color:#999;font-size:0.85em'
        );
        if (details && Object.keys(details).length > 0) {
            console.table(details);
        }
        console.groupEnd();
    }

    function loadCMI() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY) || '{}';
            const data = JSON.parse(raw);
            const keys = Object.keys(data);
            if (keys.length > 0) {
                console.group(`%c💾 localStorage READ %c ${STORAGE_KEY} (${keys.length} keys)`,
                    'background:#2196F3;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
                    'color:#2196F3;font-weight:bold');
                keys.forEach(k => console.log(`  🔑 ${k}:`, data[k]));
                console.groupEnd();
            }
            return data;
        } catch (_) { return {}; }
    }
    function saveCMI(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            const keys = Object.keys(data);
            console.group(`%c💾 localStorage WRITE %c ${STORAGE_KEY} (${keys.length} keys)`,
                'background:#FF9800;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
                'color:#FF9800;font-weight:bold');
            keys.forEach(k => console.log(`  📝 ${k}:`, data[k]));
            console.groupEnd();
        } catch (_) { }
    }
    function postStatus(cmi) {
        try {
            window.parent.postMessage({
                type: 'scorm_status',
                completion: cmi['cmi.core.lesson_status'] || cmi['cmi.completion_status'] || 'not attempted',
                score: cmi['cmi.core.score.raw'] || cmi['cmi.score.raw'] || '',
                location: cmi['cmi.core.lesson_location'] || cmi['cmi.location'] || '',
                suspendDataLen: (cmi['cmi.suspend_data'] || '').length
            }, '*');
        } catch (_) { }
    }

    let cmiData = loadCMI();
    let initialized = false;
    let lastError = '0';
    let callCount = 0;

    // ── SCORM 1.2 API ────────────────────────────────────────────────────────
    const API = {
        LMSInitialize: function (param) {
            callCount++;
            initialized = true;
            lastError = '0';
            postStatus(cmiData);
            log('init', 'LMSInitialize', {
                call: callCount,
                param: param || '""',
                result: 'true',
                restoredKeys: Object.keys(cmiData).length,
                storageKey: STORAGE_KEY
            });
            return 'true';
        },

        LMSFinish: function (param) {
            callCount++;
            saveCMI(cmiData);
            postStatus(cmiData);
            initialized = false;
            log('finish', 'LMSFinish', {
                call: callCount,
                param: param || '""',
                result: 'true',
                savedKeys: Object.keys(cmiData).length,
                lessonStatus: cmiData['cmi.core.lesson_status'] || '—',
                score: cmiData['cmi.core.score.raw'] || '—',
                location: cmiData['cmi.core.lesson_location'] || '—'
            });
            return 'true';
        },

        LMSGetValue: function (element) {
            callCount++;
            lastError = '0';
            const value = cmiData[element] !== undefined ? String(cmiData[element]) : '';
            console.log(`%c🔍 LMSGetValue %c ${element} = %c${value || '(empty)'}`,
                'background:#2196F3;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold',
                'color:#333', 'color:#2196F3;font-weight:bold');
            log('get', 'LMSGetValue', {
                call: callCount,
                element,
                value: value || '(empty)',
                found: cmiData[element] !== undefined
            });
            return value;
        },

        LMSSetValue: function (element, value) {
            callCount++;
            const oldValue = cmiData[element];
            cmiData[element] = value;
            saveCMI(cmiData);
            postStatus(cmiData);
            lastError = '0';
            console.log(`%c✏️  LMSSetValue %c ${element} = %c${value}%c (was: ${oldValue !== undefined ? oldValue : '(not set)'})`,
                'background:#FF9800;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold',
                'color:#333', 'color:#FF9800;font-weight:bold', 'color:#999;font-size:.9em');
            log('set', 'LMSSetValue', {
                call: callCount,
                element,
                newValue: value,
                oldValue: oldValue !== undefined ? oldValue : '(not set)',
                result: 'true'
            });
            return 'true';
        },

        LMSCommit: function (param) {
            callCount++;
            saveCMI(cmiData);
            postStatus(cmiData);
            lastError = '0';
            log('commit', 'LMSCommit', {
                call: callCount,
                param: param || '""',
                result: 'true',
                committedKeys: Object.keys(cmiData).length,
                snapshot: {
                    lessonStatus: cmiData['cmi.core.lesson_status'] || '—',
                    score: cmiData['cmi.core.score.raw'] || '—',
                    location: cmiData['cmi.core.lesson_location'] || '—',
                    suspendDataLen: (cmiData['cmi.suspend_data'] || '').length + ' chars'
                }
            });
            return 'true';
        },

        LMSGetLastError: function () {
            callCount++;
            log('error', 'LMSGetLastError', { call: callCount, errorCode: lastError });
            return lastError;
        },

        LMSGetErrorString: function (code) {
            callCount++;
            const errors = { '0': 'No error', '101': 'General exception', '201': 'Invalid argument', '301': 'Not initialized' };
            const msg = errors[code] || 'Unknown error';
            log('error', 'LMSGetErrorString', { call: callCount, code, message: msg });
            return msg;
        },

        LMSGetDiagnostic: function (code) {
            callCount++;
            const diag = 'Diagnostic: ' + code;
            log('info', 'LMSGetDiagnostic', { call: callCount, code, diagnostic: diag });
            return diag;
        }
    };

    // ── SCORM 2004 API ───────────────────────────────────────────────────────
    const API_1484_11 = {
        Initialize: function (p) {
            log('init', 'API_1484_11.Initialize', { scormVersion: '2004', param: p || '""' });
            return API.LMSInitialize(p);
        },
        Terminate: function (p) {
            log('finish', 'API_1484_11.Terminate', { scormVersion: '2004', param: p || '""' });
            return API.LMSFinish(p);
        },
        GetValue: function (e) {
            console.log(`%c🔍 GetValue (2004) %c ${e}`,
                'background:#2196F3;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold', 'color:#333');
            log('get', 'API_1484_11.GetValue', { scormVersion: '2004', element: e });
            return API.LMSGetValue(e);
        },
        SetValue: function (e, v) {
            console.log(`%c✏️  SetValue (2004) %c ${e} = %c${v}`,
                'background:#FF9800;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold',
                'color:#333', 'color:#FF9800;font-weight:bold');
            log('set', 'API_1484_11.SetValue', { scormVersion: '2004', element: e, value: v });
            return API.LMSSetValue(e, v);
        },
        Commit: function (p) {
            log('commit', 'API_1484_11.Commit', { scormVersion: '2004', param: p || '""' });
            return API.LMSCommit(p);
        },
        GetLastError: function () { return API.LMSGetLastError(); },
        GetErrorString: function (c) { return API.LMSGetErrorString(c); },
        GetDiagnostic: function (c) { return API.LMSGetDiagnostic(c); }
    };

    // ── Expose on window ─────────────────────────────────────────────────────
    window.API = API;
    window.API_1484_11 = API_1484_11;

    try {
        if (window.parent && window.parent !== window) {
            if (!window.parent.API) window.parent.API = API;
            if (!window.parent.API_1484_11) window.parent.API_1484_11 = API_1484_11;
        }
    } catch (_) { }

    // ── localStorage snapshot dump ────────────────────────────────────────────
    // Called whenever user pauses, hides the tab, or navigates away.
    // Scans ALL localStorage keys — catches content that writes its own keys
    // (not just our scorm_cmi_* key) and when lmsPresent is false.
    function dumpLocalStorage(trigger) {
        const ts = new Date().toISOString();

        // Collect every key in localStorage
        const snapshot = {};
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                var raw = localStorage.getItem(k);
                // Try to parse as JSON so objects display nicely; else keep raw string
                try { snapshot[k] = JSON.parse(raw); } catch (_) { snapshot[k] = raw; }
            }
        } catch (e) { snapshot['__error__'] = e.message; }

        var count = Object.keys(snapshot).length;

        console.group(
            '%c📦 SCORM localStorage Snapshot%c  [' + trigger + ']  ' + ts + '  (' + count + ' key' + (count !== 1 ? 's' : '') + ')',
            'background:#673AB7;color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:1em',
            'color:#673AB7;font-weight:bold'
        );
        if (count === 0) {
            console.log('  (no data stored yet)');
        } else {
            console.log(JSON.parse(JSON.stringify(snapshot))); // plain JSON object
        }
        console.groupEnd();
    }

    // Dump when tab becomes hidden (user switches tabs or minimises)
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            dumpLocalStorage('tab hidden / pause');
        }
    });

    // Dump when window loses focus (user clicks away)
    window.addEventListener('blur', function () {
        dumpLocalStorage('window blur');
    });

    // Dump when page is about to unload (navigate away / close)
    window.addEventListener('beforeunload', function () {
        dumpLocalStorage('page unload / close');
    });

    // Auto-initialize if content doesn't call LMSInitialize
    window.addEventListener('load', function () {
        if (!initialized) {
            log('info', 'Auto-Initialize', { reason: 'content did not call LMSInitialize on load' });
            API.LMSInitialize('');
        }
    });

    console.log(
        '%c SCORM Shim %c Loaded — SCORM 1.2 API + API_1484_11 ready. Open DevTools to see all events.',
        'background:#4CAF50;color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:1.1em',
        'color:#4CAF50;font-weight:bold'
    );
    log('info', 'Shim Initialized', {
        storageKey: STORAGE_KEY,
        existingCMIKeys: Object.keys(cmiData).length,
        scorm12API: 'window.API',
        scorm2004API: 'window.API_1484_11'
    });
})();
