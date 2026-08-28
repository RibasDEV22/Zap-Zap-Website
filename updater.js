const CURRENT_VERSION = '1.0.0';
const GITHUB_REPO = 'RibasDEV22/zap-zap';
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const NOVIDADES_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/novidades.txt`;

let pendingDownloadUrl = null;

// Verifica se está rodando em um ambiente nativo (Electron ou WebView/App)
function isNativeApp() {
    const ua = navigator.userAgent.toLowerCase();
    const isElectron = ua.includes('electron') || !!window.require || (typeof process !== 'undefined' && process.versions && process.versions.electron);
    const isWebView = ua.includes('wv') || ua.includes('webview') || !!window.Android || !!window.Capacitor || !!window.cordova;
    return isElectron || isWebView;
}

function detectPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('android')) return 'android';
    if (ua.includes('win')) return 'windows';
    return 'other';
}

async function checkForUpdates() {
    try {
        const response = await fetch(RELEASES_API_URL);
        if (!response.ok) return;

        const release = await response.json();
        const latestVersion = release.tag_name.replace(/^v/, '');

        if (isNewerVersion(CURRENT_VERSION, latestVersion)) {
            const platform = detectPlatform();

            const targetAsset = release.assets.find(asset => {
                const name = asset.name.toLowerCase();
                if (platform === 'android') {
                    return name.endsWith('.apk') || name.includes('app.apk');
                }
                return name.endsWith('.exe') || name.includes('setup.exe');
            });

            pendingDownloadUrl = targetAsset ? targetAsset.browser_download_url : release.html_url;

            let changelogText = release.body || 'Melhorias gerais e correções de estabilidade.';
            try {
                const novidadesRes = await fetch(NOVIDADES_RAW_URL);
                if (novidadesRes.ok) {
                    changelogText = await novidadesRes.text();
                }
            } catch (err) {
                console.warn('[Updater] Não foi possível carregar novidades.txt via URL raw.');
            }

            showUpdateModal(release.tag_name, changelogText, platform);
        }
    } catch (err) {
        console.error('[Updater] Erro ao buscar atualizações:', err);
    }
}

function isNewerVersion(current, latest) {
    const cParts = current.split('.').map(Number);
    const lParts = latest.split('.').map(Number);

    for (let i = 0; i < Math.max(cParts.length, lParts.length); i++) {
        const c = cParts[i] || 0;
        const l = lParts[i] || 0;
        if (l > c) return true;
        if (c > l) return false;
    }
    return false;
}

function showUpdateModal(versionTag, changelog, platform) {
    const updateOverlay = document.getElementById('update-screen');
    const versionText = document.getElementById('update-version-text');
    const changelogEl = document.getElementById('update-changelog');
    const btnStartUpdate = document.getElementById('btn-start-update');

    const native = isNativeApp();

    if (versionText) {
        if (native) {
            const fileType = platform === 'android' ? 'Pacote APK' : 'Instalador Windows (.exe)';
            versionText.textContent = `Versão ${versionTag} disponível (${fileType})`;
        } else {
            versionText.textContent = `Novidades da Versão ${versionTag}`;
        }
    }

    if (changelogEl) changelogEl.textContent = changelog;

    // Se estiver no navegador, apenas mostra o botão de fechar/entendi
    if (btnStartUpdate) {
        if (!native) {
            btnStartUpdate.textContent = 'Entendi';
            btnStartUpdate.onclick = finishUpdate;
        } else {
            btnStartUpdate.textContent = 'Atualizar Agora';
            btnStartUpdate.onclick = startUpdateProcess;
        }
    }

    if (updateOverlay) updateOverlay.classList.remove('hidden');
}

function startUpdateProcess() {
    // Impede o download no navegador Web
    if (!pendingDownloadUrl || !isNativeApp()) return;

    const stepInfo = document.getElementById('update-step-info');
    const stepProgress = document.getElementById('update-step-progress');
    const stepComplete = document.getElementById('update-step-complete');
    const progressBar = document.getElementById('update-progress-bar');
    const percentageText = document.getElementById('update-percentage-text');
    const statusMsg = document.getElementById('update-status-msg');
    const platform = detectPlatform();

    stepInfo?.classList.add('hidden');
    stepProgress?.classList.remove('hidden');

    if (statusMsg) {
        statusMsg.textContent = platform === 'android'
            ? 'Baixando app.apk...'
            : 'Baixando setup.exe...';
    }

    let progress = 0;
    const interval = setInterval(() => {
        progress += 25;
        if (progressBar) progressBar.style.width = `${Math.min(progress, 100)}%`;
        if (percentageText) percentageText.textContent = `${Math.min(progress, 100)}%`;

        if (progress >= 100) {
            clearInterval(interval);

            if (window.require) {
                try {
                    const { shell } = window.require('electron');
                    shell.openExternal(pendingDownloadUrl);
                } catch (e) {
                    window.location.href = pendingDownloadUrl;
                }
            } else {
                window.location.href = pendingDownloadUrl;
            }

            stepProgress?.classList.add('hidden');
            stepComplete?.classList.remove('hidden');
        }
    }, 120);
}

function finishUpdate() {
    document.getElementById('update-screen')?.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', checkForUpdates);
