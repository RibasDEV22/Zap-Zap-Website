const { app, BrowserWindow, session, shell, Notification, powerSaveBlocker } = require('electron');
const path = require('path');

let powerBlockerId = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: 'Zap Zap',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0b141a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.on('minimize', () => {
    if (powerBlockerId === null) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  });

  win.on('restore', () => {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    }
  });
}

async function clearAppCache() {
  try {
    if (session.defaultSession) {
      await session.defaultSession.clearCache();
    }
  } catch (err) {
    console.error('[Session] Erro ao limpar cache:', err);
  }
}

app.whenReady().then(async () => {
  await clearAppCache();

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'notifications', 'pointerLock', 'fullscreen', 'clipboard-read'];
    callback(allowed.includes(permission));
  });

  if (Notification.isSupported()) {
    console.log('[Electron] Notificações nativas suportadas');
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId);
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('second-instance', () => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length) {
    if (wins[0].isMinimized()) wins[0].restore();
    wins[0].focus();
  }
});
