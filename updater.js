const CURRENT_VERSION = '1.0.0';
const GITHUB_REPO = 'RibasDEV22/zap-zap';
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const NOVIDADES_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/novidades.txt`;

/**
 * Updater apenas informativo.
 * Mostra o changelog / novidades quando existe versão mais nova.
 * NÃO baixa APK, EXE nem redireciona para instalação.
 */

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

async function checkForUpdates() {
  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github.v3+json' }
    });
    if (!response.ok) return;

    const release = await response.json();
    const latestVersion = (release.tag_name || '').replace(/^v/, '');

    if (!latestVersion || !isNewerVersion(CURRENT_VERSION, latestVersion)) return;

    let changelogText = release.body || 'Melhorias gerais e correções de estabilidade.';

    try {
      const novidadesRes = await fetch(NOVIDADES_RAW_URL);
      if (novidadesRes.ok) {
        const text = await novidadesRes.text();
        if (text && text.trim()) changelogText = text.trim();
      }
    } catch (err) {
      console.warn('[Updater] Não foi possível carregar novidades.txt');
    }

    showUpdateModal(release.tag_name || latestVersion, changelogText);
  } catch (err) {
    console.error('[Updater] Erro ao buscar atualizações:', err);
  }
}

function showUpdateModal(versionTag, changelog) {
  const updateOverlay = document.getElementById('update-screen');
  const versionText = document.getElementById('update-version-text');
  const changelogEl = document.getElementById('update-changelog');
  const btnStartUpdate = document.getElementById('btn-start-update');
  const stepInfo = document.getElementById('update-step-info');
  const stepProgress = document.getElementById('update-step-progress');
  const stepComplete = document.getElementById('update-step-complete');

  // Garante que só a etapa de informação aparece
  stepInfo?.classList.remove('hidden');
  stepProgress?.classList.add('hidden');
  stepComplete?.classList.add('hidden');

  if (versionText) {
    versionText.textContent = `Novidades da versão ${versionTag}`;
  }

  if (changelogEl) {
    changelogEl.textContent = changelog;
  }

  if (btnStartUpdate) {
    btnStartUpdate.textContent = 'Entendi';
    btnStartUpdate.onclick = finishUpdate;
  }

  if (updateOverlay) {
    updateOverlay.classList.remove('hidden');
  }
}

function finishUpdate() {
  document.getElementById('update-screen')?.classList.add('hidden');
}

// Exposto globalmente caso o HTML chame diretamente
window.finishUpdate = finishUpdate;

document.addEventListener('DOMContentLoaded', () => {
  // Pequeno atraso para não competir com o splash
  setTimeout(checkForUpdates, 1800);
});
