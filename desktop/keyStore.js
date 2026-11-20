'use strict';

const fs = require('node:fs');
const { writeFileAtomic } = require('../src/paths');

function createKeyStore(file, safeStorage) {
  return {
    async get() {
      let encrypted;
      try { encrypted = fs.readFileSync(file); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      return (await safeStorage.decryptStringAsync(encrypted)).result;
    },
    async set(key) {
      const encrypted = await safeStorage.encryptStringAsync(key);
      writeFileAtomic(file, encrypted);
    },
    async clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { createKeyStore };
