const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const BASE = 'https://mev.scba.gov.ar';

function createClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar, withCredentials: true, timeout: 15000, maxRedirects: 10,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,*/*;q=0.8',
      'Accept-Language': 'es-AR,es;q=0.9'
    }
  }));
}

async function mevLogin(client, usuario, clave) {
  console.log('[MEV] Login...');
  await client.get(BASE + '/loguin.asp');
  const p = new URLSearchParams();
  p.append('usuario', usuario);
  p.append('clave', clave);
  p.append('DeptoRegistrado', 'aa');
  const r = await client.post(BASE + '/loguin.asp?familiadepto=', p.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/loguin.asp' }
  });
  const body = (r.data || '').toString();
  const lower = body.toLowerCase();
  if (lower.includes('clave incorrecta') || lower.includes('datos incorrectos') || lower.includes('usuario o clave')) {
    throw new Error('Credenciales incorrectas.');
  }
  console.log('[MEV] Login OK');
  return body;
}

async function selectDepto(client, deptoId) {
  const p = new URLSearchParams();
  p.append('TipoDto', 'CC');
  p.append('DtoJudElegido', deptoId);
  p.append('Aceptar', 'Aceptar');
  const r = await client.post(BASE + '/POSLoguin.asp', p.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/POSLoguin.asp' }
  });
  return (r.data || '').toString();
}

function parseSets(html) {
  const $ = cheerio.load(html);
  const sets = [];
  $('select[name=SetNovedades] option').each((_, el) => {
    const val = $(el).attr('value');
    if (val && val.trim()) sets.push({ id: val.trim(), nombre: $(el).text().trim() });
  });
  return sets;
}

function parseOrganismos(html) {
  const $ = cheerio.load(html);
  const orgs = [];
  $('select[name=JuzgadoElegido] option').each((_, el) => {
    const val = $(el).attr('value');
    if (val && val.trim()) orgs.push({ codigo: val.trim(), nombre: $(el).text().trim() });
  });
  return orgs;
}

function parseResultados(html, setNombre) {
  const $ = cheerio.load(html);
  const causas = [];
  $('input[type=checkbox]').each((_, cb) => {
    const nidCausa = $(cb).attr('value');
    if (!nidCausa || !nidCausa.trim()) return;
    const hidden = $(cb).next('input[type=hidden]');
    const pidJuzgado = (hidden.attr('value') || '').trim();
    const caratula = hidden.next('a').text().trim();
    const despachoLink = $(cb).parent().find('a[href*="procesales"]').last();
    const despachoText = despachoLink.text().trim();
    const href = despachoLink.attr('href') || '';
    const linkDespacho = href ? (href.startsWith('http') ? href : BASE + '/' + href.replace(/^\//, '')) : '';
    const m = despachoText.match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(.+)$/);
    const despachoFecha = m ? m[1] : '';
    const despachoDesc = m ? m[2].trim() : despachoText;
    causas.push({ nidCausa: nidCausa.trim(), pidJuzgado, caratula, setNombre, despachoFecha, despachoDesc, linkDespacho });
  });
  return causas;
}

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}

// procesales.asp: 4 cols per data row: Fecha | Fojas | Firmado | Descripcion+link
// Use '> td' to get direct children only, avoiding nested table tds
async function getActuaciones(client, nidCausa, pidJuzgado, desde, hasta) {
  const url = BASE + '/procesales.asp?nidCausa=' + nidCausa + '&pidJuzgado=' + encodeURIComponent(pidJuzgado);
  // Short timeout - if MEV doesn't respond quickly, use fallback
  const r = await client.get(url, { timeout: 8000, headers: { 'Referer': BASE + '/resultados.asp' } });
  const $ = cheerio.load(r.data || '');
  const desdeDt = parseDate(desde);
  const hastaDt = parseDate(hasta);
  if (hastaDt) hastaDt.setHours(23, 59, 59);
  const acts = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('> td');
    if (cells.length !== 4) return;
    const fechaRaw = cells.eq(0).text().trim();
    const fechaMatch = fechaRaw.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (!fechaMatch) return;
    const fecha = fechaMatch[1];
    const d = parseDate(fecha);
    if (!d) return;
    if (desdeDt && d < desdeDt) return;
    if (hastaDt && d > hastaDt) return;
    const descCell = cells.eq(3);
    const desc = descCell.text().trim();
    if (!desc || desc === 'Descripcion' || desc === 'Fecha') return;
    const linkEl = descCell.find('a').first();
    const href = linkEl.attr('href') || '';
    const link = href ? (href.startsWith('http') ? href : BASE + '/' + href.replace(/^\//, '')) : '';
    acts.push({ fecha, descripcion: desc, link });
  });
  return acts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scanMEV(opts) {
  const client = createClient();
  await mevLogin(client, opts.usuario, opts.clave);
  let busHtml = await selectDepto(client, '6');
  if (!busHtml.includes('SetNovedades')) {
    const r = await client.get(BASE + '/Busqueda.asp', { headers: { 'Referer': BASE + '/POSLoguin.asp' } });
    busHtml = (r.data || '').toString();
  }
  if (!busHtml.includes('SetNovedades')) throw new Error('No se pudo acceder a busqueda.asp');

  const sets = parseSets(busHtml);
  console.log('[MEV] Sets: ' + sets.map(s => s.nombre).join(', '));
  if (!sets.length) throw new Error('No se encontraron sets');

  const todasCausas = [];
  const vistos = new Set();

  for (const set of sets) {
    console.log('[MEV] Set: ' + set.nombre);
    const urlBase = BASE + '/resultados.asp?nidset=' + set.id + '&sFechaDesde=&sFechaHasta=&pOrden=xCa&pOrdenAD=Asc';
    const r0 = await client.get(urlBase, { headers: { 'Referer': BASE + '/busqueda.asp' } });
    const organismos = parseOrganismos((r0.data || '').toString());
    console.log('[MEV] ' + set.nombre + ': ' + organismos.length + ' organismos');
    if (!organismos.length) continue;

    for (const org of organismos) {
      try {
        const p = new URLSearchParams();
        p.append('JuzgadoElegido', org.codigo);
        p.append('snrointerno', '');
        p.append('scaratula', '');
        p.append('menu1', 'resultados.asp?pagina=1&pOrden=xCa&pOrdenAD=Asc&pNroColumna=1');
        const postUrl = BASE + '/resultados.asp?sFechaDesde=' +
          encodeURIComponent(opts.fechaDesde) + '&sFechaHasta=' + encodeURIComponent(opts.fechaHasta);
        const r = await client.post(postUrl, p.toString(), {
          timeout: 8000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': urlBase }
        });
        const html = (r.data || '').toString();
        if (html.includes('No arroja resultados')) { await sleep(80); continue; }
        const causas = parseResultados(html, set.nombre);
        if (causas.length > 0) {
          console.log('[MEV] ' + org.nombre.trim() + ': ' + causas.length + ' causas');
          for (const c of causas) {
            if (!vistos.has(c.nidCausa)) { vistos.add(c.nidCausa); todasCausas.push(c); }
          }
        }
        await sleep(100);
      } catch(e) {
        // timeout or error on this organismo - skip silently
        await sleep(50);
      }
    }
    console.log('[MEV] ' + set.nombre + ' done. Acumulado: ' + todasCausas.length);
  }

  console.log('[MEV] Total causas: ' + todasCausas.length);
  if (!todasCausas.length) return { total: 0, emailEnviado: false };

  // Get actuaciones - with short timeout, use fallback if fails
  const resultado = [];
  for (const c of todasCausas) {
    let acts = [];
    try {
      acts = await getActuaciones(client, c.nidCausa, c.pidJuzgado, opts.fechaDesde, opts.fechaHasta);
      console.log('[MEV] ' + c.nidCausa + ': ' + acts.length + ' acts');
    } catch(e) {
      console.log('[MEV] ' + c.nidCausa + ' procesales timeout, usando fallback');
    }
    if (acts.length > 0) {
      resultado.push({ ...c, actuaciones: acts });
    } else {
      resultado.push({ ...c, actuaciones: [{ fecha: c.despachoFecha, descripcion: c.despachoDesc, link: c.linkDespacho }] });
    }
    await sleep(100);
  }

  await sendEmail(resultado, opts.emailDestino, opts.fechaDesde, opts.fechaHasta);
  console.log('[MEV] Email enviado OK');
  return { total: todasCausas.length, emailEnviado: true };
}

async function sendEmail(causas, to, desde, hasta) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY no configurado');
  const causaBlocks = causas.map(c => {
    const actRows = (c.actuaciones || []).map(a => {
      const linkHtml = a.link ? '<a href="' + a.link + '" style="color:#1565c0;font-weight:600;text-decoration:none" target="_blank">Ver</a>' : '';
      return '<tr><td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#1565c0;white-space:nowrap;vertical-align:top">' + (a.fecha || '--') + '</td><td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;vertical-align:top">' + (a.descripcion || '') + '</td><td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;text-align:center;vertical-align:top;width:50px">' + linkHtml + '</td></tr>';
    }).join('');
    const noActs = (!c.actuaciones || !c.actuaciones.length) ? '<tr><td colspan="3" style="padding:8px 10px;font-size:12px;color:#999;font-style:italic">Sin actuaciones en el periodo</td></tr>' : '';
    return '<div style="margin-bottom:16px;border:1px solid #ddd;border-radius:8px;overflow:hidden"><div style="background:#1a237e;padding:10px 14px"><div style="color:white;font-size:13px;font-weight:700">' + (c.caratula || 'Sin caratula') + '</div><div style="color:rgba(255,255,255,.7);font-size:11px;margin-top:2px">' + c.setNombre + ' - Causa ' + c.nidCausa + '</div></div><table style="width:100%;border-collapse:collapse;background:white"><tr style="background:#f5f5f5"><th style="padding:6px 10px;font-size:11px;color:#555;text-align:left;width:90px">FECHA</th><th style="padding:6px 10px;font-size:11px;color:#555;text-align:left">NOVEDAD</th><th style="padding:6px 10px;font-size:11px;color:#555;text-align:center;width:50px">DOC</th></tr>' + actRows + noActs + '</table></div>';
  }).join('');
  const html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:750px;margin:0 auto;background:#f0f2f5;padding:20px"><div style="background:#1a237e;padding:20px 24px;border-radius:8px 8px 0 0"><h2 style="margin:0;color:white;font-size:20px">Novedades MEV</h2><p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px">Periodo: ' + desde + ' al ' + hasta + '</p></div><div style="background:#e8eaf6;padding:10px 24px;border-radius:0 0 8px 8px;margin-bottom:16px"><strong>' + causas.length + '</strong> causa' + (causas.length !== 1 ? 's' : '') + ' con novedades</div>' + causaBlocks + '<p style="color:#aaa;font-size:11px;text-align:center;margin-top:8px">MEV Monitor - SCBA</p></body></html>';
  // Resend free plan: send one email per recipient
  const recipients = to.split(',').map(s => s.trim()).filter(Boolean);
  for (const recipient of recipients) {
  const resp = await axios.post('https://api.resend.com/emails', {
    from: 'MEV Monitor <onboarding@resend.dev>',
    to: [recipient],
    subject: 'Novedades MEV - ' + desde + ' al ' + hasta + ' (' + causas.length + ' causas)',
    html
  }, { headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, timeout: 15000 });
  if (resp.status >= 400) throw new Error('Resend error: ' + JSON.stringify(resp.data));
  console.log('[MEV] Resend OK id: ' + resp.data.id);
  } // end recipients loop
}

const jobs = {};
function fmtDate(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}
app.post('/api/scan', async (req, res) => {
  const { usuario, password, fechaDesde, fechaHasta, emailDestino } = req.body;
  if (!usuario || !password || !emailDestino) return res.status(400).json({ error: 'Faltan campos' });
  const hoy = new Date();
  const desde = fechaDesde || fmtDate(new Date(hoy - 7 * 86400000));
  const hasta = fechaHasta || fmtDate(hoy);
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });
  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running' };
  scanMEV({ usuario, clave: password, fechaDesde: desde, fechaHasta: hasta, emailDestino })
    .then(result => { console.log('[MEV] done: ' + JSON.stringify(result)); jobs[jobId] = { status: 'done', result }; })
    .catch(err => { console.error('[MEV] error: ' + err.message); jobs[jobId] = { status: 'error', error: err.message }; });
  res.json({ jobId, fechaDesde: desde, fechaHasta: hasta });
});
app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'No encontrado' });
  res.json(job);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MEV Monitor puerto ' + PORT));
