// Loads the monthly SIFERE Web DDJJ (Convenio Multilateral, CM03) for the contribuyente in config.json and
// stops on the "Finalizar DDJJ" totals for a manual s/N before "Cerrar DJ".
//
//   npm run presentar -- 500000                     # previous month
//   npm run presentar -- 500000.50 --periodo 2026-09
//
// The only monthly input is the amount; the jurisdiction split, tratamiento fiscal and alícuota come from
// config.json, and deducciones are imported from what the agents reported. Never deletes anything: if a
// draft for the period already exists, delete it by hand from "Listado de DDJJ" and run again.

import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { leerKeychain } from './keychain.js';
import { ask } from './prompt.js';

const LOGIN_URL = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml';
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { periodo: { type: 'string' } },
});

const montoArg = positionals[0] ?? '';
// strict format: "500.000" (Argentine thousands separator) would otherwise be read as 500
if (!/^\d+(\.\d{1,2})?$/.test(montoArg)) {
  console.error('Uso: npm run presentar -- MONTO [--periodo AAAA-MM]   (ej: 500000 o 500000.50, sin puntos de miles)');
  process.exit(1);
}
const monto = Number(montoArg);

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const cuit = leerKeychain(config.perfil, 'cuit') ?? (await ask('CUIT: '));
const clave = leerKeychain(config.perfil, 'clave') ?? (await ask('Clave fiscal: ', { hidden: true }));

const { anio, mes } = periodo(args.periodo);
const periodoLabel = `${MESES[mes - 1]} ${anio}`;
const bases = repartir(monto, config.jurisdicciones);

console.log(`DDJJ ${periodoLabel} para CUIT ${config.cuitContribuyente}: monto ${pesos(monto)}`);
config.jurisdicciones.forEach((j, i) => console.log(`  ${j.codigo} ${j.nombre}: ${j.porcentaje}% = ${pesos(bases[i])}`));

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const context = await browser.newContext();
let page = await context.newPage();

// Native popups never show in a Playwright browser; collect them so the step fails with SIFERE's message.
// Only the final close confirmation is accepted, and only after the user typed "s".
const alertas = [];
let aceptarConfirmacion = false;
context.on('dialog', async (d) => {
  if (d.type() === 'confirm' && aceptarConfirmacion) return d.accept();
  alertas.push(d.message());
  await d.dismiss();
});

let idDDJJ;
try {
  await step('login', async () => {
    await page.goto(LOGIN_URL);
    await page.fill('#F1\\:username', cuit);
    await page.click('#F1\\:btnSiguiente');
    await page.fill('#F1\\:password', clave);
    await page.click('#F1\\:btnIngresar');
    await page.waitForURL(/portalcf/, { timeout: 30_000 });
  });

  await step('abrir SIFERE', async () => {
    await page.fill('#buscadorInput', 'SIFERE');
    const servicio = page.getByText(/sifere/i).filter({ visible: true }).first();
    const popup = context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    await servicio.click();
    page = (await popup) ?? page;
    await page.waitForURL(/sifereweb\.comarb\.gob\.ar/, { timeout: 30_000 });
  });

  // The login user may represent several contribuyentes; never guess which one to file for.
  await step('elegir contribuyente', async () => {
    const select = page.locator('select#cuit');
    if (await select.count()) {
      await page.waitForFunction((c) => [...document.querySelectorAll('select#cuit option')].some((o) => o.value === c), config.cuitContribuyente, { timeout: 15_000 })
        .catch(async () => {
          const opciones = await select.locator('option').allTextContents();
          throw new Error(`El CUIT ${config.cuitContribuyente} no está entre las opciones: ${opciones.join(' | ')}`);
        });
      await select.selectOption(config.cuitContribuyente);
      await page.click('input[value="Seleccionar"]');
      await page.waitForLoadState();
    }
    // "La CUIT seleccionada ya se encuentra conectada al sistema..." shows up when an earlier session (e.g. a
    // previous run's browser) is still open; confirming just ends that old session
    const confirmarIngreso = page.getByRole('button', { name: /Confirmar Ingreso al Sistema/i });
    if (await confirmarIngreso.waitFor({ timeout: 3_000 }).then(() => true, () => false)) {
      const texto = await page.locator('body').innerText();
      const enPantalla = await page.locator('input[type="text"]').first().inputValue().catch(() => '');
      if (!texto.includes(config.cuitContribuyente) && enPantalla !== config.cuitContribuyente) {
        throw new Error(`SIFERE pide confirmar el ingreso de otro CUIT (${enPantalla || '?'}); no confirmo`);
      }
      console.log('  había una sesión abierta de este CUIT; confirmo el ingreso');
      await confirmarIngreso.click();
      await page.waitForLoadState();
    }
    const cabecera = await page.locator('body').innerText();
    if (!cabecera.includes(fmtCuit(config.cuitContribuyente))) throw new Error(`SIFERE no muestra el CUIT ${fmtCuit(config.cuitContribuyente)} en la cabecera`);
  });

  await step(`crear DJ ${periodoLabel}`, async () => {
    await page.goto(new URL('MostrarNuevaDDJJController.do', page.url()).href);
    // "Por tu perfil podés utilizar la presentación simplificada..." notice
    const entendido = page.locator('#abrirModal');
    await entendido.waitFor({ state: 'visible', timeout: 3_000 }).then(() => entendido.click(), () => {});
    await elegir(page, '#anio', String(anio));
    await elegir(page, '#mes', MESES[mes - 1]);
    await page.click('#crearNuevadj');
    const iframe = page.locator('iframe[src*="idDDJJ="]').first();
    await iframe.waitFor({ state: 'attached', timeout: 30_000 }).catch(async () => {
      const msg = await mensajesVisibles(page);
      throw new Error(`SIFERE no creó la DJ${msg ? `: ${msg}` : ''}. Si ya existe un borrador de ${periodoLabel}, borralo desde "Listado de DDJJ" y volvé a correr.`);
    });
    idDDJJ = new URL(await iframe.getAttribute('src'), page.url()).searchParams.get('idDDJJ');
    const arbol = await page.locator('body').innerText();
    const esperado = `${anio}${String(mes).padStart(2, '0')} Original`;
    if (!arbol.includes(esperado)) throw new Error(`Esperaba "${esperado}" en el árbol de la DJ`);
    console.log(`  DJ creada (id ${idDDJJ})`);
  });

  await step('monto de actividades', async () => {
    const f = await abrirPanel(`MostrarDDJJActividadesNivelPaisController.do?idDDJJ=${idDDJJ}`);
    await f.locator('#tableActiPais tr', { hasText: config.actividad }).locator('a[title="Editar Montos"]').click();
    await f.locator(`#${config.campoMonto}`).waitFor({ state: 'visible' });
    await f.fill(`#${config.campoMonto}`, monto.toFixed(2));
    await f.press(`#${config.campoMonto}`, 'Tab'); // onchange normalizes the number
    await Promise.all([f.waitForNavigation(), f.click('#enviar_actualizacion')]);
    const fila = await f.locator('#tableActiPais tr', { hasText: config.actividad }).innerText();
    if (!fila.includes(pesos(monto, false))) throw new Error(`La actividad quedó "${fila.replace(/\s+/g, ' ')}", esperaba ${pesos(monto, false)}`);
  });

  await step('deducciones', async () => {
    await page.getByText('Carga de Deducciones', { exact: true }).click();
    const f = await panelDeducciones();
    await confirmarDeducciones(f, 'Actualizar deducciones');
    await confirmarDeducciones(f, 'Incluir Deducciones en DJ');
    const total = (await f.locator('body').innerText()).match(/Total general:[^\n]*/)?.[0];
    console.log(`  ${total ?? 'sin total de deducciones'}`);
  });

  for (const [i, j] of config.jurisdicciones.entries()) {
    await step(`jurisdicción ${j.codigo} ${j.nombre}`, async () => {
      let f = await abrirPanel(`MostrarDDJJActividadesJurisdiccionController.do?idDDJJ=${idDDJJ}&idJurisdiccion=${j.codigo}`);
      await f.locator('#tableActiJur tr', { hasText: config.actividad }).locator('a[title="Editar"]').click();
      await f.locator('#baseimponible').waitFor({ state: 'visible' });
      await f.fill('#baseimponible', bases[i].toFixed(2));
      await f.press('#baseimponible', 'Tab');
      await f.selectOption('#tratamientofiscal2', j.tratamientoFiscal);
      await f.waitForLoadState('networkidle'); // the tratamiento change looks up a suggested alícuota
      // some tratamientos (e.g. EXENTO) make SIFERE set the alícuota itself and lock the field
      if (await f.locator('#alicuota').isEditable()) {
        await f.fill('#alicuota', j.alicuota);
        await f.press('#alicuota', 'Tab');
      } else {
        const fijada = await f.inputValue('#alicuota');
        if (Number(fijada) !== Number(j.alicuota)) throw new Error(`SIFERE fijó la alícuota en ${fijada} (no editable), config.json dice ${j.alicuota}`);
        console.log(`  alícuota ${fijada} (fijada por SIFERE)`);
      }
      await Promise.all([f.waitForNavigation(), f.click('#enviar_actualizacion')]);
      await revisarMensajes(f);

      const fila = (await f.locator('#tableActiJur tr', { hasText: config.actividad }).innerText()).replace(/\s+/g, ' ');
      if (!fila.includes(pesos(bases[i], false)) || !fila.includes(j.alicuota)) {
        throw new Error(`La actividad quedó "${fila}", esperaba base ${pesos(bases[i], false)} y alícuota ${j.alicuota}`);
      }

      for (const tipo of ['gravados', 'nogravados', 'exentos']) {
        await f.fill(`#ingresos${tipo}`, tipo === j.ingresos ? bases[i].toFixed(2) : '0.00');
        await f.press(`#ingresos${tipo}`, 'Tab');
      }
      await Promise.all([f.waitForNavigation(), f.click('#actualizar_ingresos')]);
      await revisarMensajes(f);
    });
  }

  await step('datos del firmante', async () => {
    const f = await abrirPanel(`MostrarDDJJDatosFirmanteController.do?idDDJJ=${idDDJJ}`);
    await Promise.all([f.waitForNavigation(), f.click('#djanterior')]); // copy from the last presented DDJJ
    if (!(await f.inputValue('input[name="apellido"]'))) throw new Error('No se pudieron traer los datos del firmante de la última DJ');
    await Promise.all([f.waitForNavigation(), f.click('#actualizar')]);
    await revisarMensajes(f);
  });

  let totales;
  await step('revisar totales', async () => {
    const f = await abrirPanel(`MostrarDDJJCierreController.do?idDDJJ=${idDDJJ}&timestamp=${Date.now()}`);
    totales = await f.locator('#tableCierreDdjj').innerText();
  });
  console.log(`\n${totales.replace(/\t/g, '  |  ')}\n`);
  const aPagar = totales.match(/Total a pagar[^\n]*?([\d.]+,\d{2})\s*$/m)?.[1] ?? '?';

  // earlier clicks leave the page scrolled down to a blank area; bring the totals and "Cerrar DJ" into view
  await page.evaluate(() => window.scrollTo(0, 0));
  await panel().evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await panel().getByRole('button', { name: 'Cerrar DJ', exact: true }).scrollIntoViewIfNeeded().catch(() => {});
  console.log('Revisá los totales en el navegador.');
  const respuesta = await ask(`¿Cerrar la DJ de ${periodoLabel} (total a pagar $ ${aPagar})? (s/N) `);
  if (respuesta.toLowerCase() !== 's') {
    console.log('No se cerró. La DJ queda como borrador en SIFERE (borrala desde "Listado de DDJJ" si no la vas a usar).');
  } else {
    // First run of this step can't be tested without closing a real DJ, so it clicks "Cerrar DJ", accepts
    // the confirmation the user just approved, and then leaves the browser open to check the outcome.
    await step('cerrar DJ', async () => {
      const f = panel();
      aceptarConfirmacion = true;
      await f.getByRole('button', { name: 'Cerrar DJ', exact: true }).click();
      const swal = f.locator('.swal2-confirm').filter({ visible: true });
      if (await swal.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
        console.log(`  SIFERE: ${(await mensajesVisibles(f)) || '(confirmación)'}`);
        await swal.click();
      }
      // on success SIFERE reloads the whole page into "Listado de DDJJ" (so the panel frame is gone);
      // show this period's row from that list
      await page.waitForURL(/MostrarListaDDJJController/, { timeout: 60_000 });
      await page.waitForFunction(() => {
        const filas = [...document.querySelectorAll('#tableMensualDj tbody tr')];
        return filas.length && !filas.some((tr) => tr.innerText.includes('Cargando'));
      }, null, { timeout: 60_000 });
      const filas = await page.locator('#tableMensualDj tbody tr').allInnerTexts();
      const mm = String(mes).padStart(2, '0');
      const delPeriodo = filas.filter((t) => new RegExp(`${anio}\\D?${mm}|${mm}\\D?${anio}`).test(t));
      console.log('  Listado de DDJJ:');
      (delPeriodo.length ? delPeriodo : filas).forEach((t) => console.log(`    ${t.replace(/\s+/g, ' ').trim()}`));
    }, 'Puede que la DJ se haya cerrado igual: revisá "Listado de DDJJ" ANTES de volver a correr el script.');
    await guardarPantalla('despues_de_cerrar');
    await ask('Revisá el resultado en el navegador (y generá el VEP si corresponde). Enter para cerrar... ');
  }
} catch (err) {
  console.error(`\n${err.message}`);
  await ask('Hubo un error, el navegador queda abierto para inspeccionar. Enter para cerrar... ');
  process.exitCode = 1;
} finally {
  await browser.close();
}

// Runs one step; on failure saves a screenshot plus every frame's HTML to debug/.
async function step(name, fn, aviso) {
  console.log(`→ ${name}`);
  alertas.length = 0;
  try {
    await fn();
    if (alertas.length) throw new Error(`SIFERE mostró: ${alertas.join(' / ')}`);
  } catch (err) {
    const base = await guardarPantalla(name);
    throw new Error(`Falló el paso "${name}" (capturas: ${base}.*): ${err.message}${aviso ? `\n\n⚠️  ${aviso}` : ''}`);
  }
}

async function guardarPantalla(nombre) {
  mkdirSync('debug', { recursive: true });
  const base = `debug/${Date.now()}_${nombre.replace(/[^\w-]+/g, '_')}`;
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  await Promise.all(page.frames().map((f, i) => f.content()
    .then((html) => writeFileSync(`${base}_frame${i}.html`, `<!-- ${f.url()} -->\n${html}`))
    .catch(() => {})));
  return base;
}

// Inside a DJ, each section is shown in the right-hand <iframe>; navigating it directly is more
// predictable than clicking the tree (several items share the same text, e.g. per jurisdiction).
function panel() {
  return page.frames().find((f) => f.parentFrame() === page.mainFrame() && !/googletagmanager|youtube/.test(f.url()));
}

async function abrirPanel(ruta) {
  const f = panel();
  await f.goto(new URL(ruta, page.url()).href);
  await f.waitForLoadState();
  return f;
}

// Deducciones live in a separate app (deducciones.comarb.gob.ar) that sometimes fails on first load with
// "Error cargando la DJ" and a "Reintentar" button.
async function panelDeducciones() {
  const inicio = Date.now();
  for (let intento = 1; intento <= 3; intento++) {
    // poll the frames' actual URLs: the tree loads the panel into the existing <iframe> without changing
    // its src attribute, so waiting on the attribute always ran into its 30s timeout
    let f;
    for (let t = 0; t < 60 && !f; t++) {
      f = page.frames().find((fr) => fr.url().includes('deducciones.comarb.gob.ar'));
      if (!f) await page.waitForTimeout(500);
    }
    if (!f) throw new Error('No se abrió el panel de deducciones');
    // not "networkidle": this app keeps analytics requests going, so that wait was the slow part
    const listo = f.getByRole('button', { name: 'Actualizar deducciones' });
    if (await listo.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
      console.log(`  deducciones: panel cargado a los ${Math.round((Date.now() - inicio) / 1000)}s`);
      return f;
    }
    const reintentar = f.getByRole('button', { name: 'Reintentar' });
    if (await reintentar.isVisible().catch(() => false)) {
      console.log(`  deducciones: error de carga, reintento ${intento}`);
      await reintentar.click();
    }
  }
  throw new Error('El panel de deducciones no cargó después de 3 intentos');
}

// Clicks a deducciones button, answers its PrimeFaces "¿Desea Continuar?" with "Sí", and closes the
// "Estado del proceso: FINALIZADO" dialog if one appears.
async function confirmarDeducciones(f, boton) {
  // a click before PrimeFaces finished initializing does nothing, so wait for it and retry if the
  // "¿Desea Continuar?" dialog doesn't open (not document.readyState: slow analytics scripts delay it ~30s)
  await f.waitForFunction(() => window.PrimeFaces);
  const dialogo = f.locator('.ui-confirm-dialog').filter({ visible: true });
  for (let intento = 1; ; intento++) {
    console.log(`  deducciones: "${boton}"${intento > 1 ? ` (intento ${intento})` : ''}`);
    await f.getByRole('button', { name: boton }).click();
    if (await dialogo.waitFor({ timeout: 5_000 }).then(() => true, () => false)) break;
    if (intento === 3) throw new Error(`"${boton}" no abrió la confirmación después de 3 intentos`);
  }
  console.log(`  deducciones: ${(await dialogo.innerText()).replace(/\s+/g, ' ').trim()} → Sí`);
  await dialogo.locator('.ui-confirmdialog-yes').click();
  console.log('  deducciones: esperando el resultado');
  const inicio = Date.now();
  const segundos = () => Math.round((Date.now() - inicio) / 1000);
  // wait for the button's own ajax request to finish (the app keeps analytics traffic going, so
  // "networkidle" never comes)
  await f.waitForTimeout(1_000);
  await f.waitForFunction(() => window.PrimeFaces?.ajax?.Queue?.isEmpty?.() ?? true, null, { timeout: 120_000 });
  // "Incluir" then reports progress in a nested dialog iframe (confirmarCopiaSifere.xhtml) with
  // "Estado del proceso: ..." and a "Cerrar" button; "Actualizar" shows nothing
  let resultado = null;
  for (let t = 0; t < 10 && !resultado; t++) {
    resultado = f.childFrames().find((c) => c.url().includes('confirmarCopiaSifere'));
    if (!resultado) await f.waitForTimeout(500);
  }
  if (!resultado) {
    console.log(`  deducciones: terminado a los ${segundos()}s`);
  } else {
    let estado;
    while (segundos() < 180) {
      estado = (await resultado.locator('body').innerText().catch(() => '')).match(/Estado del proceso:\s*(\S+)/)?.[1];
      if (estado && !/PROCES|PENDIENTE|INICIADO/i.test(estado)) break;
      await f.waitForTimeout(1_000);
    }
    console.log(`  deducciones: estado ${estado ?? '?'} a los ${segundos()}s`);
    if (estado !== 'FINALIZADO') throw new Error(`"${boton}" terminó con estado ${estado ?? 'desconocido'}`);
    await resultado.getByRole('button', { name: 'Cerrar' }).click();
  }
  // the deducciones app keeps analytics requests going, so "networkidle" may never come; don't wait on it
  await f.waitForLoadState('load');
  console.log(`  deducciones: "${boton}" listo`);
}

// SIFERE reports problems with SweetAlert popups or Bootstrap alerts inside the panel.
async function mensajesVisibles(f) {
  const textos = await f.locator('.swal2-popup, .alert-danger, .alert-warning, .alert-success, .alert-info')
    .filter({ visible: true }).allInnerTexts().catch(() => []);
  return textos.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
}

async function revisarMensajes(f) {
  const error = await f.locator('.swal2-icon-error, .swal2-icon-warning, .alert-danger').filter({ visible: true }).count();
  if (error) throw new Error(`SIFERE mostró: ${await mensajesVisibles(f)}`);
}

// Selects by trimmed visible text or value (SIFERE pads some option labels with spaces).
async function elegir(f, selector, valor) {
  const valorOpcion = await f.locator(`${selector} option`).evaluateAll(
    (os, v) => os.find((o) => o.label.trim() === v || o.value === v)?.value, valor);
  if (valorOpcion === undefined) throw new Error(`"${valor}" no está en ${selector}`);
  await f.selectOption(selector, valorOpcion);
}

// Splits the amount by percentage; the last jurisdiction takes the remainder so the parts add up exactly.
function repartir(total, jurisdicciones) {
  const centavos = Math.round(total * 100);
  const partes = jurisdicciones.map((j) => Math.round((centavos * j.porcentaje) / 100));
  partes[partes.length - 1] = centavos - partes.slice(0, -1).reduce((a, b) => a + b, 0);
  return partes.map((c) => c / 100);
}

// "2026-10" → { anio: 2026, mes: 10 }; defaults to the previous month.
function periodo(yyyymm) {
  if (yyyymm) {
    const [anio, mes] = yyyymm.split('-').map(Number);
    return { anio, mes };
  }
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return { anio: d.getFullYear(), mes: d.getMonth() + 1 };
}

function pesos(n, simbolo = true) {
  const s = n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return simbolo ? `$ ${s}` : s;
}

function fmtCuit(c) {
  return `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
}
