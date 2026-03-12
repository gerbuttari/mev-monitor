const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const BASE = 'https://mev.scba.gov.ar';

// Returns { cookie, homeHtml, homeUrl }
async function mevLogin(usuario, clave) {
  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9'
  };

  const r1 = await axios.get(BASE + '/loguin.asp', { timeout: 30000, headers: hdrs });
  const c1 = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  const params = new URLSearchParams();
  params.append('usuario', usuario);
  params.append('clave', clave);
  params.append('DeptoRegistrado', 'aa');

  const r2 = await axios.post(
    BASE + '/loguin.asp?familiadepto=',
    params.toString(),
    {
      timeout: 30000,
      maxRedirects: 10,
      validateStatus: () => true, // Accept all status codes including 500
      headers: Object.assign({}, hdrs, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': c1,
        'Referer': BASE + '/loguin.asp',
        'Origin': BASE
      })
    }
  );

  const c2 = (r2.headers['set-cookie'] || []).map(c => c.split(';')[0]);
  const allC = [...c1.split('; '), ...c2]
    .filter(Boolean)
    .filter((v, i, a) => a.findIndex(x => x.split('=')[0] === v.split('=')[0]) === i)
    .join('; ');

  const body = (r2.data || '').toString();
  const lower = body.toLowerCase();

  if (r2.status >= 500) {
    throw new Error('Credenciales incorrectas. Verifique usuario y clave.');
  }
  if (lower.includes('clave incorrecta') || lower.includes('usuario incorrecto') || lower.includes('datos incorrectos') || lower.includes('acceso denegado')) {
    throw new Error('Credenciales incorrectas. Verifique usuario y clave.');
  }

  // The post-login page IS the home/menu â use it directly
  const homeUrl = r2.request ? (r2.request.res ? r2.request.res.responseUrl : '') : '';
  console.log('[MEV] Post-login URL: ' + (homeUrl || 'unknown'));
  console.log('[MEV] Post-login body length: ' + body.length);

  return { cookie: allC, homeHtml: body, homeUrl };
}

function extractOrganismos(html) {
  const $ = cheerio.load(html);
  const orgs = [];

  // Strategy 1: select/option with org codes
  $('select option').each((_, el) => {
    const v = $(el).attr('value');
    const t = $(el).text().trim();
    if (v && v.length >= 2 && !['aa','0','--',''].includes(v)) {
      orgs.push({ id: v, nombre: t });
    }
  });
  if (orgs.length > 0) return orgs;

  // Strategy 2: links with nidOrganismo
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/nidOrganismo=([^&]+)/i);
    if (m) orgs.push({ id: m[1].trim(), nombre: $(el).text().trim() });
  });
  if (orgs.length > 0) return orgs;

  // Strategy 3: links with organismo
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/[Oo]rganismo=([^&]+)/);
    if (m) orgs.push({ id: m[1].trim(), nombre: $(el).text().trim() });
  });

  return orgs;
}

async function getOrganismos(cookie, homeHtml) {
  // First try to parse from the home page we already have
  let orgs = extractOrganismos(homeHtml);
  if (orgs.length > 0) {
    console.log('[MEV] Organismos from home page: ' + orgs.length);
    return orgs;
  }

  // Try known menu URLs
  const menuUrls = [
    '/inicio.asp', '/ingreso.asp', '/menu.asp',
    '/causas.asp', '/principal.asp', '/home.asp', '/index.asp'
  ];

  for (const url of menuUrls) {
    try {
      console.log('[MEV] Trying: ' + url);
      const r = await axios.get(BASE + url, {
        timeout: 20000,
        validateStatus: s => s < 500,
        headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0', 'Referer': BASE + '/loguin.asp' }
      });
      if (r.status === 200 && r.data) {
        orgs = extractOrganismos(r.data.toString());
        if (orgs.length > 0) {
          console.log('[MEV] Found organismos at ' + url + ': ' + orgs.length);
          return orgs;
        }
      }
    } catch(e) {
      console.log('[MEV] ' + url + ' error: ' + e.message);
    }
  }

  return [];
}

async function getCausas(cookie, orgId) {
  const r = await axios.get(BASE + '/causas.asp?nidOrganismo=' + orgId, {
    timeout: 90000,
    headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' }
  });
  return r.data;
}

function parseCausas(html, orgId) {
  const $ = cheerio.load(html);
  const causas = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    const link = $(row).find('a[href*="nidCausa"]').first();
    if (!link.length) return;
    const href = link.attr('href') || '';
    const m = href.match(/nidCausa=([^&]+)/i);
    if (!m) return;
    causas.push({
      nidCausa: m[1].trim(),
      caratula: cells.eq(0).text().trim(),
      juzgado: cells.eq(1).text().trim(),
      ultimaNovedad: cells.last().text().trim(),
      orgId
    });
  });
  return causas;
}

async function getActuaciones(cookie, nid) {
  const r = await axios.get(BASE + '/procesales.asp?nidCausa=' + nid, {
    timeout: 60000,
    headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(r.data);
  const acts = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    const f = cells.eq(0).text().trim();
    const d = cells.eq(1).text().trim();
    if (/\d{2}\/\d{2}\/\d{4}/.test(f) && d) acts.push({ fecha: f, descripcion: d });
  });
  return acts;
}

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(+m[3], +m[2]-1, +m[1]) : null;
}

function inRange(dateStr, desde, hasta) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const a = parseDate(desde);
  const b = parseDate(hasta);
  if (b) b.setHours(23,59,59);
  return (!a || d >= a) && (!b || d <= b);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scanMEV(opts) {
  console.log('[MEV] Login...');
  const { cookie, homeHtml } = await mevLogin(opts.usuario, opts.clave);
  console.log('[MEV] Login OK');

  const orgs = await getOrganismos(cookie, homeHtml);
  console.log('[MEV] Organismos encontrados: ' + orgs.length);

  if (orgs.length === 0) {
    throw new Error('No se encontraron organismos. Puede que la sesion haya expirado o el sistema MEV cambio su estructura.');
  }

  let todas = [];
  for (const org of orgs) {
    try {
      const html = await getCausas(cookie, org.id);
      const c = parseCausas(html, org.id);
      console.log('[MEV] ' + org.nombre + ': ' + c.length + ' causas');
      todas = todas.concat(c);
      await sleep(400);
    } catch(e) {
      console.error('[MEV] Error org ' + org.id + ': ' + e.message);
    }
  }

  const conNov = todas.filter(c => inRange(c.ultimaNovedad, opts.fechaDesde, opts.fechaHasta));
  console.log('[MEV] Con novedades: ' + conNov.length);

  const detalladas = [];
  for (const causa of conNov) {
    try {
      const acts = await getActuaciones(cookie, causa.nidCausa);
      const enRango = acts.filter(a => inRange(a.fecha, opts.fechaDesde, opts.fechaHasta));
      if (enRango.length > 0) detalladas.push({ ...causa, actuaciones: enRango });
      await sleep(300);
    } catch(e) {
      console.error('[MEV] Error causa ' + causa.nidCausa + ': ' + e.message);
    }
  }

  if (detalladas.length > 0) {
    await sendEmail(detalladas, opts.emailDestino, opts.fechaDesde, opts.fechaHasta, opts.smtpConfig);
    console.log('[MEV] Email enviado a ' + opts.emailDestino);
  }

  return { total: todas.length, conNovedades: detalladas.length, emailEnviado: detalladas.length > 0 };
}

async function sendEmail(causas, to, desde, hasta, cfg) {
  const t = nodemailer.createTransport({
    host: cfg.host, port: cfg.port || 587,
    secure: cfg.secure || false,
    auth: { user: cfg.user, pass: cfg.pass }
  });
  await t.sendMail({
    from: '"MEV Monitor" <' + cfg.user + '>',
    to, subject: 'Novedades MEV â ' + desde + ' al ' + hasta,
    html: buildHtml(causas, desde, hasta)
  });
}

function buildHtml(causas, desde, hasta) {
  const rows = causas.map(c => {
    const filas = (c.actuaciones||[]).map(a =>
      '<tr><td style="padding:5px 8px;border:1px solid #ddd;color:#1565c0;white-space:nowrap">' + a.fecha + '</td>' +
      '<td style="padding:5px 8px;border:1px solid #ddd">' + a.descripcion + '</td></tr>'
    ).join('');
    return '<div style="margin:16px 0;padding:14px;border:1px solid #e0e0e0;border-radius:8px">' +
      '<h3 style="margin:0 0 6px;color:#1a237e;font-size:14px">' + (c.caratula||'Sin caratula') + '</h3>' +
      '<p style="margin:0 0 8px;color:#888;font-size:12px">' + (c.juzgado||'') + ' | Causa: ' + c.nidCausa + '</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<tr style="background:#f5f5f5"><th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Fecha</th>' +
      '<th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Actuacion</th></tr>' +
      filas + '</table></div>';
  }).join('');
  return '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px">' +
    '<div style="background:#1a237e;color:white;padding:18px;border-radius:8px 8px 0 0">' +
    '<h2 style="margin:0">Novedades MEV</h2><p style="margin:4px 0 0;opacity:.8;font-size:13px">Periodo: ' + desde + ' â ' + hasta + '</p></div>' +
    '<div style="background:#e8eaf6;padding:10px 18px;margin-bottom:16px;border-radius:0 0 8px 8px">' +
    '<strong>' + causas.length + '</strong> causa' + (causas.length!==1?'s':'') + ' con novedades</div>' +
    rows + '</body></html>';
}

const jobs = {};
function formatDate(d) {
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}

app.post('/api/scan', async (req, res) => {
  const { usuario, password, fechaDesde, fechaHasta, emailDestino } = req.body;
  if (!usuario || !password || !emailDestino)
    return res.status(400).json({ error: 'Faltan campos requeridos' });

  const hoy = new Date();
  const desde = fechaDesde || formatDate(new Date(hoy - 7*86400000));
  const hasta = fechaHasta || formatDate(hoy);

  const cfg = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  };

  if (!cfg.user || !cfg.pass)
    return res.status(500).json({ error: 'SMTP no configurado en el servidor' });

  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running' };

  scanMEV({ usuario, clave: password, fechaDesde: desde, fechaHasta: hasta, emailDestino, smtpConfig: cfg })
    .then(result => { jobs[jobId] = { status: 'done', result }; })
    .catch(err => { jobs[jobId] = { status: 'error', error: err.message }; });

  res.json({ jobId, message: 'Scan iniciado' });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MEV Monitor en puerto ' + PORT));
