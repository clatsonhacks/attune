'use strict';
/*
 * Restart Claude Desktop (Windows only) so it reloads its MCP servers — only after the person confirmed in Attune.
 *
 * Claude Desktop has no graceful-quit API, so its processes are force-stopped: unsent drafts or running local sessions
 * can be lost. Only Claude Desktop's own processes are ever targeted:
 *   - the Microsoft Store build: executables under …\WindowsApps\Claude_<version>_<arch>__<publisher>\
 * Only executables inside the installed Store package are selected.
 */
const path = require('path');
const { execFile, spawn } = require('child_process');

const FAMILY = /^Claude_[a-z0-9]{8,20}$/i;

function norm(p) { return String(p || '').replace(/\//g, '\\').toLowerCase(); }

function selectTargets(processes, installLocation) {
  const dir = norm(installLocation);
  if (!/\\windowsapps\\claude_[^\\]+$/.test(dir)) return [];
  return processes.filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.pid !== process.pid &&
    norm(p.path).startsWith(dir + '\\') && path.win32.basename(norm(p.path)) === 'claude.exe');
}

/* ---------------- real process control (Windows) ---------------- */

function powershell(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}
const asArray = (j) => (j == null ? [] : Array.isArray(j) ? j : [j]);

const realOps = {
  /** The Store package's family name, or null when the Store build is not installed. */
  async storePackage() {
    const out = await powershell('Get-AppxPackage -Name Claude | Select-Object -First 1 PackageFamilyName, InstallLocation | ConvertTo-Json -Compress');
    const pkg = out ? JSON.parse(out) : null;
    return pkg && FAMILY.test(pkg.PackageFamilyName) ? { packageFamilyName: pkg.PackageFamilyName, installLocation: pkg.InstallLocation } : null;
  },
  /** Every process with a known executable path: [{ pid, path }]. */
  async listProcesses() {
    const out = await powershell('Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ' +
      'Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress');
    return asArray(out ? JSON.parse(out) : null).map((p) => ({ pid: p.ProcessId, path: p.ExecutablePath }));
  },
  async kill(pid) { try { process.kill(pid); } catch (e) { if (e.code !== 'ESRCH') throw e; } },
  launch(file, args) {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * restart() → { ok: true, relaunched: true, build, stopped } or { ok: false, code, error, relaunched: false }.
 * code is the HTTP status the route should answer with.
 */
function createClaudeRestarter({ platform = process.platform, ops = realOps, timeoutMs = 10000, pollMs = 250 } = {}) {
  let busy = false;
  const launchPackage = (pkg) => ops.launch('explorer.exe', [`shell:AppsFolder\\${pkg.packageFamilyName}!Claude`]);
  async function open() {
    if (platform !== 'win32') return { ok: false, code: 501, error: 'Open Claude Desktop from your applications.' };
    try {
      const pkg = await ops.storePackage();
      if (!pkg) return { ok: false, code: 404, error: 'Microsoft Store Claude Desktop was not found. Open Claude from your applications.' };
      await launchPackage(pkg);
      return { ok: true };
    } catch { return { ok: false, code: 500, error: 'Open Claude Desktop from your applications.' }; }
  }
  async function restart() {
    if (platform !== 'win32') return { ok: false, code: 501, relaunched: false, error: 'Restarting Claude Desktop from Attune is only available on Windows. Quit and reopen Claude yourself.' };
    if (busy) return { ok: false, code: 409, relaunched: false, error: 'Claude Desktop is already restarting.' };
    busy = true;
    try {
      let pkg = null;
      try { pkg = await ops.storePackage(); } catch { pkg = null; }
      if (!pkg) return { ok: false, code: 404, relaunched: false, error: 'Microsoft Store Claude Desktop was not found.' };
      const build = 'store';
      const targets = selectTargets(await ops.listProcesses(), pkg.installLocation);

      for (const t of targets) await ops.kill(t.pid);
      const pids = new Set(targets.map((t) => t.pid));
      const deadline = Date.now() + timeoutMs;
      while (pids.size) {
        const alive = new Set((await ops.listProcesses()).map((p) => p.pid));
        for (const pid of [...pids]) if (!alive.has(pid)) pids.delete(pid);
        if (!pids.size) break;
        if (Date.now() >= deadline) return { ok: false, code: 504, relaunched: false, build, error: 'Claude Desktop did not close in time. Quit it yourself and open it again.' };
        await ops.sleep(pollMs);
      }

      await launchPackage(pkg);
      return { ok: true, relaunched: true, build, stopped: targets.length };
    } catch {
      return { ok: false, code: 500, relaunched: false, error: 'Could not restart Claude Desktop. Quit it yourself and open it again.' };
    } finally {
      busy = false;
    }
  }
  return { open, restart, supported: platform === 'win32' };
}

module.exports = { createClaudeRestarter, selectTargets };
