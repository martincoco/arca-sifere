// Capture tool: logs in to ARCA and opens SIFERE Web, then gets out of the way. You file the DDJJ by hand
// as usual while every screen you visit is saved (HTML of each frame + screenshot) to capturas/, so the
// automation can be built from the real pages. Nothing inside SIFERE is clicked by this script.
//
//   npm run explorar -- martin      # Keychain profile to log in with (arca-martin)
//
// In the terminal: Enter = save the current screen again (e.g. after filling a table), "q" + Enter = finish.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { leerKeychain } from './keychain.js';
import { ask } from './prompt.js';

const LOGIN_URL = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml';
const DIR = 'capturas';

const perfil = process.argv[2];
if (!perfil) {
  console.error('Indicá el perfil del Keychain: npm run explorar -- <perfil>   (ej: martin)');
  process.exit(1);
}
const cuit = leerKeychain(perfil, 'cuit') ?? (await ask('CUIT: '));
const clave = leerKeychain(perfil, 'clave') ?? (await ask('Clave fiscal: ', { hidden: true }));

mkdirSync(DIR, { recursive: true });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ acceptDownloads: true });
let page = await context.newPage();
let n = 0;

// Native popups never show in a Playwright browser, so they're relayed here: alerts are just printed,
// confirms wait for your s/N in the terminal (answered by the input loop at the end).
let confirmPendiente = null;
context.on('dialog', async (d) => {
  console.log(`\n[popup ${d.type()}] ${d.message()}`);
  if (d.type() === 'alert') return d.accept();
  confirmPendiente = d;
  console.log('¿Aceptar este popup? (s/N)');
});

try {
  await page.goto(LOGIN_URL);
  await page.fill('#F1\\:username', cuit);
  await page.click('#F1\\:btnSiguiente');
  await page.fill('#F1\\:password', clave);
  await page.click('#F1\\:btnIngresar');
  await page.waitForURL(/portalcf/, { timeout: 30_000 });

  await page.fill('#buscadorInput', 'SIFERE');
  const servicio = page.getByText(/sifere/i).filter({ visible: true }).first();
  const popup = context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);
  await servicio.click();
  page = (await popup) ?? page;
} catch (err) {
  console.error(`No pude abrir SIFERE automáticamente (${err.message.split('\n')[0]}). Abrilo a mano en el navegador.`);
}

// From here on, capture every page load in any tab (SIFERE may open new ones).
const capturar = async (p, motivo) => {
  try {
    await p.waitForLoadState('domcontentloaded');
    const base = `${DIR}/${String(++n).padStart(3, '0')}`;
    await p.screenshot({ path: `${base}.png`, fullPage: true });
    // one file per frame: SIFERE pages may be built from iframes
    await Promise.all(p.frames().map((f, i) => f.content()
      .then((html) => writeFileSync(`${base}_frame${i}.html`, `<!-- ${f.url()} -->\n${html}`))
      .catch(() => {})));
    // typed values live in the DOM properties, not in the saved HTML; record them per frame
    const campos = await Promise.all(p.frames().map((f, i) => f.evaluate(() =>
      [...document.querySelectorAll('input, select, textarea')]
        .filter((e) => e.type !== 'hidden' || e.value)
        .map((e) => ({
          tag: e.tagName.toLowerCase(), type: e.type, id: e.id, name: e.name,
          value: e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value,
          texto: e.tagName === 'SELECT' ? e.selectedOptions[0]?.label : undefined,
        }))).then((c) => ({ frame: i, url: f.url(), campos: c })).catch(() => null)));
    writeFileSync(`${base}_campos.json`, JSON.stringify(campos.filter(Boolean), null, 2));
    console.log(`  guardada ${base} (${motivo}): ${await p.title().catch(() => '')} ${p.url()}`);
  } catch { /* page closed mid-capture */ }
};
// Full page loads, plus inner frames: inside a DDJJ, SIFERE swaps only the right-hand <iframe> when you
// click items in the left tree, which doesn't fire a page load.
const vigilar = (p) => {
  p.on('load', () => capturar(p, 'carga'));
  p.on('framenavigated', (f) => {
    if (f === p.mainFrame()) return;
    f.waitForLoadState('load')
      .then(() => capturar(p, `panel ${f.url().split('/').pop().split('?')[0]}`))
      .catch(() => {});
  });
};
context.pages().forEach(vigilar);
context.on('page', (p) => { page = p; vigilar(p); });
await capturar(page, 'inicio');

console.log('\nCompletá la DDJJ a mano en el navegador. Enter = guardar pantalla actual, q = terminar.');
for await (const linea of createInterface({ input: process.stdin })) {
  const r = linea.trim().toLowerCase();
  if (confirmPendiente) {
    const d = confirmPendiente;
    confirmPendiente = null;
    await (r === 's' ? d.accept() : d.dismiss());
    console.log(r === 's' ? '  aceptado' : '  cancelado');
    continue;
  }
  if (r === 'q') break;
  await capturar(context.pages().at(-1) ?? page, 'manual');
}
await browser.close();
console.log(`\nListo: ${n} capturas en ${DIR}/`);
