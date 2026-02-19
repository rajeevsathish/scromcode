const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = 3000;

// Configure multer for file upload
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 200 * 1024 * 1024 } // 200MB limit
});

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Serve player sessions
app.use('/play', express.static(path.join(__dirname, 'player_sessions')));

// ─── ANALYZE ────────────────────────────────────────────────────────────────

async function analyzeSCORM(zipPath) {
    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        const manifestEntry = zipEntries.find(entry =>
            entry.entryName.toLowerCase().endsWith('imsmanifest.xml')
        );

        if (!manifestEntry) {
            return { success: false, error: 'No imsmanifest.xml found in the package' };
        }

        const manifestContent = manifestEntry.getData().toString('utf8');
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(manifestContent);

        const analysis = {
            success: true,
            hasManifest: true,
            resumeCapable: false,
            details: [],
            metadata: {}
        };

        const manifest = result.manifest;
        let scormVersion = 'Unknown';

        if (manifest.metadata && manifest.metadata[0].schemaversion) {
            scormVersion = manifest.metadata[0].schemaversion[0];
            analysis.details.push(`📋 SCORM Version: ${scormVersion}`);
            analysis.metadata.version = scormVersion;
        }

        if (manifest.metadata && manifest.metadata[0].lom) {
            const lom = manifest.metadata[0].lom[0];
            if (lom.general && lom.general[0].title && lom.general[0].title[0].langstring) {
                const title = lom.general[0].title[0].langstring[0]._;
                if (title) {
                    analysis.details.push(`📚 Course: ${title}`);
                    analysis.metadata.title = title;
                }
            }
        }

        if (manifest.organizations && manifest.organizations[0].organization) {
            const orgs = manifest.organizations[0].organization;
            analysis.details.push(`📁 Found ${orgs.length} organization(s)`);
            orgs.forEach(org => {
                if (org.item) {
                    org.item.forEach(item => {
                        if (item.$ && item.$.identifierref) {
                            analysis.details.push(`📄 SCO: ${item.title ? item.title[0] : 'Untitled'}`);
                        }
                    });
                }
            });
        }

        if (manifest.resources && manifest.resources[0].resource) {
            const resources = manifest.resources[0].resource;
            const scoResources = resources.filter(res =>
                res.$ && res.$['adlcp:scormtype'] === 'sco'
            );

            if (scoResources.length > 0) {
                analysis.details.push(`📦 Found ${scoResources.length} SCO resource(s)`);
                analysis.resumeCapable = true;
                analysis.details.push('✅ Package contains SCO resources (supports data persistence)');
            }

            if (resources[0].$ && resources[0].$.href) {
                analysis.metadata.launchFile = resources[0].$.href;
            }
        }

        const jsFiles = zipEntries.filter(entry =>
            entry.entryName.toLowerCase().endsWith('.js')
        );

        let hasAPIReferences = false;
        let apiCallsFound = [];

        for (const jsFile of jsFiles.slice(0, 10)) {
            try {
                const content = jsFile.getData().toString('utf8');
                if (content.includes('cmi.core.lesson_status') || content.includes('cmi.completion_status')) {
                    apiCallsFound.push('lesson_status');
                }
                if (content.includes('cmi.suspend_data')) {
                    apiCallsFound.push('suspend_data');
                    hasAPIReferences = true;
                }
                if (content.includes('cmi.location')) {
                    apiCallsFound.push('location');
                    hasAPIReferences = true;
                }
                if (content.includes('API.LMSInitialize') || content.includes('API_1484_11.Initialize')) {
                    apiCallsFound.push('LMS_Initialize');
                }
            } catch (err) { /* skip encoding issues */ }
        }

        if (hasAPIReferences) {
            analysis.resumeCapable = true;
            const uniqueCalls = [...new Set(apiCallsFound)];
            analysis.details.push(`✅ Found SCORM API calls: ${uniqueCalls.join(', ')}`);
        }

        if (!analysis.resumeCapable) {
            analysis.details.push('⚠️ No clear resume capability indicators found');
            analysis.details.push('ℹ️ Package may still support resume if implemented at runtime');
        }

        return analysis;

    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ─── REPAIR ─────────────────────────────────────────────────────────────────

async function repairSCORM(zipPath, outputZipPath) {
    const repairs = [];
    const tmpDir = path.join(os.tmpdir(), 'scorm_repair_' + crypto.randomBytes(6).toString('hex'));

    try {
        // Extract zip
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(tmpDir, true);

        // ── Fix 1: Find / create imsmanifest.xml ──────────────────────────
        let manifestPath = findFile(tmpDir, 'imsmanifest.xml');
        let manifestXml;

        if (!manifestPath) {
            // Generate a minimal manifest
            manifestPath = path.join(tmpDir, 'imsmanifest.xml');
            const launchFile = findLaunchFile(tmpDir);
            manifestXml = buildMinimalManifest(launchFile || 'index.html');
            fs.writeFileSync(manifestPath, manifestXml, 'utf8');
            repairs.push('🆕 Created missing imsmanifest.xml');
        } else {
            manifestXml = fs.readFileSync(manifestPath, 'utf8');
        }

        // ── Fix 2: Parse & repair manifest XML ────────────────────────────
        let manifestObj;
        try {
            const parser = new xml2js.Parser({ explicitArray: true });
            manifestObj = await parser.parseStringPromise(manifestXml);
        } catch (xmlErr) {
            // XML is broken — rebuild from scratch
            const launchFile = findLaunchFile(tmpDir);
            manifestXml = buildMinimalManifest(launchFile || 'index.html');
            const parser = new xml2js.Parser({ explicitArray: true });
            manifestObj = await parser.parseStringPromise(manifestXml);
            repairs.push('🔧 Rebuilt corrupt imsmanifest.xml');
        }

        const manifest = manifestObj.manifest;

        // ── Fix 3: Ensure adlcp namespace on root ─────────────────────────
        if (!manifest.$) manifest.$ = {};
        const nsKey = 'xmlns:adlcp';
        if (!manifest.$[nsKey]) {
            manifest.$[nsKey] = 'http://www.adlnet.org/xsd/adlcp_rootv1p2';
            repairs.push('🔧 Added missing adlcp namespace');
        }

        // ── Fix 4: Ensure metadata / schema ──────────────────────────────
        if (!manifest.metadata) {
            manifest.metadata = [{ schema: ['ADL SCORM'], schemaversion: ['1.2'] }];
            repairs.push('🔧 Added missing metadata/schema block');
        }

        // ── Fix 5: Ensure resources & fix launch file ─────────────────────
        let launchFile = null;
        if (manifest.resources && manifest.resources[0].resource) {
            const resources = manifest.resources[0].resource;
            const primary = resources[0];

            if (primary.$) {
                // Ensure scormtype
                if (!primary.$['adlcp:scormtype']) {
                    primary.$['adlcp:scormtype'] = 'sco';
                    repairs.push('🔧 Set adlcp:scormtype="sco" on primary resource');
                }

                // Check launch file exists
                const declaredHref = primary.$.href;
                if (declaredHref) {
                    const fullLaunchPath = path.join(path.dirname(manifestPath), declaredHref);
                    if (!fs.existsSync(fullLaunchPath)) {
                        // Find a real HTML file to use instead
                        const found = findLaunchFile(tmpDir);
                        if (found) {
                            const rel = path.relative(path.dirname(manifestPath), found).replace(/\\/g, '/');
                            primary.$.href = rel;
                            repairs.push(`🔧 Fixed broken launch file → ${rel}`);
                            launchFile = rel;
                        }
                    } else {
                        launchFile = declaredHref;
                    }
                }
            }
        } else {
            // No resources at all — build one
            const found = findLaunchFile(tmpDir);
            const href = found
                ? path.relative(path.dirname(manifestPath), found).replace(/\\/g, '/')
                : 'index.html';
            launchFile = href;

            manifest.resources = [{
                resource: [{
                    $: {
                        identifier: 'resource_1',
                        type: 'webcontent',
                        'adlcp:scormtype': 'sco',
                        href: href
                    }
                }]
            }];
            repairs.push(`🆕 Created missing resources block (launch: ${href})`);
        }

        // ── Fix 6: Inject SCORM API shim into launch HTML ─────────────────
        if (launchFile) {
            const launchFullPath = path.join(path.dirname(manifestPath), launchFile);
            if (fs.existsSync(launchFullPath) && launchFullPath.match(/\.html?$/i)) {
                let html = fs.readFileSync(launchFullPath, 'utf8');
                if (!html.includes('scorm-api-shim.js')) {
                    // Inject shim as first script in <head> (or before </head>)
                    const shimTag = '<script src="/scorm-api-shim.js"></script>\n';
                    if (html.includes('<head>')) {
                        html = html.replace('<head>', '<head>\n' + shimTag);
                    } else if (html.includes('</head>')) {
                        html = html.replace('</head>', shimTag + '</head>');
                    } else {
                        html = shimTag + html;
                    }
                    fs.writeFileSync(launchFullPath, html, 'utf8');
                    repairs.push('💉 Injected SCORM API shim into launch HTML');
                }
            }
        }

        // ── Serialize repaired manifest ────────────────────────────────────
        const builder = new xml2js.Builder({
            xmldec: { version: '1.0', encoding: 'UTF-8' },
            renderOpts: { pretty: true, indent: '  ' }
        });
        const repairedXml = builder.buildObject(manifestObj);
        fs.writeFileSync(manifestPath, repairedXml, 'utf8');

        // ── Re-zip ────────────────────────────────────────────────────────
        const outZip = new AdmZip();
        addDirToZip(outZip, tmpDir, tmpDir);
        outZip.writeZip(outputZipPath);

        return { success: true, repairs, launchFile };

    } finally {
        // Clean up temp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function findFile(dir, filename) {
    const lower = filename.toLowerCase();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            const found = findFile(full, filename);
            if (found) return found;
        } else if (e.name.toLowerCase() === lower) {
            return full;
        }
    }
    return null;
}

const LAUNCH_CANDIDATES = [
    'index_lms.html', 'index_lms.htm',
    'story.html', 'story.htm',
    'index.html', 'index.htm',
    'launch.html', 'launch.htm',
    'default.html', 'default.htm'
];

function findLaunchFile(dir) {
    for (const candidate of LAUNCH_CANDIDATES) {
        const found = findFile(dir, candidate);
        if (found) return found;
    }
    // Fallback: first .html file found
    return findFirstHtml(dir);
}

function findFirstHtml(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            const found = findFirstHtml(full);
            if (found) return found;
        } else if (e.name.match(/\.html?$/i)) {
            return full;
        }
    }
    return null;
}

function addDirToZip(zip, baseDir, currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(currentDir, e.name);
        const zipPath = path.relative(baseDir, full).replace(/\\/g, '/');
        if (e.isDirectory()) {
            addDirToZip(zip, baseDir, full);
        } else {
            zip.addFile(zipPath, fs.readFileSync(full));
        }
    }
}

function buildMinimalManifest(launchFile) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="course_manifest" version="1"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org_1">
    <organization identifier="org_1">
      <title>Course</title>
      <item identifier="item_1" identifierref="resource_1">
        <title>Course</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="resource_1" type="webcontent" adlcp:scormtype="sco" href="${launchFile}">
      <file href="${launchFile}"/>
    </resource>
  </resources>
</manifest>`;
}

// ─── ENDPOINTS ──────────────────────────────────────────────────────────────

// Upload & analyze
app.post('/upload', upload.single('scormFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const analysis = await analyzeSCORM(req.file.path);

        // Create _updated.zip with event tracker injected
        let updatedFile = null;
        try {
            const origName = path.basename(req.file.originalname, '.zip') || 'scorm';
            updatedFile = await createUpdatedZip(req.file.path, origName);
        } catch (e) {
            console.warn('[TRACKER] Failed to create updated zip:', e.message);
        }

        fs.unlinkSync(req.file.path);
        res.json({ ...analysis, updatedFile });
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
});

// Upload, repair, return repaired zip + start player session
app.post('/repair', upload.single('scormFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const sessionId = crypto.randomBytes(8).toString('hex');
    const repairedDir = path.join(__dirname, 'repaired');
    fs.mkdirSync(repairedDir, { recursive: true });
    const origName = path.basename(req.file.originalname, '.zip') || 'scorm';
    const repairedZipPath = path.join(repairedDir, `${origName}_repaired.zip`);

    try {
        const result = await repairSCORM(req.file.path, repairedZipPath);
        fs.unlinkSync(req.file.path);

        if (!result.success) {
            return res.status(500).json({ error: result.error });
        }

        // Extract repaired zip into player session directory
        const sessionDir = path.join(__dirname, 'player_sessions', sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        const repZip = new AdmZip(repairedZipPath);
        repZip.extractAllTo(sessionDir, true);
        // Keep repaired zip in repaired/ — do NOT delete

        // Inject shim into all HTML files in session dir (belt-and-suspenders)
        injectShimIntoSession(sessionDir);

        res.json({
            success: true,
            sessionId,
            launchFile: result.launchFile || 'index.html',
            repairs: result.repairs,
            repairedFile: path.basename(repairedZipPath),
            playerUrl: `/play/${sessionId}/${result.launchFile || 'index.html'}`
        });

    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
});

// Download repaired zip directly
app.post('/repair-download', upload.single('scormFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const repairedDir = path.join(__dirname, 'repaired');
    fs.mkdirSync(repairedDir, { recursive: true });
    const origName = path.basename(req.file.originalname, '.zip') || 'scorm';
    const repairedZipPath = path.join(repairedDir, `${origName}_repaired.zip`);

    try {
        const result = await repairSCORM(req.file.path, repairedZipPath);
        fs.unlinkSync(req.file.path);

        if (!result.success) return res.status(500).json({ error: result.error });

        // Send the file as download — keep the copy in repaired/
        res.download(repairedZipPath, `${origName}_repaired.zip`);

    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
});

// Batch repair a folder
app.post('/repair-folder', async (req, res) => {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'No folder path provided' });
    if (!fs.existsSync(folderPath)) return res.status(400).json({ error: 'Folder does not exist' });
    if (!fs.statSync(folderPath).isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });

    // Exclude any previously repaired zips sitting in the folder
    const zipFiles = fs.readdirSync(folderPath)
        .filter(f => f.toLowerCase().endsWith('.zip') && !f.toLowerCase().endsWith('_repaired.zip'));
    if (zipFiles.length === 0) return res.status(400).json({ error: 'No ZIP files found' });

    const results = [];
    for (const zipFile of zipFiles) {
        const zipPath = path.join(folderPath, zipFile);
        const sessionId = crypto.randomBytes(8).toString('hex');
        // Save repaired zip into project repaired/ folder
        const repairedDir = path.join(__dirname, 'repaired');
        fs.mkdirSync(repairedDir, { recursive: true });
        const origName = path.basename(zipFile, '.zip');
        const repairedZipPath = path.join(repairedDir, `${origName}_repaired.zip`);
        try {
            const result = await repairSCORM(zipPath, repairedZipPath);

            // Also create player session
            if (result.success) {
                const sessionDir = path.join(__dirname, 'player_sessions', sessionId);
                fs.mkdirSync(sessionDir, { recursive: true });
                const repZip = new AdmZip(repairedZipPath);
                repZip.extractAllTo(sessionDir, true);
                injectShimIntoSession(sessionDir);
                // Keep repaired zip in repaired/ — do NOT delete
            }

            results.push({
                filename: zipFile,
                ...result,
                sessionId: result.success ? sessionId : null,
                playerUrl: result.success ? `/play/${sessionId}/${result.launchFile || 'index.html'}` : null,
                repairedFile: result.success ? path.basename(repairedZipPath) : null
            });
        } catch (err) {
            results.push({ filename: zipFile, success: false, error: err.message });
        }
    }

    res.json({ success: true, folderPath, results });
});

// Repair a single file by path (used by batch analysis "Repair & Play" per-card button)
app.post('/repair-batch-file', async (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'No file path provided' });
    if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'File does not exist: ' + filePath });
    if (!filePath.toLowerCase().endsWith('.zip')) return res.status(400).json({ error: 'File must be a ZIP' });

    const sessionId = crypto.randomBytes(8).toString('hex');
    const repairedDir = path.join(__dirname, 'repaired');
    fs.mkdirSync(repairedDir, { recursive: true });
    const origName = path.basename(filePath, '.zip');
    const repairedZipPath = path.join(repairedDir, `${origName}_repaired.zip`);

    try {
        const result = await repairSCORM(filePath, repairedZipPath);
        if (!result.success) return res.status(500).json({ error: result.error });

        const sessionDir = path.join(__dirname, 'player_sessions', sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        const repZip = new AdmZip(repairedZipPath);
        repZip.extractAllTo(sessionDir, true);
        // Keep repaired zip in repaired/ — do NOT delete
        injectShimIntoSession(sessionDir);

        res.json({
            success: true,
            sessionId,
            launchFile: result.launchFile || 'index.html',
            repairs: result.repairs,
            repairedFile: path.basename(repairedZipPath),
            playerUrl: `/play/${sessionId}/${result.launchFile || 'index.html'}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Analyze folder (original)
app.post('/analyze-folder', async (req, res) => {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'No folder path provided' });
    if (!fs.existsSync(folderPath)) return res.status(400).json({ error: 'Folder path does not exist' });
    if (!fs.statSync(folderPath).isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });

    const files = fs.readdirSync(folderPath);
    // Exclude any _repaired.zip files left over from previous repair runs
    const zipFiles = files.filter(file =>
        file.toLowerCase().endsWith('.zip') && !file.toLowerCase().endsWith('_repaired.zip')
    );
    if (zipFiles.length === 0) return res.status(400).json({ error: 'No ZIP files found in the folder' });

    const results = [];
    let successCount = 0, resumeCapableCount = 0, failedCount = 0;

    for (const zipFile of zipFiles) {
        const zipPath = path.join(folderPath, zipFile);
        try {
            const analysis = await analyzeSCORM(zipPath);

            // Create _updated.zip with event tracker injected
            let updatedFile = null;
            try {
                const origName = path.basename(zipFile, '.zip');
                updatedFile = await createUpdatedZip(zipPath, origName);
            } catch (e) {
                console.warn('[TRACKER] Failed to create updated zip for', zipFile, e.message);
            }

            results.push({ filename: zipFile, path: zipPath, size: fs.statSync(zipPath).size, ...analysis, updatedFile });
            if (analysis.success) {
                successCount++;
                if (analysis.resumeCapable) resumeCapableCount++;
            } else {
                failedCount++;
            }
        } catch (error) {
            results.push({ filename: zipFile, path: zipPath, success: false, error: error.message });
            failedCount++;
        }
    }

    res.json({
        success: true,
        summary: { totalFiles: zipFiles.length, successfullyAnalyzed: successCount, resumeCapable: resumeCapableCount, failed: failedCount, folderPath },
        results
    });
});

// Receive and log SCORM events from the tracker script
app.post('/log-event', (req, res) => {
    const event = req.body;
    if (!event || !event.eventType) return res.status(400).json({ error: 'Invalid event' });

    const sessionId = event.sessionId || 'unknown';
    const logDir = path.join(__dirname, 'event_logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${sessionId}.ndjson`);

    // Append as newline-delimited JSON
    const line = JSON.stringify({
        ...event,
        serverTimestamp: new Date().toISOString()
    }) + '\n';

    try {
        fs.appendFileSync(logFile, line, 'utf8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Download an _updated.zip file by filename
app.get('/download-updated/:filename', (req, res) => {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(__dirname, 'updated', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath, filename);
});

// Delete player session
app.delete('/play-session/:sessionId', (req, res) => {
    const sessionDir = path.join(__dirname, 'player_sessions', req.params.sessionId);
    try {
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── SHIM INJECTION HELPER ───────────────────────────────────────────────────

function injectShimIntoSession(sessionDir) {
    injectShimIntoDir(sessionDir, sessionDir);
}

function injectShimIntoDir(sessionDir, dir) {
    // Read the shim source once and inline it into each HTML file
    const shimSrc = fs.readFileSync(path.join(__dirname, 'public', 'scorm-api-shim.js'), 'utf8');
    const shimBlock = `<script>\n/* === SCORM API Shim (inlined) === */\n${shimSrc}\n</script>\n`;

    function walk(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(currentDir, e.name);
            if (e.isDirectory()) {
                walk(full);
            } else if (e.name.match(/\.html?$/i)) {
                try {
                    let html = fs.readFileSync(full, 'utf8');
                    // Guard: skip if shim already inlined
                    if (html.includes('SCORM API Shim (inlined)')) continue;
                    if (html.includes('<head>')) {
                        html = html.replace('<head>', '<head>\n' + shimBlock);
                    } else if (html.includes('</head>')) {
                        html = html.replace('</head>', shimBlock + '</head>');
                    } else {
                        html = shimBlock + html;
                    }
                    fs.writeFileSync(full, html, 'utf8');
                } catch (_) { }
            }
        }
    }
    walk(dir);
}

// ─── EVENT TRACKER INJECTION HELPER ─────────────────────────────────────────

// Inline scorm-event-tracker.js into every HTML file in a directory tree
function injectTrackerIntoDir(baseDir, dir) {
    const trackerSrc = fs.readFileSync(path.join(__dirname, 'public', 'scorm-event-tracker.js'), 'utf8');
    const trackerBlock = `<script>\n/* === SCORM Event Tracker (inlined) === */\n${trackerSrc}\n</script>\n`;

    function walk(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(currentDir, e.name);
            if (e.isDirectory()) {
                walk(full);
            } else if (e.name.match(/\.html?$/i)) {
                try {
                    let html = fs.readFileSync(full, 'utf8');
                    // Guard: skip if tracker already inlined
                    if (html.includes('SCORM Event Tracker (inlined)')) continue;
                    if (html.includes('<head>')) {
                        html = html.replace('<head>', '<head>\n' + trackerBlock);
                    } else if (html.includes('</head>')) {
                        html = html.replace('</head>', trackerBlock + '</head>');
                    } else {
                        html = trackerBlock + html;
                    }
                    fs.writeFileSync(full, html, 'utf8');
                } catch (_) { }
            }
        }
    }
    walk(dir);
}

// Extract zip, inject shim + tracker inline into all HTML files, re-zip as <origName>_updated.zip
async function createUpdatedZip(zipPath, origName) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorm_updated_'));
    try {
        // Extract
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(tmpDir, true);

        // Inline shim first, then tracker into all HTML files
        injectShimIntoDir(tmpDir, tmpDir);
        injectTrackerIntoDir(tmpDir, tmpDir);

        // Re-zip
        const updatedDir = path.join(__dirname, 'updated');
        fs.mkdirSync(updatedDir, { recursive: true });
        const outPath = path.join(updatedDir, `${origName}_updated.zip`);
        const outZip = new AdmZip();
        addDirToZip(outZip, tmpDir, tmpDir);
        outZip.writeZip(outPath);

        return path.basename(outPath);
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }
}

// ─── INIT ────────────────────────────────────────────────────────────────────

['uploads', 'player_sessions', 'repaired', 'updated', 'event_logs'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

app.listen(PORT, () => {
    console.log(`SCORM Analyzer running at http://localhost:${PORT}`);
});
