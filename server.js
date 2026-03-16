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
    jar, withCredentials: true, timeout: 20000, maxRedirects: 10,
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

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
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
    causas.push({ nidCausa: nidCausa.trim(), pidJuzgado, caratula, setNombre });
  });
  return causas;
}

async function getActuaciones(client, nidCausa, pidJuzgado, desde, hasta) {
  const url = BASE + '/procesales.asp?nidCausa=' + nidCausa + '&pidJuzgado=' + encodeURIComponent(pidJuzgado);
  const r = await client.get(url, { timeout: 12000, headers: { 'Referer': BASE + '/resultados.asp' } });
  const $ = cheerio.load(r.data || '');
  const desdeDt = parseDate(desde);
  const hastaDt = parseDate(hasta);
  if (hastaDt) hastaDt.setHours(23, 59, 59);

  const acts = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const fecha = cells.eq(0).text().trim();
    if (!/\d{2}\/\d{2}\/\d{4}/.test(fecha)) return;
    const d = parseDate(fecha);
    if (!d) return;
    if (desdeDt && d < desdeDt) return;
    if (hastaDt && d > hastaDt) return;

    const cell1 = cells.eq(1);
    const desc = cell1.text().trim();
    if (!desc || desc.includes('Fecha') || desc.includes('Actuacion')) return;

    // Extract link if present
    const link = cell1.find('a').first();
    let href = '';
    if (link.length) {
      const rawHref = link.attr('href') || '';
      href = rawHref.startsWith('http') ? rawHref : (rawHref ? BASE + '/' + rawHref.replace(/^\//, '') : '');
    }

    acts.push({ fecha, descripcion: desc, link: href });
  });
  return acts;
}

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

  let todasCausas = [];
  for (const set of sets) {
    try {
      const url = BASE + '/resultados.asp?nidset=' + set.id +
        '&sfechadesde=' + encodeURIComponent(opts.fechaDesde) +
        '&sfechahasta=' + encodeURIComponent(opts.fechaHasta) + '&pOrden=xCa&pOrdenAD=Asc';
      const r = await client.get(url, { headers: { 'Referer': BASE + '/Busqueda.asp' } });
      const html = (r.data || '').toString();
      if (html.includes('No arroja resultados')) {
        console.log('[MEV] ' + set.nombre + ': sin resultados');
        continue;
      }
      const causas = parseResultados(html, set.nombre);
      console.log('[MEV] ' + set.nombre + ': ' + causas.length + ' causas');
      todasCausas = todasCausas.concat(causas);
    } catch(e) {
      console.error('[MEV] Error ' + set.nombre + ': ' + e.message);
    }
  }

  console.log('[MEV] Total causas: ' + todasCausas.length);
  if (!todasCausas.length) return { total: 0, emailEnviado: false };

  // Fetch actuaciones for each causa
  const resultado = [];
  for (const c of todasCausas) {
    try {
      const acts = await getActuaciones(client, c.nidCausa, c.pidJuzgado, opts.fechaDesde, opts.fechaHasta);
      console.log('[MEV] ' + c.nidCausa + ': ' + acts.length + ' actuaciones');
      resultado.push({ ...c, actuaciones: acts });
    } catch(e) {
      console.log('[MEV] procesales ' + c.nidCausa + ' fallback: ' + e.message);
      resultado.push({ ...c, actuaciones: [] });
    }
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
      const linkHtml = a.link
        ? '<a href="' + a.link + '" style="color:#1565c0;text-decoration:none;font-weight:600" target="_blank">Ver documento</a>'
        : '';
      return '<tr>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#1565c0;white-space:nowrap;vertical-align:top">' + a.fecha + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;vertical-align:top">' + a.descripcion + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;vertical-align:top;text-align:center">' + linkHtml + '</td>' +
        '</tr>';
    }).join('');

    const noActsMsg = (!c.actuaciones || !c.actuaciones.length)
      ? '<tr><td colspan="3" style="padding:8px 10px;font-size:12px;color:#999;font-style:italic">Sin actuaciones detalladas en el periodo</td></tr>'
      : '';

    return '<div style="margin-bottom:20px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">' +
      '<div style="background:#1a237e;padding:10px 14px">' +
      '<div style="color:white;font-size:13px;font-weight:700">' + (c.caratula || 'Sin carátula') + '</div>' +
      '<div style="color:rgba(255,255,255,0.7);font-size:11px;margin-top:2px">' + c.setNombre + ' &bull; Causa: ' + c.nidCausa + '</div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;background:white">' +
      '<tr style="background:#f5f5f5">' +
      '<th style="padding:7px 10px;text-align:left;font-size:11px;color:#555;width:90px">FECHA</th>' +
      '<th style="padding:7px 10px;text-align:left;font-size:11px;color:#555">NOVEDAD</th>' +
      '<th style="padding:7px 10px;text-align:center;font-size:11px;color:#555;width:100px">DOCUMENTO</th>' +
      '</tr>' +
      actRows + noActsMsg +
      '</table></div>';
  }).join('');

  const html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:750px;margin:0 auto;background:#f0f2f5;padding:20px">' +
    '<div style="background:#1a237e;padding:20px 24px;border-radius:8px 8px 0 0">' +
    '<h2 style="margin:0;color:white;font-size:20px">Novedades MEV</h2>' +
    '<p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px">Período: ' + desde + ' al ' + hasta + '</p></div>' +
    '<div style="background:#e8eaf6;padding:10px 24px;border-radius:0 0 8px 8px;margin-bottom:16px">' +
    '<span style="font-size:13px;color:#1a237e"><strong>' + causas.length + '</strong> causa' + (causas.length !== 1 ? 's' : '') + ' con novedades</span>' +
    '</div>' +
    causaBlocks +
    '<p style="color:#aaa;font-size:11px;text-align:center;margin-top:8px">MEV Monitor &bull; SCBA</p>' +
    '</body></html>';

  const resp = await axios.post('https://api.resend.com/emails', {
    from: 'MEV Monitor <onboarding@resend.dev>',
    to: [to],
    subject: 'Novedades MEV - ' + desde + ' al ' + hasta + ' (' + causas.length + ' causas)',
    html: html
  }, {
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    timeout: 15000
  });

  if (resp.status >= 400) throw new Error('Resend error: ' + JSON.stringify(resp.data));
  console.log('[MEV] Resend OK id: ' + resp.data.id);
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
