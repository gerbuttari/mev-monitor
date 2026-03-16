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

function parseResultados(html, setNombre) {
  const $ = cheerio.load(html);
  const causas = [];
  $('input[type=checkbox]').each((_, cb) => {
    const nidCausa = $(cb).attr('value');
    if (!nidCausa || !nidCausa.trim()) return;
    const hidden = $(cb).next('input[type=hidden]');
    const caratula = hidden.next('a').text().trim();
    const despacho = $(cb).parent().find('a[href*="procesales"]').last().text().trim();
    causas.push({ nidCausa: nidCausa.trim(), caratula, setNombre, despacho });
  });
  return causas;
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

  let todas = [];
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
      todas = todas.concat(causas);
    } catch(e) {
      console.error('[MEV] Error ' + set.nombre + ': ' + e.message);
    }
  }
  console.log('[MEV] Total: ' + todas.length);
  if (!todas.length) return { total: 0, emailEnviado: false };

  await sendEmail(todas, opts.emailDestino, opts.fechaDesde, opts.fechaHasta);
  console.log('[MEV] Email enviado OK');
  return { total: todas.length, emailEnviado: true };
}

async function sendEmail(causas, to, desde, hasta) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY no configurado');

  const rows = causas.map(c =>
    '<tr><td style="padding:10px;border-bottom:1px solid #eee;font-size:13px"><strong>' + (c.caratula || '-') + '</strong>' +
    '<br><small style="color:#888">' + c.setNombre + ' | ' + c.nidCausa + '</small></td>' +
    '<td style="padding:10px;border-bottom:1px solid #eee;font-size:12px;color:#555">' + (c.despacho || '-') + '</td></tr>'
  ).join('');

  const html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;background:#f5f5f5">' +
    '<div style="background:#1a237e;padding:24px;color:white"><h2 style="margin:0">Novedades MEV</h2>' +
    '<p style="margin:4px 0 0;opacity:.8;font-size:13px">' + desde + ' al ' + hasta + '</p></div>' +
    '<div style="padding:16px"><table style="width:100%;background:white;border-radius:8px;border-collapse:collapse">' +
    '<tr style="background:#e8eaf6"><th style="padding:10px;text-align:left;font-size:12px">CARATULA</th>' +
    '<th style="padding:10px;text-align:left;font-size:12px">ULTIMO DESPACHO</th></tr>' +
    rows + '</table>' +
    '<p style="color:#aaa;font-size:11px;text-align:center;margin-top:12px">MEV Monitor - ' + causas.length + ' causas</p>' +
    '</div></body></html>';

  const resp = await axios.post('https://api.resend.com/emails', {
    from: 'MEV Monitor <onboarding@resend.dev>',
    to: [to],
    subject: 'Novedades MEV - ' + desde + ' al ' + hasta,
    html: html
  }, {
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    timeout: 15000
  });

  if (resp.status >= 400) throw new Error('Resend error: ' + JSON.stringify(resp.data));
  console.log('[MEV] Resend OK, id: ' + resp.data.id);
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
