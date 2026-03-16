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
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 20000,
    maxRedirects: 10,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-AR,es;q=0.9'
    }
  }));
}

async function mevLogin(client, usuario, clave) {
  console.log('[MEV] GET loguin...');
  await client.get(BASE + '/loguin.asp');
  const params = new URLSearchParams();
  params.append('usuario', usuario);
  params.append('clave', clave);
  params.append('DeptoRegistrado', 'aa');
  const r = await client.post(BASE + '/loguin.asp?familiadepto=', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/loguin.asp' }
  });
  const body = (r.data || '').toString();
  const lower = body.toLowerCase();
  if (lower.includes('clave incorrecta') || lower.includes('usuario o clave') || lower.includes('datos incorrectos')) {
    throw new Error('Credenciales incorrectas.');
  }
  console.log('[MEV] Login OK');
  return body;
}

async function selectDepto(client, deptoId) {
  const params = new URLSearchParams();
  params.append('TipoDto', 'CC');
  params.append('DtoJudElegido', deptoId);
  params.append('Aceptar', 'Aceptar');
  const r = await client.post(BASE + '/POSLoguin.asp', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/POSLoguin.asp' }
  });
  return (r.data || '').toString();
}

function parseSets(html) {
  const $ = cheerio.load(html);
  const sets = [];
  $('select[name=SetNovedades] option').each((_, el) => {
    const val = $(el).attr('value');
    const txt = $(el).text().trim();
    if (val && val.trim()) sets.push({ id: val.trim(), nombre: txt });
  });
  return sets;
}

function parseResultados(html, setNombre) {
  const $ = cheerio.load(html);
  const causas = [];
  $('input[type=checkbox]').each((_, cb) => {
    const nidCausa = $(cb).attr('value');
    if (!nidCausa || !nidCausa.trim()) return;
    const hiddenInput = $(cb).next('input[type=hidden]');
    const juzgado = (hiddenInput.attr('value') || '').trim();
    const caratulaLink = hiddenInput.next('a');
    const caratula = caratulaLink.text().trim();
    const despachoLink = $(cb).parent().find('a[href*="procesales"]').last();
    const despacho = despachoLink.text().trim();
    causas.push({ nidCausa: nidCausa.trim(), juzgado, caratula, setNombre, despacho });
  });
  return causas;
}

async function scanMEV(opts) {
  const client = createClient();
  console.log('[MEV] Scan iniciado');
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

  let todas = [];
  for (const set of sets) {
    try {
      const url = BASE + '/resultados.asp?nidset=' + set.id +
        '&sfechadesde=' + encodeURIComponent(opts.fechaDesde) +
        '&sfechahasta=' + encodeURIComponent(opts.fechaHasta) +
        '&pOrden=xCa&pOrdenAD=Asc';
      const r = await client.get(url, { headers: { 'Referer': BASE + '/Busqueda.asp' } });
      const html = (r.data || '').toString();
      if (html.includes('No arroja resultados') || html.includes('sin causas')) {
        console.log('[MEV] ' + set.nombre + ': sin resultados');
        continue;
      }
      const causas = parseResultados(html, set.nombre);
      console.log('[MEV] ' + set.nombre + ': ' + causas.length + ' causas');
      todas = todas.concat(causas);
    } catch(e) {
      console.error('[MEV] Error set ' + set.nombre + ': ' + e.message);
    }
  }
  console.log('[MEV] Total: ' + todas.length);
  if (!todas.length) return { total: 0, emailEnviado: false };

  await sendEmail(todas, opts.emailDestino, opts.fechaDesde, opts.fechaHasta, opts.smtp);
  console.log('[MEV] Email enviado');
  return { total: todas.length, emailEnviado: true };
}

async function sendEmail(causas, to, desde, hasta, cfg) {
  const transporter = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    connectionTimeout: 10000, socketTimeout: 10000,
    auth: { user: cfg.user, pass: cfg.pass }
  });
  const rows = causas.map(c =>
    '<tr style="border-bottom:1px solid #eee">' +
    '<td style="padding:10px;font-size:13px;color:#333"><strong>' + (c.caratula || '-') + '</strong>' +
    '<br><span style="color:#888;font-size:11px">' + c.setNombre + ' | Causa: ' + c.nidCausa + '</span></td>' +
    '<td style="padding:10px;font-size:12px;color:#555">' + (c.despacho || '-') + '</td></tr>'
  ).join('');
  const html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:0;background:#f5f5f5">' +
    '<div style="background:#1a237e;padding:24px 32px;color:white"><h2 style="margin:0">Novedades MEV</h2>' +
    '<p style="margin:4px 0 0;opacity:.8;font-size:13px">Periodo: ' + desde + ' al ' + hasta + '</p></div>' +
    '<div style="padding:20px">' +
    '<table style="width:100%;background:white;border-radius:8px;border-collapse:collapse;box-shadow:0 1px 4px rgba(0,0,0,.1)">' +
    '<thead><tr style="background:#e8eaf6"><th style="padding:10px;text-align:left;font-size:12px;color:#1a237e">CARATULA</th>' +
    '<th style="padding:10px;text-align:left;font-size:12px;color:#1a237e">ULTIMO DESPACHO</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<p style="color:#aaa;font-size:11px;text-align:center;margin-top:16px">MEV Monitor &bull; ' + causas.length + ' causas</p></div>' +
    '</body></html>';
  await transporter.sendMail({
    from: '"MEV Monitor" <' + cfg.user + '>',
    to, subject: 'Novedades MEV — ' + desde + ' al ' + hasta, html
  });
}

const jobs = {};
function fmtDate(d) {
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}

app.post('/api/scan', async (req, res) => {
  const { usuario, password, fechaDesde, fechaHasta, emailDestino } = req.body;
  if (!usuario || !password || !emailDestino) return res.status(400).json({ error: 'Faltan campos' });
  const hoy = new Date();
  const desde = fechaDesde || fmtDate(new Date(hoy - 7*86400000));
  const hasta = fechaHasta || fmtDate(hoy);
  const smtp = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  };
  if (!smtp.user || !smtp.pass) return res.status(500).json({ error: 'SMTP no configurado' });
  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running' };
  scanMEV({ usuario, clave: password, fechaDesde: desde, fechaHasta: hasta, emailDestino, smtp })
    .then(result => { jobs[jobId] = { status: 'done', result }; })
    .catch(err => { jobs[jobId] = { status: 'error', error: err.message }; });
  res.json({ jobId, fechaDesde: desde, fechaHasta: hasta });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'No encontrado' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MEV Monitor puerto ' + PORT));
