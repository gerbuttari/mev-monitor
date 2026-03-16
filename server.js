const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const BASE = 'https://mev.scba.gov.ar';

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    maxRedirects: 10,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-AR,es;q=0.9',
    }
  }));
  return client;
}

async function mevLogin(client, usuario, clave) {
  console.log('[MEV] GET loguin.asp...');
  await client.get(BASE + '/loguin.asp');
  console.log('[MEV] POST login...');
  const params = new URLSearchParams();
  params.append('usuario', usuario);
  params.append('clave', clave);
  params.append('DeptoRegistrado', 'aa');
  const r2 = await client.post(
    BASE + '/loguin.asp?familiadepto=',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/loguin.asp' } }
  );
  const finalUrl = r2.request && r2.request.res && r2.request.res.responseUrl ? r2.request.res.responseUrl : (r2.config ? r2.config.url : '');
  const body = (r2.data || '').toString();
  const lower = body.toLowerCase();
  console.log('[MEV] Login response URL: ' + finalUrl);
  if (
    finalUrl.includes('AvisoERROR') ||
    finalUrl.includes('Error') ||
    lower.includes('clave incorrecta') ||
    lower.includes('usuario o clave') ||
    lower.includes('datos incorrectos')
  ) {
    throw new Error('Credenciales incorrectas.');
  }
  if (!finalUrl.includes('POSLoguin') && !body.includes('POSLoguin') && !body.includes('Seleccione el Organismo')) {
    if (r2.status >= 400) throw new Error('Error al iniciar sesion (HTTP ' + r2.status + ')');
  }
  console.log('[MEV] Login OK');
  return body;
}

async function selectDepto(client, posLoguinHtml, deptoId) {
  const params = new URLSearchParams();
  params.append('TipoDto', 'CC');
  params.append('DtoJudElegido', deptoId);
  params.append('Aceptar', 'Aceptar');
  const r = await client.post(
    BASE + '/POSLoguin.asp',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/POSLoguin.asp' } }
  );
  const finalUrl = r.request && r.request.res && r.request.res.responseUrl ? r.request.res.responseUrl : '';
  console.log('[MEV] Select depto -> ' + finalUrl);
  return (r.data || '').toString();
}

function parseSets(html) {
  const $ = cheerio.load(html);
  const sets = [];
  $('select[name=SetNovedades] option').each((_, el) => {
    const val = $(el).attr('value');
    const txt = $(el).text().trim();
    if (val && val.trim() !== '') sets.push({ id: val.trim(), nombre: txt });
  });
  return sets;
}

async function getResultados(client, nidset, desde, hasta) {
  const url = BASE + '/resultados.asp?nidset=' + nidset + '&sfechadesde=' + encodeURIComponent(desde) + '&sfechahasta=' + encodeURIComponent(hasta) + '&pOrden=xCa&pOrdenAD=Asc';
  const r = await client.get(url, { headers: { 'Referer': BASE + '/Busqueda.asp' } });
  return (r.data || '').toString();
}

function parseResultados(html, setNombre) {
  const $ = cheerio.load(html);
  const causas = [];
  $('input[type=checkbox]').each((_, cb) => {
    const nidCausa = $(cb).attr('value');
    if (!nidCausa || nidCausa.trim() === '') return;
    const juzgadoInput = $(cb).next('input[type=hidden]');
    const juzgado = juzgadoInput.attr('value') ? juzgadoInput.attr('value').trim() : '';
    const caratulaLink = juzgadoInput.next('a');
    const caratula = caratulaLink.text().trim();
    const despachoLink = $(cb).parent().find('a[href*="procesales"]').last();
    const despacho = despachoLink.find('font, span, *').text().trim() || despachoLink.text().trim();
    causas.push({
      nidCausa: nidCausa.trim(),
      pidJuzgado: juzgado,
      caratula: caratula,
      setNombre: setNombre,
      ultimoDespacho: despacho
    });
  });
  return causas;
}

async function getActuaciones(client, nidCausa, pidJuzgado, desde, hasta) {
  const url = BASE + '/procesales.asp?nidCausa=' + nidCausa + '&pidJuzgado=' + encodeURIComponent(pidJuzgado);
  const r = await client.get(url, { timeout: 10000, headers: { 'Referer': BASE + '/resultados.asp' } });
  const $ = cheerio.load(r.data || '');
  const acts = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    const fecha = cells.eq(0).text().trim();
    const desc = cells.eq(1).text().trim();
    if (/\d{2}\/\d{2}\/\d{4}/.test(fecha) && desc && !desc.includes('Fecha')) {
      acts.push({ fecha: fecha, descripcion: desc });
    }
  });
  const desdeDt = parseDate(desde);
  const hastaDt = parseDate(hasta);
  if (hastaDt) hastaDt.setHours(86399999);
  return acts.filter(function(a) {
    const d = parseDate(a.fecha);
    if (!d) return false;
    return (!desdeDt || d >= desdeDt) && (!hastaDt || d <= hastaDt);
  });
}

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}

const sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

async function scanMEV(opts) {
  const client = createClient();
  console.log('[MEV] Iniciando scan');
  const posHtml = await mevLogin(client, opts.usuario, opts.clave);
  let busquedaHtml = await selectDepto(client, posHtml, '6');
  if (!busquedaHtml.includes('SetNovedades')) {
    console.log('[MEV] GET directo busqueda');
    const r = await client.get(BASE + '/Busqueda.asp', { headers: { 'Referer': BASE + '/POSLoguin.asp' } });
    busquedaHtml = (r.data || '').toString();
  }
  if (!busquedaHtml.includes('SetNovedades')) throw new Error('No se pudo acceder a busqueda.asp');
  const sets = parseSets(busquedaHtml);
  console.log('[MEV] Sets encontrados: ' + sets.map(function(s) { return s.nombre; }).join(', '));
  if (sets.length === 0) throw new Error('No se encontraron sets');
  let todas = [];
  for (const set of sets) {
    try {
      console.log('[MEV] Consultando set: ' + set.nombre);
      const html = await getResultados(client, set.id, opts.fechaDesde, opts.fechaHasta);
      if (html.includes('No arroja resultados')) {
        console.log('[MEV] ' + set.nombre + ': sin resultados');
        continue;
      }
      const causas = parseResultados(html, set.nombre);
      console.log('[MEV] ' + set.nombre + ': ' + causas.length + ' causas');
      todas = todas.concat(causas);
      await sleep(300);
    } catch(e) {
      console.error('[MEV] Error set ' + set.nombre + ': ' + e.message);
    }
  }
  console.log('[MEV] Total causas: ' + todas.length);
  if (todas.length === 0) return { total: 0, conNovedades: 0, emailEnviado: false };
  const det = [];
  for (const c of todas) {
    try {
      const acts = await getActuaciones(client, c.nidCausa, c.pidJuzgado, opts.fechaDesde, opts.fechaHasta);
      console.log('[MEV] procesales ' + c.nidCausa + ': ' + acts.length + ' acts');
      det.push(Object.assign({}, c, { actuaciones: acts.length > 0 ? acts : [{ fecha: '', descripcion: c.ultimoDespacho }] }));
      await sleep(200);
    } catch(e) {
      console.log('[MEV] procesales ' + c.nidCausa + ' error (usando despacho): ' + e.message);
      det.push(Object.assign({}, c, { actuaciones: [{ fecha: '', descripcion: c.ultimoDespacho }] }));
    }
  }
  console.log('[MEV] Enviando email a ' + opts.emailDestino);
  await sendEmail(det, opts.emailDestino, opts.fechaDesde, opts.fechaHasta, opts.smtpConfig);
  console.log('[MEV] Email enviado OK');
  return { total: todas.length, conNovedades: det.length, emailEnviado: true };
}

async function sendEmail(causas, to, desde, hasta, cfg) {
  const t = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 587,
    secure: cfg.secure || false,
    connectionTimeout: 15000,
    socketTimeout: 15000,
    auth: { user: cfg.user, pass: cfg.pass }
  });
  await t.sendMail({
    from: '"MEV Monitor" <' + cfg.user + '>',
    to: to,
    subject: 'Novedades MEV — ' + desde + ' al ' + hasta,
    html: buildHtml(causas, desde, hasta)
  });
}

function buildHtml(causas, desde, hasta) {
  const rows = causas.map(function(c) {
    const f = (c.actuaciones || []).map(function(a) {
      return '<tr><td style="padding:5px 8px;border:1px solid #ddd;color:#1565c0;white-space:nowrap">' + (a.fecha || '—') + '</td><td style="padding:5px 8px;border:1px solid #ddd">' + a.descripcion + '</td></tr>';
    }).join('');
    return '<div style="margin:16px 0;padding:14px;border:1px solid #e0e0e0;border-radius:8px;background:#fff">' +
      '<div style="font-size:11px;color:#888;margin-bottom:4px">' + c.setNombre + '</div>' +
      '<h3 style="margin:0 0 4px;color:#1a237e;font-size:14px">' + (c.caratula || 'Sin caratula') + '</h3>' +
      '<p style="margin:0 0 8px;color:#888;font-size:12px">Causa: ' + c.nidCausa + '</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<tr style="background:#f5f5f5"><th style="padding:5px 8px;border:1px solid #ddd;text-align:left;width:120px">Fecha</th>' +
      '<th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Actuacion</th></tr>' +
      f + '</table></div>';
  }).join('');
  return '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;background:#f5f5f5">' +
    '<div style="background:#1a237e;color:white;padding:20px;border-radius:8px 8px 0 0">' +
    '<h2 style="margin:0">Novedades MEV</h2>' +
    '<p style="margin:6px 0 0;opacity:.85;font-size:13px">Periodo: ' + desde + ' - ' + hasta + '</p></div>' +
    '<div style="background:#e8eaf6;padding:12px 20px;margin-bottom:8px;border-radius:0 0 8px 8px">' +
    '<strong>' + causas.length + '</strong> causa' + (causas.length !== 1 ? 's' : '') + ' con novedades</div>' +
    rows +
    '<p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px">MEV Monitor</p>' +
    '</body></html>';
}

const jobs = {};
function formatDate(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

app.post('/api/scan', async function(req, res) {
  const usuario = req.body.usuario;
  const password = req.body.password;
  const fechaDesde = req.body.fechaDesde;
  const fechaHasta = req.body.fechaHasta;
  const emailDestino = req.body.emailDestino;
  if (!usuario || !password || !emailDestino) return res.status(400).json({ error: 'Faltan campos' });
  const hoy = new Date();
  const desde = fechaDesde || formatDate(new Date(hoy - 7 * 86400000));
  const hasta = fechaHasta || formatDate(hoy);
  const cfg = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  };
  if (!cfg.user || !cfg.pass) return res.status(500).json({ error: 'SMTP no configurado' });
  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running', startedAt: new Date().toISOString() };
  scanMEV({ usuario: usuario, clave: password, fechaDesde: desde, fechaHasta: hasta, emailDestino: emailDestino, smtpConfig: cfg })
    .then(function(result) {
      console.log('[MEV] Job done: ' + JSON.stringify(result));
      jobs[jobId] = { status: 'done', result: result };
    })
    .catch(function(err) {
      console.error('[MEV] Job error: ' + err.message);
      jobs[jobId] = { status: 'error', error: err.message };
    });
  res.json({ jobId: jobId, message: 'Scan iniciado', fechaDesde: desde, fechaHasta: hasta });
});

app.get('/api/status/:id', function(req, res) {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('MEV Monitor en puerto ' + PORT); });
