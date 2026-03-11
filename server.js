const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const MEV_BASE = 'https://mev.scba.gov.ar';

async function mevLogin(usuario, password) {
  const r1 = await axios.get(`${MEV_BASE}/loguin.asp`, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const setCookie1 = r1.headers['set-cookie'] || [];
  const sessionCookie = setCookie1.map(c => c.split(';')[0]).join('; ');

  const params = new URLSearchParams();
  params.append('Usuario', usuario);
  params.append('Password', password);
  params.append('Ingresar', 'Ingresar');

  const r2 = await axios.post(`${MEV_BASE}/loguin.asp`, params.toString(), {
    timeout: 30000,
    maxRedirects: 0,
    validateStatus: s => s < 400,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sessionCookie,
      'User-Agent': 'Mozilla/5.0',
      'Referer': `${MEV_BASE}/loguin.asp`
    }
  });

  const setCookie2 = r2.headers['set-cookie'] || [];
  const allCookies = [...setCookie1, ...setCookie2]
    .map(c => c.split(';')[0])
    .filter((v, i, a) => a.findIndex(x => x.split('=')[0] === v.split('=')[0]) === i)
    .join('; ');

  const r3 = await axios.get(`${MEV_BASE}/`, {
    timeout: 30000,
    headers: { 'Cookie': allCookies, 'User-Agent': 'Mozilla/5.0' }
  });

  if (r3.request.path && r3.request.path.includes('loguin')) {
    throw new Error('Credenciales incorrectas');
  }

  return allCookies;
}

async function getOrganismos(cookie) {
  const r = await axios.get(`${MEV_BASE}/menu.asp`, {
    timeout: 30000,
    headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(r.data);
  const organismos = [];

  $('select[name="organismo"] option, select option').each((_, el) => {
    const val = $(el).attr('value');
    const text = $(el).text().trim();
    if (val && val !== '' && val !== '0') {
      organismos.push({ id: val, nombre: text });
    }
  });

  if (organismos.length === 0) {
    $('a[href*="organismo="], a[href*="nidOrganismo="]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/[Oo]rganismo[=]([^&]+)/);
      if (match) organismos.push({ id: match[1], nombre: $(el).text().trim() });
    });
  }

  return organismos;
}

async function getCausasByOrganismo(cookie, organismoId) {
  const url = `${MEV_BASE}/causas.asp?nidOrganismo=${organismoId}`;
  const r = await axios.get(url, {
    timeout: 60000,
    headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0', 'Referer': `${MEV_BASE}/menu.asp` }
  });
  return r.data;
}

function parseCausas(html, organismoId) {
  const $ = cheerio.load(html);
  const causas = [];

  if (!html.includes('nidCausa') && !html.includes('procesales')) return causas;

  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const link = $(row).find('a[href*="nidCausa"], a[href*="procesales"]').first();
    if (!link.length) return;
    const href = link.attr('href') || '';
    const nidMatch = href.match(/nidCausa[=]([^&]+)/i);
    const nid = nidMatch ? nidMatch[1].trim() : null;
    if (!nid) return;
    causas.push({
      nidCausa: nid,
      caratula: cells.eq(0).text().trim() || cells.eq(1).text().trim(),
      pidJuzgado: cells.eq(1).text().trim() || cells.eq(2).text().trim(),
      ultimaNovedad: cells.last().text().trim(),
      organismoId
    });
  });

  if (causas.length === 0) {
    const datePattern = /\d{2}\/\d{2}\/\d{4}/;
    $('tr').each((_, row) => {
      const text = $(row).text();
      if (!datePattern.test(text)) return;
      const link = $(row).find('a').first();
      const href = link.attr('href') || '';
      const nidMatch = href.match(/nidCausa[=]([^&\s]+)/i);
      if (!nidMatch) return;
      const cells = $(row).find('td');
      causas.push({
        nidCausa: nidMatch[1].trim(),
        caratula: cells.eq(0).text().trim(),
        pidJuzgado: cells.eq(1).text().trim(),
        ultimaNovedad: text.match(datePattern)?.[0] || '',
        organismoId
      });
    });
  }
  return causas;
}

async function getActuacionesCausa(cookie, nidCausa) {
  const url = `${MEV_BASE}/procesales.asp?nidCausa=${nidCausa}`;
  const r = await axios.get(url, { timeout: 60000, headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(r.data);
  const actuaciones = [];
  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const texto = cells.eq(0).text().trim();
    const fecha = cells.eq(1).text().trim();
    const dateMatch = fecha.match(/\d{2}\/\d{2}\/\d{4}/);
    if (dateMatch && texto) actuaciones.push({ fecha: dateMatch[0], descripcion: texto });
  });
  return actuaciones;
}

function parseDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function isInRange(dateStr, desde, hasta) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const desdeD = parseDate(desde);
  const hastaD = parseDate(hasta);
  hastaD?.setHours(23, 59, 59);
  return (!desdeD || d >= desdeD) && (!hastaD || d <= hastaD);
}

async function scanMEV({ usuario, password, fechaDesde, fechaHasta, emailDestino, smtpConfig }) {
  console.log(`[MEV] Iniciando scan para ${usuario}...`);
  const cookie = await mevLogin(usuario, password);
  console.log('[MEV] Login OK');
  const organismos = await getOrganismos(cookie);
  console.log(`[MEV] ${organismos.length} organismos encontrados`);
  if (organismos.length === 0) throw new Error('No se encontraron organismos.');

  const todasLasCausas = [];
  for (const org of organismos) {
    try {
      const html = await getCausasByOrganismo(cookie, org.id);
      const causas = parseCausas(html, org.id);
      console.log(`[MEV] Organismo ${org.nombre}: ${causas.length} causas`);
      todasLasCausas.push(...causas);
      await sleep(500);
    } catch (e) { console.error(`[MEV] Error organismo ${org.id}: ${e.message}`); }
  }

  const causasConNovedades = todasLasCausas.filter(c => isInRange(c.ultimaNovedad, fechaDesde, fechaHasta));
  console.log(`[MEV] ${causasConNovedades.length} causas con novedades`);

  const causasDetalladas = [];
  for (const causa of causasConNovedades) {
    try {
      const actuaciones = await getActuacionesCausa(cookie, causa.nidCausa);
      const enRango = actuaciones.filter(a => isInRange(a.fecha, fechaDesde, fechaHasta));
      if (enRango.length > 0) causasDetalladas.push({ ...causa, actuaciones: enRango });
      await sleep(300);
    } catch (e) { console.error(`[MEV] Error causa ${causa.nidCausa}: ${e.message}`); }
  }

  if (causasDetalladas.length > 0) {
    await sendEmail(causasDetalladas, emailDestino, fechaDesde, fechaHasta, smtpConfig);
    console.log(`[MEV] Email enviado a ${emailDestino}`);
  }

  return { total: todasLasCausas.length, conNovedades: causasDetalladas.length, emailEnviado: causasDetalladas.length > 0 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendEmail(causas, destino, desde, hasta, smtpConfig) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host, port: smtpConfig.port || 587,
    secure: smtpConfig.secure || false,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass }
  });
  await transporter.sendMail({
    from: `"MEV Monitor" <${smtpConfig.user}>`,
    to: destino,
    subject: `Novedades MEV - ${desde} al ${hasta}`,
    html: buildEmailHtml(causas, desde, hasta)
  });
}

function buildEmailHtml(causas, desde, hasta) {
  const rows = causas.map(c => `
    <div style="margin-bottom:24px;padding:16px;border:1px solid #e0e0e0;border-radius:8px;">
      <h3 style="margin:0 0 8px;color:#1a237e;font-size:14px;">${c.caratula || 'Sin caratula'}</h3>
      <p style="margin:0 0 8px;color:#666;font-size:12px;">Juzgado: ${c.pidJuzgado || '-'} | Causa: ${c.nidCausa}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="background:#f5f5f5;"><th style="padding:6px 10px;text-align:left;border:1px solid #ddd;">Fecha</th><th style="padding:6px 10px;text-align:left;border:1px solid #ddd;">Actuacion</th></tr>
        ${c.actuaciones.map(a => `<tr><td style="padding:6px 10px;border:1px solid #ddd;color:#1565c0;">${a.fecha}</td><td style="padding:6px 10px;border:1px solid #ddd;">${a.descripcion}</td></tr>`).join('')}
      </table>
    </div>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
    <div style="background:#1a237e;color:white;padding:20px;border-radius:8px 8px 0 0;"><h1 style="margin:0;font-size:20px;">Novedades MEV</h1><p style="margin:4px 0 0;opacity:.85;font-size:13px;">Periodo: ${desde} - ${hasta}</p></div>
    <div style="background:#e8eaf6;padding:12px 20px;margin-bottom:20px;border-radius:0 0 8px 8px;"><strong>${causas.length}</strong> causa(s) con novedades</div>
    ${rows}
    <p style="font-size:11px;color:#999;text-align:center;">Generado por MEV Monitor</p>
  </body></html>`;
}

const jobs = {};

app.post('/api/scan', async (req, res) => {
  const { usuario, password, fechaDesde, fechaHasta, emailDestino } = req.body;
  if (!usuario || !password || !emailDestino)
    return res.status(400).json({ error: 'Faltan campos requeridos' });

  const hoy = new Date();
  const desde = fechaDesde || formatDate(new Date(hoy - 7 * 86400000));
  const hasta = fechaHasta || formatDate(hoy);

  const smtpConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  };

  if (!smtpConfig.user || !smtpConfig.pass)
    return res.status(500).json({ error: 'SMTP no configurado' });

  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running', startedAt: new Date().toISOString() };

  scanMEV({ usuario, password, fechaDesde: desde, fechaHasta: hasta, emailDestino, smtpConfig })
    .then(result => { jobs[jobId] = { status: 'done', result, finishedAt: new Date().toISOString() }; })
    .catch(err => { jobs[jobId] = { status: 'error', error: err.message, finishedAt: new Date().toISOString() }; });

  res.json({ jobId, message: 'Scan iniciado' });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

function formatDate(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MEV Monitor corriendo en puerto ${PORT}`));
