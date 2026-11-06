// Thin wrapper over the macOS `security` CLI. Each clave fiscal is a profile stored under the service
// "arca-<perfil>" (e.g. "arca-martin"), with accounts "cuit" and "clave", so other ARCA tools can reuse
// them and several claves can coexist. Visible in Keychain Access.app.

import { execFileSync, spawnSync } from 'node:child_process';

function servicio(perfil) {
  // interpolated into a `security -i` command line, so keep it to safe characters
  if (!/^[a-z0-9_-]+$/i.test(perfil ?? '')) throw new Error(`Perfil inválido: "${perfil}" (usá letras, números, - o _)`);
  return `arca-${perfil}`;
}

export function leerKeychain(perfil, cuenta) {
  // -g prints (to stderr) `password: "value"`, or `password: 0x<hex> ...` when the value has non-ASCII chars (ñ, á...)
  const { status, stderr } = spawnSync('security', ['find-generic-password', '-s', servicio(perfil), '-a', cuenta, '-g'], {
    encoding: 'utf8',
  });
  if (status !== 0) return null; // not stored yet
  const line = stderr.split('\n').find((l) => l.startsWith('password: '));
  const hex = line.match(/^password: 0x([0-9A-F]+)/i);
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8');
  return line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
}

// The value goes hex-encoded through `security -i` on stdin, so it never shows up in argv / `ps`
// and needs no quoting. -U updates an existing item.
export function guardarKeychain(perfil, cuenta, valor) {
  const hex = Buffer.from(valor, 'utf8').toString('hex');
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${servicio(perfil)} -a ${cuenta} -X ${hex}\n`,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  if (leerKeychain(perfil, cuenta) !== valor) throw new Error(`No se pudo guardar "${cuenta}" en el Keychain`);
}
