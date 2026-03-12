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

async function mevLogin(usuario, clave) {
  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9'
  };
  const r1 = await axios.get(BASE + '/loguin.asp', { timeout: 30000, headers: hdrs });
  const c1 = (r1.headers['set-cookie'] || []).map(function(c) { return c.split(';')[0]; }).join('; ');

  const params = new URLSearchParams();
  params.append('usuario', usuario);
  params.append('clave', clave);
  params.append('DeptoRegistrado', 'aa');

  const r2 = await axios.post(BASE + '/loguin.asp?familiadepto=', params.toString(), {
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: function(s) { return s < 500; },
    headers: Object.assign({}, hdrs, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': c1,
      'Referer': BASE + '/loguin.asp',
      'Origin': BASE
    })
  });

  const c2 = (r2.headers['set-cookie'] || []).map(function(c) { return c.split(';')[0]; });
  const allC = c1.split('; ').concat(c2).filter(Boolean).filter(function(v, i, a) {
    return a.findIndex(function(x) { return x.split('=')[0] === v.split('=')[0]; }) === i;
  }).join('; ');

  const body = r2.data || '';
  const lowerBody = body.toLowerCase();
  if (lowerBody.includes('clave incorrecta') || lowerBody.includes('usuario incorrecto') || lowerBody.includes('datos incorrectos')) {
    throw new Error('Credenciales incorrectas. Verifica usuario y clave en la MEV.');
  }
  if (!allC || allC.length < 5) {
    throw new Error('No se pudo iniciar sesion. Verifica tus credenciales.');
  }
  return allC;
}

async function getOrganismos(cookie) {
  const r = await axios.get(BASE + '/menu.asp', {
    timeout: 30000,
    headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(r.data);
  const orgs = [];
  $('select option').each(function(_, el) {
    const v = $(el).attr('value');
    const t = $(el).text().trim();
    if (v && v.length >= 2 && v !== 'aa' && v !== '0') {
      orgs.push({ id: v, nombre: t });
    }
  });
  if (orgs.length === 0) {
    $('a').each(function(_, el) {
      const href = $(el).attr('href') || '';
      const m = href.match(/[Oo]rganismo=([^&]+)/);
      if (m) orgs.push({ id: m[1], nombre: $(el).text().trim() });
    });
  }
  return orgs;
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
  $('table tr').each(function(_, row) {
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
      orgId: orgId
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
  $('table tr').each(function(_, row) {
    const cells = $(row).find('td');
    const f = cells.eq(0).text().trim();
    const d = cells.eq(1).text().trim();
    if (/\d{2}\/\d{2}\/\d{4}/.test(f) && d) {
      acts.push({ fecha: f, descripcion: d });
    }
  });
  return acts;
}

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
}

function inRange(dateStr, desde, hasta) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const a = parseDate(desde);
  const b = parseDate(hasta);
  if (b) b.setHours(23, 59, 59);
  return (!a || d >= a) && (!b || d <= b);
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

async function scanMEV(opts) {
  console.log('[MEV] Login...');
  const cookie = await mevLogin(opts.usuario, opts.clave);
  console.log('[MEV] Login OK');

  const orgs = await getOrganismos(cookie);
  console.log('[MEV] Organismos: ' + orgs.length);
  if (orgs.length === 0) throw new Error('No se encontraron organismos tras el login.');

  let todas = [];
  for (let i = 0; i < orgs.length; i++) {
    const org = orgs[i];
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

  const conNov = todas.filter(function(c) {
    return inRange(c.ultimaNovedad, opts.fechaDesde, opts.fechaHasta);
  });
  console.log('[MEV] Con novedades: ' + conNov.length);

  const detalladas = [];
  for (let j = 0; j < conNov.length; j++) {
    const causa = conNov[j];
    try {
      const acts = await getActuaciones(cookie, causa.nidCausa);
      const enRango = acts.filter(function(a) {
        return inRange(a.fecha, opts.fechaDesde, opts.fechaHasta);
      });
      if (enRango.length > 0) {
        detalladas.push(Object.assign({}, causa, { actuaciones: enRango }));
      }
      await sleep(300);
    } catch(e2) {
      console.error('[MEV] Error causa ' + causa.nidCausa + ': ' + e2.message);
    }
  }

  if (detalladas.length > 0) {
    await sendEmail(detalladas, opts.emailDestino, opts.fechaDesde, opts.fechaHasta, opts.smtpConfig);
    console.log('[MEV] Email enviado a ' + opts.emailDestino);
  }

  return {
    total: todas.length,
    conNovedades: detalladas.length,
    emailEnviado: detalladas.length > 0
  };
}

async function sendEmail(causas, to, desde, hasta, cfg) {
  const t = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 587,
    secure: cfg.secure || false,
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
    const filas = (c.actuaciones || []).map(function(a) {
      return '<tr>' +
        '<td style="padding:5px 8px;border:1px solid #ddd;color:#1565c0;white-space:nowrap">' + a.fecha + '</td>' +
        '<td style="padding:5px 8px;border:1px solid #ddd">' + a.descripcion + '</td>' +
        '</tr>';
    }).join('');
    return '<div style="margin:16px 0;padding:14px;border:1px solid #e0e0e0;border-radius:8px">' +
      '<h3 style="margin:0 0 6px;color:#1a237e;font-size:14px">' + (c.caratula || 'Sin caratula') + '</h3>' +
      '<p style="margin:0 0 8px;color:#888;font-size:12px">' + (c.juzgado || '') + ' | Causa: ' + c.nidCausa + '</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<tr style="background:#f5f5f5">' +
      '<th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Fecha</th>' +
      '<th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Actuacion</th>' +
      '</tr>' + filas + '</table></div>';
  }).join('');

  return '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px">' +
    '<div style="background:#1a237e;color:white;padding:18px;border-radius:8px 8px 0 0">' +
    '<h2 style="margin:0">Novedades MEV</h2>' +
    '<p style="margin:4px 0 0;opacity:.8;font-size:13px">Periodo: ' + desde + ' — ' + hasta + '</p></div>' +
    '<div style="background:#e8eaf6;padding:10px 18px;margin-bottom:16px;border-radius:0 0 8px 8px">' +
    '<strong>' + causas.length + '</strong> causa' + (causas.length !== 1 ? 's' : '') + ' con novedades</div>' +
    rows + '</body></html>';
}

const jobs = {};

function formatDate(d) {
  return String(d.getDate()).padStart(2, '0') + '/' +
    String(d.getMonth() + 1).padStart(2, '0') + '/' +
    d.getFullYear();
}

app.post('/api/scan', async function(req, res) {
  const usuario = req.body.usuario;
  const password = req.body.password;
  const fechaDesde = req.body.fechaDesde;
  const fechaHasta = req.body.fechaHasta;
  const emailDestino = req.body.emailDestino;

  if (!usuario || !password || !emailDestino) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const hoy = new Date();
  const desde = fechaDesde || formatDate(new Date(hoy.getTime() - 7 * 86400000));
  const hasta = fechaHasta || formatDate(hoy);

  const cfg = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  };

  if (!cfg.user || !cfg.pass) {
    return res.status(500).json({ error: 'SMTP no configurado en el servidor' });
  }

  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running', startedAt: new Date().toISOString() };

  scanMEV({
    usuario: usuario,
    clave: password,
    fechaDesde: desde,
    fechaHasta: hasta,
    emailDestino: emailDestino,
    smtpConfig: cfg
  }).then(function(result) {
    jobs[jobId] = { status: 'done', result: result, finishedAt: new Date().toISOString() };
  }).catch(function(err) {
    jobs[jobId] = { status: 'error', error: err.message, finishedAt: new Date().toISOString() };
  });

  res.json({ jobId: jobId, message: 'Scan iniciado' });
});

app.get('/api/status/:id', function(req, res) {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('MEV Monitor en puerto ' + PORT);
});
