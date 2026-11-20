'use strict';

const path = require('node:path');
const { once } = require('node:events');
const { app, BrowserWindow, Menu, Tray, dialog, shell } = require('electron');
const { createApp } = require('../src/webServer');
const { isDemo } = require('../src/adapter');
const { dataDir } = require('../src/paths');
const { createKeyStore } = require('./keyStore');

const port = Number(process.env.PORT) || 3000;
const origin = 'http://127.0.0.1:' + port;
const icon = path.join(__dirname, '../extension/icon.png');
let service, window, tray;
let quitting = false;

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function start() {
  const file = path.join(dataDir({ demo: isDemo() }), 'camera-key.enc');
  const groqStore = createKeyStore(path.join(path.dirname(file), 'groq-key.enc'), require('electron').safeStorage);
  service = createApp({ port, groqStore, keyStore: createKeyStore(file, require('electron').safeStorage),
    ...(app.isPackaged ? { extensionFile: path.join(process.resourcesPath, 'attune.mcpb') } : {}) });
  service.server.listen(port, '127.0.0.1');
  await once(service.server, 'listening');
  window = new BrowserWindow({ title: 'Attune', width: 1140, height: 820, icon,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['https://physiology.presagetech.com', 'https://api.physiology.presagetech.com', 'https://developers.openai.com', 'https://console.groq.com'].includes(new URL(url).origin)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('close', (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  tray = new Tray(icon);
  tray.setToolTip('Attune');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Attune', click: showWindow }, { label: 'Quit Attune', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  await window.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', (event) => {
    if (quitting || !service) return;
    event.preventDefault();
    quitting = true;
    service.close().finally(() => app.quit());
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Attune could not start', error.code === 'EADDRINUSE'
      ? 'The Attune port is in use. Quit the running service before opening the desktop app.' : error.message);
    app.quit();
  });
}
