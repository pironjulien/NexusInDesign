import assert from 'node:assert/strict';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  importHmacKey,
  localHmacSha256Hex,
  resolveCryptoApi,
  signHmacHex,
  utf8Encode,
  verifyHmacHex
} = require('../plugin/security-crypto');

test('js-sha256 0.11.1 embarque conserve la source auditée indépendamment des fins de ligne', async () => {
  const source = await fs.readFile(new URL('../plugin/vendor/js-sha256.js', import.meta.url), 'utf8');
  const normalizedSource = source.replace(/\r\n/g, '\n');
  assert.equal(
    createHash('sha256').update(normalizedSource).digest('hex'),
    '2db6c8e554fbee14672368a0d7551a8ddd841ee96c91526eb7987a0179cfc717'
  );
});

test('HMAC-SHA256 local respecte les vecteurs RFC 4231', () => {
  assert.equal(
    localHmacSha256Hex(new Uint8Array(20).fill(0x0b), utf8Encode('Hi There')),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  );
  assert.equal(
    localHmacSha256Hex(utf8Encode('Jefe'), utf8Encode('what do ya want for nothing?')),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  );
});

test('le moteur local conserve le contrat mutuel sans SubtleCrypto', async () => {
  const cryptoWithoutSubtle = { getRandomValues: (array) => webcrypto.getRandomValues(array) };
  const secret = 'secret-d-appairage-de-test-avec-une-taille-suffisante';
  const message = 'command:session:{"texte":"État-major — InDesign"}';
  const key = await importHmacKey(secret, cryptoWithoutSubtle);
  assert.equal(key.mode, 'local');
  const proof = await signHmacHex(key, message);
  assert.equal(proof, createHmac('sha256', secret).update(message, 'utf8').digest('hex'));
  assert.equal(await verifyHmacHex(key, message, proof), true);
  assert.equal(await verifyHmacHex(key, message + '!', proof), false);
  assert.equal(await verifyHmacHex(key, message, '00'), false);
});

test('SubtleCrypto reste utilisé quand il est réellement complet', async () => {
  const key = await importHmacKey('secret-subtle-de-test', webcrypto);
  assert.equal(key.mode, 'subtle');
  const proof = await signHmacHex(key, 'bridge:test');
  assert.equal(await verifyHmacHex(key, 'bridge:test', proof), true);
  assert.equal(await verifyHmacHex(key, 'plugin:test', proof), false);
});

test('la détection privilégie explicitement window.crypto', () => {
  const windowCrypto = { getRandomValues() {} };
  assert.equal(resolveCryptoApi({ crypto: windowCrypto }), windowCrypto);
});
