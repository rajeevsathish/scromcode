// ─── DOM refs ────────────────────────────────────────────────────────────────
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const resultsSection = document.getElementById('resultsSection');
const resultCard = document.getElementById('resultCard');
const folderSection = document.getElementById('folderSection');

// ─── Current repair session (persisted across modal open/close) ───────────────
let currentSessionId = null;
let currentLaunchFile = null;

// ─── Drag & drop ─────────────────────────────────────────────────────────────
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

// ─── Single file upload & analyze ────────────────────────────────────────────
let currentFile = null;

async function handleFile(file) {
    if (!file.name.endsWith('.zip')) { alert('Please upload a ZIP file'); return; }
    currentFile = file;
    showProgress('Analyzing SCORM package...');

    const formData = new FormData();
    formData.append('scormFile', file);

    try {
        const response = await fetch('/upload', { method: 'POST', body: formData });
        const result = await response.json();
        displayResults(result);
    } catch (error) {
        displayResults({ success: false, error: 'Failed to analyze file: ' + error.message });
    }
}

// ─── Display single-file results ─────────────────────────────────────────────
function displayResults(result) {
    hideProgress();
    resultsSection.style.display = 'block';

    // Store updatedFile for download button
    window.currentUpdatedFile = result.updatedFile || null;

    let html = '';
    if (result.success) {
        const isGood = result.resumeCapable;
        const statusClass = isGood ? 'success' : 'warning';
        const statusText = isGood ? '✓ Resume Capable' : '⚠ Resume Not Detected';
        const primaryBtn = isGood
            ? `<button class="play-btn" onclick="repairPackage(true)">▶ Play in Browser</button>`
            : `<button class="repair-btn" onclick="repairPackage(true)">🔧 Repair &amp; Play</button>`;
        const updatedBtn = result.updatedFile
            ? `<button class="updated-download-btn" onclick="downloadUpdated()">📦 Download Updated</button>`
            : '';
        html = `
            <div class="status-badge ${statusClass}">${statusText}</div>
            <h3 style="margin-bottom:1rem;color:#333">Analysis Details</h3>
            <ul class="details-list">
                ${result.details.map(d => `<li>${d}</li>`).join('')}
            </ul>
            <div class="repair-actions" style="margin-top:1.2rem;display:flex;gap:.8rem;flex-wrap:wrap">
                ${primaryBtn}
                <button class="repair-download-btn" onclick="repairAndDownload()">📥 Repair &amp; Download</button>
                ${updatedBtn}
            </div>
            <div id="repairStatus"></div>
        `;
    } else {
        html = `
            <div class="status-badge error">✗ Analysis Failed</div>
            <div class="error-message">${result.error}</div>
            <div class="repair-actions" style="margin-top:1.2rem;display:flex;gap:.8rem;flex-wrap:wrap">
                <button class="repair-btn" onclick="repairPackage(true)">🔧 Repair &amp; Play</button>
                <button class="repair-download-btn" onclick="repairAndDownload()">📥 Repair &amp; Download</button>
            </div>
            <div id="repairStatus"></div>
        `;
    }

    html += `<div class="upload-another"><button onclick="resetUpload()">Analyze Another Package</button></div>`;
    resultCard.innerHTML = html;
}

// Download the _updated.zip for the current single-file analysis
function downloadUpdated() {
    if (!window.currentUpdatedFile) { alert('No updated file available.'); return; }
    const a = document.createElement('a');
    a.href = `/download-updated/${encodeURIComponent(window.currentUpdatedFile)}`;
    a.download = window.currentUpdatedFile;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Download the _updated.zip for a specific batch result
function downloadBatchUpdated(index) {
    const data = window.batchAnalysisResults;
    if (!data || !data.results || !data.results[index]) return;
    const updatedFile = data.results[index].updatedFile;
    if (!updatedFile) { alert('No updated file for this entry.'); return; }
    const a = document.createElement('a');
    a.href = `/download-updated/${encodeURIComponent(updatedFile)}`;
    a.download = updatedFile;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ─── Repair & Play (single file) ─────────────────────────────────────────────
// Called for both "good" files (play directly) and "bad" files (repair first)
async function repairPackage(autoPlay = true) {
    if (!currentFile) { alert('No file loaded. Please upload a SCORM zip first.'); return; }

    // Find or create the status div
    let statusDiv = document.getElementById('repairStatus');
    if (!statusDiv) {
        // Insert one below the action buttons if it doesn't exist yet
        statusDiv = document.createElement('div');
        statusDiv.id = 'repairStatus';
        resultCard.appendChild(statusDiv);
    }
    statusDiv.innerHTML = '<div class="repair-loading"><div class="mini-spinner"></div> Preparing…</div>';

    const formData = new FormData();
    formData.append('scormFile', currentFile);

    try {
        const response = await fetch('/repair', { method: 'POST', body: formData });
        const result = await response.json();

        if (result.success) {
            currentSessionId = result.sessionId;
            currentLaunchFile = result.launchFile || 'index.html';

            const repairList = result.repairs.length
                ? result.repairs.map(r => `<li>${r}</li>`).join('')
                : '<li>✅ Package is valid — no repairs needed</li>';

            statusDiv.innerHTML = `
                <div class="repair-result">
                    <h4>✅ Ready to Play</h4>
                    <ul class="repair-list">${repairList}</ul>
                </div>
            `;
            // Auto-open the player immediately
            if (autoPlay) openCurrentPlayer();
        } else {
            statusDiv.innerHTML = `<div class="repair-error">❌ Failed: ${result.error}</div>`;
        }
    } catch (error) {
        statusDiv.innerHTML = `<div class="repair-error">❌ ${error.message}</div>`;
    }
}

// ─── Repair & Download ────────────────────────────────────────────────────────
async function repairAndDownload() {
    if (!currentFile) { alert('No file loaded.'); return; }
    const statusDiv = document.getElementById('repairStatus');
    statusDiv.innerHTML = '<div class="repair-loading"><div class="mini-spinner"></div> Repairing &amp; packaging…</div>';

    const formData = new FormData();
    formData.append('scormFile', currentFile);

    try {
        const response = await fetch('/repair-download', { method: 'POST', body: formData });
        if (!response.ok) {
            const err = await response.json();
            statusDiv.innerHTML = `<div class="repair-error">❌ ${err.error}</div>`;
            return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = currentFile.name.replace(/\.zip$/i, '') + '_repaired.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        statusDiv.innerHTML = `<div class="repair-result"><h4>✅ Repaired zip downloaded!</h4></div>`;
    } catch (error) {
        statusDiv.innerHTML = `<div class="repair-error">❌ ${error.message}</div>`;
    }
}

// ─── iFrame Player ────────────────────────────────────────────────────────────

// Open player using the globally stored current session
function openCurrentPlayer() {
    if (!currentSessionId) { alert('No repaired session available. Please repair the package first.'); return; }
    openPlayer(currentSessionId, currentLaunchFile);
}

// Open player for a specific batch result by index
function openBatchPlayer(index) {
    const data = window.batchAnalysisResults;
    if (!data || !data.results || !data.results[index]) {
        alert('Session not found. Please repair the folder again.');
        return;
    }
    const result = data.results[index];
    if (!result.sessionId) {
        alert('No player session available for this file.');
        return;
    }
    openPlayer(result.sessionId, result.launchFile || 'index.html');
}

function openPlayer(sessionId, launchFile) {
    // Always update the current session tracking
    currentSessionId = sessionId;
    currentLaunchFile = launchFile;

    const modal = document.getElementById('playerModal');
    const frame = document.getElementById('scormFrame');
    const targetPath = `/play/${sessionId}/${launchFile}`;

    // Compare by pathname to avoid absolute vs relative URL mismatch
    const currentPath = frame.src ? new URL(frame.src, window.location.href).pathname : '';
    if (currentPath !== targetPath) {
        frame.src = targetPath;
    }
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closePlayer() {
    const modal = document.getElementById('playerModal');
    const frame = document.getElementById('scormFrame');
    // Don't blank the iframe src — keep session alive for replays
    // Just hide the modal
    modal.style.display = 'none';
    document.body.style.overflow = '';
    // Session is cleaned up only on resetUpload() / new file upload
}

// Repair a single file from batch analysis results and play it
async function repairBatchFile(index) {
    const data = window.batchAnalysisResults;
    if (!data || !data.results || !data.results[index]) return;
    const result = data.results[index];

    const statusEl = document.getElementById(`batch-status-${index}`);
    const btn = document.querySelector(`#batch-item-${index} .play-btn-sm, #batch-item-${index} .repair-btn-sm`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Working…'; }
    if (statusEl) statusEl.innerHTML = '<div class="repair-loading"><div class="mini-spinner"></div> Repairing…</div>';

    try {
        const response = await fetch('/repair-batch-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: result.path })
        });
        const repairResult = await response.json();

        if (repairResult.success) {
            // Store session and update the result entry so replay works
            data.results[index].sessionId = repairResult.sessionId;
            data.results[index].launchFile = repairResult.launchFile;

            if (statusEl) statusEl.innerHTML = `<div class="repair-result" style="margin-top:.5rem"><small>✅ ${repairResult.repairs.length} repair(s) applied</small></div>`;
            if (btn) { btn.disabled = false; btn.textContent = '▶ Play'; btn.className = 'play-btn-sm'; btn.onclick = () => openBatchPlayer(index); }

            // Auto-open player
            openBatchPlayer(index);
        } else {
            if (statusEl) statusEl.innerHTML = `<div class="repair-error" style="margin-top:.5rem"><small>❌ ${repairResult.error}</small></div>`;
            if (btn) { btn.disabled = false; btn.textContent = '🔧 Retry'; }
        }
    } catch (err) {
        if (statusEl) statusEl.innerHTML = `<div class="repair-error" style="margin-top:.5rem"><small>❌ ${err.message}</small></div>`;
        if (btn) { btn.disabled = false; btn.textContent = '🔧 Retry'; }
    }
}

// Listen for CMI status messages from the shim
window.addEventListener('message', e => {
    if (!e.data || e.data.type !== 'scorm_status') return;
    const { completion, score, location, suspendDataLen } = e.data;

    const compEl = document.getElementById('statusCompletion');
    const scoreEl = document.getElementById('statusScore');
    const locEl = document.getElementById('statusLocation');
    const susEl = document.getElementById('statusSuspend');

    if (compEl) {
        const icons = { passed: '✅', failed: '❌', completed: '✅', incomplete: '🔄', 'not attempted': '⏳', browsed: '👁' };
        compEl.textContent = (icons[completion] || '⏳') + ' ' + (completion || 'not attempted');
        compEl.className = 'status-pill ' + (completion === 'passed' || completion === 'completed' ? 'pill-success' : '');
    }
    if (scoreEl) scoreEl.textContent = `🎯 Score: ${score || '—'}`;
    if (locEl) locEl.textContent = `📍 Location: ${location || '—'}`;
    if (susEl) susEl.textContent = `💾 Suspend: ${suspendDataLen} chars`;
});

// ─── Folder analysis ──────────────────────────────────────────────────────────
async function analyzeFolderPath() {
    const folderPath = document.getElementById('folderPath').value.trim();
    if (!folderPath) { alert('Please enter a folder path'); return; }

    showProgress('Analyzing folder…');
    uploadArea.style.display = 'none';
    folderSection.style.display = 'none';

    try {
        const response = await fetch('/analyze-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const result = await response.json();
        if (result.success) {
            displayBatchResults(result);
        } else {
            alert('Error: ' + (result.error || 'Failed to analyze folder'));
            resetFolderAnalysis();
        }
    } catch (error) {
        alert('Failed: ' + error.message);
        resetFolderAnalysis();
    }
}

// ─── Folder repair ────────────────────────────────────────────────────────────
async function repairFolderPath() {
    const folderPath = document.getElementById('folderPath').value.trim();
    if (!folderPath) { alert('Please enter a folder path'); return; }

    showProgress('Repairing all SCORM packages in folder…');
    uploadArea.style.display = 'none';
    folderSection.style.display = 'none';

    try {
        const response = await fetch('/repair-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const result = await response.json();
        if (result.success) {
            displayBatchRepairResults(result);
        } else {
            alert('Error: ' + (result.error || 'Failed to repair folder'));
            resetFolderAnalysis();
        }
    } catch (error) {
        alert('Failed: ' + error.message);
        resetFolderAnalysis();
    }
}

// ─── Batch analysis results ───────────────────────────────────────────────────
function displayBatchResults(data) {
    hideProgress();
    document.getElementById('batchResultsSection').style.display = 'block';
    const { summary, results } = data;

    document.getElementById('summaryCard').innerHTML = buildSummaryHTML(summary, results) + buildExportButtons();
    document.getElementById('batchResults').innerHTML = buildResultsGrid(results, false);
    window.batchAnalysisResults = data;
}

function displayBatchRepairResults(data) {
    hideProgress();
    document.getElementById('batchResultsSection').style.display = 'block';
    const { results, folderPath } = data;

    const repaired = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const playable = results.filter(r => r.sessionId).length;

    const summary = { totalFiles: results.length, successfullyAnalyzed: repaired, resumeCapable: playable, failed, folderPath };
    document.getElementById('summaryCard').innerHTML = buildSummaryHTML(summary, results, true) + buildExportButtons();
    document.getElementById('batchResults').innerHTML = buildResultsGrid(results, true);
    window.batchAnalysisResults = { summary, results };
}

function buildSummaryHTML(summary, results, isRepair = false) {
    return `
        <div class="summary-stats">
            <div class="stat-item"><div class="stat-number">${summary.totalFiles}</div><div class="stat-label">Total Files</div></div>
            <div class="stat-item success"><div class="stat-number">${summary.resumeCapable}</div><div class="stat-label">${isRepair ? 'Playable' : 'Resume Capable'}</div></div>
            <div class="stat-item warning"><div class="stat-number">${summary.successfullyAnalyzed - summary.resumeCapable}</div><div class="stat-label">${isRepair ? 'Repaired (No Play)' : 'Not Resume Capable'}</div></div>
            <div class="stat-item error"><div class="stat-number">${summary.failed}</div><div class="stat-label">Failed</div></div>
        </div>
        <div class="summary-path"><strong>📁 Folder:</strong> ${summary.folderPath}</div>
    `;
}

function buildExportButtons() {
    return `
        <div class="export-buttons">
            <button onclick="exportToCSV()" class="export-btn">📥 Export CSV</button>
            <button onclick="exportToJSON()" class="export-btn">📥 Export JSON</button>
            <button onclick="resetFolderAnalysis()" class="reset-btn">🔄 Analyze Another Folder</button>
        </div>
    `;
}

function buildResultsGrid(results, isRepair) {
    let html = '<div class="results-grid">';
    results.forEach((result, index) => {
        const isGood = result.success && (result.resumeCapable || result.sessionId);
        const isBad = result.success && !result.resumeCapable && !result.sessionId;
        const isFailed = !result.success;
        const statusClass = isGood ? 'success' : (isFailed ? 'error' : 'warning');
        const statusIcon = isGood ? '✅' : (isFailed ? '❌' : '⚠️');
        const fileSize = result.size ? formatFileSize(result.size) : '';

        // Action buttons per card
        let actionBtns = `<button onclick="showDetails(${index})" class="details-btn">Details</button>`;
        if (isRepair) {
            // Repair results: always show Play if session exists
            if (result.sessionId) {
                actionBtns += `<button onclick="openBatchPlayer(${index})" class="play-btn-sm">▶ Play</button>`;
            }
        } else {
            // Analysis results: good = Play button, bad/failed = Repair button
            if (isGood) {
                actionBtns += `<button onclick="repairBatchFile(${index})" class="play-btn-sm">▶ Play</button>`;
            } else {
                actionBtns += `<button onclick="repairBatchFile(${index})" class="repair-btn-sm">🔧 Repair &amp; Play</button>`;
            }
            // Download Updated button if available
            if (result.updatedFile) {
                actionBtns += `<button onclick="downloadBatchUpdated(${index})" class="updated-download-btn">📦 Updated</button>`;
            }
        }

        html += `
            <div class="result-item ${statusClass}" id="batch-item-${index}">
                <div class="result-header">
                    <span class="result-icon">${statusIcon}</span>
                    <span class="result-filename" title="${result.filename}">${truncateFilename(result.filename)}</span>
                </div>
                <div class="result-details">
                    ${fileSize ? `<div class="result-size">${fileSize}</div>` : ''}
                    ${result.success ? `
                        <div class="result-info">
                            ${result.metadata && result.metadata.title ? `<div><strong>📚</strong> ${result.metadata.title}</div>` : ''}
                            ${result.metadata && result.metadata.version ? `<div><strong>📋</strong> SCORM ${result.metadata.version}</div>` : ''}
                            ${isRepair && result.repairs ? `<div><strong>🔧</strong> ${result.repairs.length} repair(s)</div>` : ''}
                        </div>
                        <div class="result-item-actions">${actionBtns}</div>
                    ` : `
                        <div class="error-text">${result.error || 'Analysis failed'}</div>
                        <div class="result-item-actions">${actionBtns}</div>
                    `}
                    <div id="batch-status-${index}"></div>
                </div>
            </div>
        `;
    });
    html += '</div>';
    return html;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showProgress(msg) {
    progressText.textContent = msg || 'Working…';
    progressSection.style.display = 'block';
    resultsSection.style.display = 'none';
    document.getElementById('batchResultsSection').style.display = 'none';
}
function hideProgress() { progressSection.style.display = 'none'; }

function resetUpload() {
    uploadArea.style.display = 'block';
    folderSection.style.display = 'block';
    hideProgress();
    resultsSection.style.display = 'none';
    document.getElementById('batchResultsSection').style.display = 'none';
    fileInput.value = '';
    currentFile = null;

    // Clean up the player session and blank the iframe
    const frame = document.getElementById('scormFrame');
    if (frame) frame.src = 'about:blank';
    if (currentSessionId) {
        fetch(`/play-session/${currentSessionId}`, { method: 'DELETE' }).catch(() => { });
        currentSessionId = null;
        currentLaunchFile = null;
    }
}

function resetFolderAnalysis() {
    uploadArea.style.display = 'block';
    folderSection.style.display = 'block';
    hideProgress();
    document.getElementById('batchResultsSection').style.display = 'none';
    document.getElementById('folderPath').value = '';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function truncateFilename(filename, maxLength = 38) {
    return filename.length <= maxLength ? filename : filename.substring(0, maxLength - 3) + '…';
}

function showDetails(index) {
    const result = window.batchAnalysisResults.results[index];
    let details = `File: ${result.filename}\n\n`;
    if (result.success) {
        details += `Status: ${result.resumeCapable || result.sessionId ? 'Resume Capable ✅' : 'Not Resume Capable ⚠️'}\n\n`;
        if (result.repairs) {
            details += 'Repairs Applied:\n';
            result.repairs.forEach(r => { details += `• ${r}\n`; });
            details += '\n';
        }
        if (result.details) {
            details += 'Analysis Details:\n';
            result.details.forEach(d => { details += `• ${d}\n`; });
        }
    } else {
        details += `Error: ${result.error}`;
    }
    alert(details);
}

function exportToCSV() {
    const data = window.batchAnalysisResults;
    if (!data) return;
    let csv = 'Filename,Size (bytes),Status,Resume Capable,SCORM Version,Course Title,Repairs,Error\n';
    data.results.forEach(result => {
        const status = result.success ? 'Success' : 'Failed';
        const resumeCap = result.success ? (result.resumeCapable || result.sessionId ? 'Yes' : 'No') : 'N/A';
        const version = result.metadata && result.metadata.version ? result.metadata.version : 'N/A';
        const title = result.metadata && result.metadata.title ? result.metadata.title.replace(/,/g, ';') : 'N/A';
        const repairs = result.repairs ? result.repairs.length : 0;
        const error = result.error ? result.error.replace(/,/g, ';') : '';
        csv += `"${result.filename}",${result.size || ''},"${status}","${resumeCap}","${version}","${title}",${repairs},"${error}"\n`;
    });
    downloadFile(csv, 'scorm-analysis-report.csv', 'text/csv');
}

function exportToJSON() {
    const data = window.batchAnalysisResults;
    if (!data) return;
    downloadFile(JSON.stringify(data, null, 2), 'scorm-analysis-report.json', 'application/json');
}

function downloadFile(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
}
