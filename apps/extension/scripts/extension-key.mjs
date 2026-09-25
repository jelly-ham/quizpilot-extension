// Create (once) the RSA key that fixes the extension ID.
//
//   keys/extension-key.pem  private key: keep secret, back it up, never commit
//   extension-key.pub       public key (base64 DER), read by manifest.config.ts as `key`
//
// The extension ID is derived from the public key, so Google OAuth redirect URIs
// (https://<id>.chromiumapp.org/) and ALLOWED_ORIGINS stay valid across machines.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pemPath = join(root, 'keys/extension-key.pem');
const pubPath = join(root, 'extension-key.pub');

/** Chrome extension ID: first 128 bits of sha256(public key DER), hex digits mapped 0-f → a-p. */
export function extensionId(publicKeyDerBase64) {
  const hex = createHash('sha256')
    .update(Buffer.from(publicKeyDerBase64, 'base64'))
    .digest('hex')
    .slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(pemPath)) {
    mkdirSync(dirname(pemPath), { recursive: true });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`created ${pemPath} (back it up; do not commit)`);
  }
  const der = createPublicKey(createPrivateKey(readFileSync(pemPath))).export({
    type: 'spki',
    format: 'der',
  });
  const pub = der.toString('base64');
  writeFileSync(pubPath, `${pub}\n`);
  const id = extensionId(pub);
  console.log(`extension id: ${id}`);
  console.log(`google oauth redirect: https://${id}.chromiumapp.org/`);
  console.log(`allowed origin: chrome-extension://${id}`);
}
