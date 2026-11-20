'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeRestarter } = require('../../src/claudeRestart');

test('restart selects only Claude.exe inside the current Store package', async () => {
  const installLocation = 'C:/Program Files/WindowsApps/Claude_1.0_x64__example';
  const packageFamilyName = 'Claude_abcdefgh';
  const paths = [installLocation + '/app/Claude.exe', installLocation + '/tools/other.exe',
    installLocation + '2/Claude.exe', 'C:/Users/test/AnthropicClaude/Claude.exe'];
  let processes = paths.map((path, i) => ({ pid: i + 1, path }));
  const stopped = [], launches = [];
  const ops = {
    storePackage: async () => ({ installLocation, packageFamilyName }),
    listProcesses: async () => processes,
    kill: async (pid) => { stopped.push(pid); processes = processes.filter((p) => p.pid !== pid); },
    launch: async (...args) => launches.push(args),
  };
  const service = createClaudeRestarter({ platform: 'win32', ops });
  const result = service.restart();
  assert.equal((await service.restart()).code, 409);
  assert.equal((await result).stopped, 1);
  assert.deepEqual(stopped, [1]);
  assert.deepEqual(launches, [['explorer.exe', ['shell:AppsFolder\\Claude_abcdefgh!Claude']]]);
});

test('opening Claude activates the Store app without restarting it', async () => {
  const launches = [];
  const service = createClaudeRestarter({ platform: 'win32', ops: {
    storePackage: async () => ({ packageFamilyName: 'Claude_abcdefgh' }),
    launch: async (...args) => launches.push(args),
  } });
  assert.deepEqual(await service.open(), { ok: true });
  assert.deepEqual(launches, [['explorer.exe', ['shell:AppsFolder\\Claude_abcdefgh!Claude']]]);
});
