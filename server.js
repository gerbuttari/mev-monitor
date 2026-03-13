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
    timeout: 60000,
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
  const r2 = await client.post(BASE + '/loguin.asp?familiadepto=', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/loguin.asp' } });
  const finalUrl = r2.request?.res?.responseUrl || r2.config?.url || '';
  const body = (r2.data || '').toString();
  const lower = body.toLowerCase();
  console.log('[MEV] Login response URL: ' + finalUrl);
  if (finalUrl.includes('AvisoERROR') || finalUrl.includes('Error') || lower.includes('clave incorrecta') || lower.includes('usuario o clave') || lower.includes('datos incorrectos')) {
    throw new Error('Credenciales incorrectas. Verific\u00e1 usuario y clave en la MEV.');
  }
  if (!finalUrl.includes('POSLoguin') && !body.includes('POSLoguin') && !body.includes('Seleccione el Organismo')) {
    if (r2.status >= 400) throw new Error('Error al iniciar sesi\u00f3n (HTTP ' + r2.status + ')');
  }
  console.log('[MEV] Login OK');
  return body;
}

async function selectDepto(client, posLoguinHtml, deptoId) {
  const params = new URLSearchParams();
  params.append('TipoDto', 'CC');
  params.append('DtoJudElegido', deptoId);
  params.append('Aceptar', 'Aceptar');
  const r = await client.post(BASE + '/POSLoguin.asp', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/POSLoguin.asp' } });
  const finalUrl = r.request?.res?.responseUrl || '';
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
  const url = `${BASE}/resultados.asp?nidset=${nidset}&sfechadesde=${encodeURIComponent(desde)}&sfechahasta=${encodeURIComponent(hasta)}&pOrden=xCa&pOrdenAD=Asc`;
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
    const juzgado = juzgadoInput.attr('value')?.trim() || '';
    const caratulaLink = juzgadoInput.next('a');
    const caratula = caratulaLink.text().trim();
    const despachoLink = $(cb).parent().find('a[href*="procesales"]').last();
    const despacho = despachoLink.find('font, span, *').text().trim() || despachoLink.text().trim();
    causas.push({ nidCausa: nidCausa.trim(), pidJuzgado: §W¦vFòÂ6&GVÆÂ6WDæöÖ'&RÂVÇFÖôFW76ó¢FW76òÒ°¢Ò°¢&WGW&â6W63°§Ð ¦Íå¹Õ¹Ñ¥½¸ÑÑÕ¥½¹Ì¡±¥¹Ð°¹¥
ÕÍ°Á¥)Õé¼°Í°¡ÍÑ¤ì(½¹ÍÐÕÉ°ôí	Mô½ÁÉ½Í±Ì¹ÍÀý¹¥
ÕÍôí¹¥
ÕÍôÁ¥)Õé¼ôí¹½UI%
½µÁ½¹¹Ð¡Á¥)Õé¼¥õì(½¹ÍÐÈôÝ¥Ð±¥¹Ð¹Ð¡ÕÉ°°ì¡ÉÌèìIÉÈè	M¬½ÉÍÕ±Ñ½Ì¹ÍÀôô¤ì(½¹ÍÐô¡É¥¼¹±½¡È¹Ññð¤ì(½¹ÍÐÑÌômtì( Ñ±ÑÈ¤¹  ¡|°É½Ü¤ôøì(½¹ÍÐ±±Ìô¡É½Ü¤¹¥¹ Ñ¤ì(½¹ÍÐ¡ô±±Ì¹Ä À¤¹ÑáÐ ¤¹ÑÉ¥´ ¤ì(½¹ÍÐÍô±±Ì¹Ä Ä¤¹ÑáÐ ¤¹ÑÉ¥´ ¤ì(¥ ½qìÉõp½qìÉõp½qìÑô¼¹ÑÍÐ¡¡¤ÍÍ¹¥¹±ÕÌ ¡¤¤ì(ÑÌ¹ÁÕÍ ¡ì¡°ÍÉ¥Á¥½¸èÍô¤ì(ô(ô¤ì(½¹ÍÐÍÐôÁÉÍÑ¡Í¤ì(½¹ÍÐ¡ÍÑÐôÁÉÍÑ¡¡ÍÑ¤ì(¥¡¡ÍÑÐ¤¡ÍÑÐ¹ÍÑ!½ÕÉÌ àØÌäääää¤ì(ÉÑÕÉ¸ÑÌ¹¥±ÑÈ¡ôøì(½¹ÍÐôÁÉÍÑ¡¹¡¤ì(¥ ¤ÉÑÕÉ¸±Íì(ÉÑÕÉ¸ ÍÐñðøôÍÐ¤ ¡ÍÑÐñððô¡ÍÑÐ¤ì(ô¤ì)ô()Õ¹Ñ¥½¸ÁÉÍÑ¡Ì¤ì(¥ Ì¤ÉÑÕÉ¸¹Õ±°ì(½¹ÍÐ´ôÌ¹µÑ  ¼¡qìÉô¥p¼¡qìÉô¥p¼¡qìÑô¤¼¤ì(ÉÑÕÉ¸´ü¹ÜÑ ­µlÍt°­µlÉt´Ä°­µlÅt¤è¹Õ±°ì)ô()½¹ÍÐÍ±ÀôµÌôø¹ÜAÉ½µ¥Í¡ÈôøÍÑQ¥µ½ÕÐ¡È°µÌ¤¤ì()sync function scanMEV(opts) {
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
  console.log('[MEV] Sets: ' + sets.map(s => s.nombre).join(', '));
  if (sets.length === 0) throw new Error('No se encontraron sets');
  let todas = [];
  for (const set of sets) {
    try {
      console.log('[MEV] Set: ' + set.nombre);
      const html = await getResultados(client, set.id, opts.fechaDesde, opts.fechaHasta);
      if (html.includes('No arroja resultados')) { console.log('[MEV] ' + set.nombre + ': sin resultados'); continue; }
      const causas = parseResultados(html, set.nombre);
      console.log('[MEV] ' + set.nombre + ': ' + causas.length + ' causas');
      todas = todas.concat(causas);
      await sleep(400);
    } catch(e) { console.error('[MEV] Error set: ' + e.message); }
  }
  console.log('[MEV] Total: ' + todas.length);
  if (todas.length === 0) return { total: 0, conNovedades: 0, emailEnviado: false };
  const det = [];
  for (const c of todas) {
    try {
      const acts = await getActuaciones(client, c.nidCausa, c.pidJuzgado, opts.fechaDesde, opts.fechaHasta);
      det.push({ ...c, actuaciones: acts.length > 0 ? acts : [{ fecha: '', descripcion: c.ultimoDespacho }] });
      await sleep(200);
    } catch(e) { det.push({ ...c, actuaciones: [{ fecha: '', descripcion: c.ultimoDespacho }] }); }
  }
  await sendEmail(det, opts.emailDestino, opts.fechaDesde, opts.fechaHasta, opts.smtpConfig);
  return { total: todas.length, conNovedades: det.length, emailEnviado: true };
}

async function sendEmail(causas, to, desde, hasta, cfg) {
  const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port || 587, secure: cfg.secure || false, auth: { user: cfg.user, pass: cfg.pass } });
  await t.sendMail({ from: '"MEV Monitor" <' + cfg.user + '>', to, subject: 'Novedades MEV \u2014 ' + desde + ' al ' + hasta, html: buildHtml(causas, desde, hasta) });
}

function buildHtml(causas, desde, hasta) {
  const rows = causas.map(c => {
    const f = (c.actuaciones || []).map(a => `<tr><td style="padding:5px 8px;border:1px solid #ddd;color:#1565c0;white-space:nowrap">${a.fecha || '\u2014'}</td><td style="padding:5px 8px;border:1px solid #ddd">${a.descripcion}</td></tr>`).join('');
    return `<div style="margin:16px 0;padding:14px;border:1px solid #e0e0e0;border-radius:8px;background:#fff"><div style="font-size:11px;color:#888;margin-bottom:4px">${c.setNombre}</div><h3 style="margin:0 0 4px;color:#1a237e;font-size:14px">${c.caratula || 'Sin car\u00e1tula'}</h3><p style="margin:0 0 8px;color:#888;font-size:12px">Causa: ${c.nidCausa}</p><table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#f5f5f5"><th style="padding:5px 8px;border:1px solid #ddd;text-align:left;width:120px">Fecha</th><th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Actuaci\u00f3n</th></tr>${f}</table></div>`;
  }).join('');
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;background:#f5f5f5"><div style="background:#1a237e;color:white;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">\ud83d\udccb Novedades MEV</h2><p style="margin:6px 0 0;opacity:.85;font-size:13px">Periodo: ${desde} \u2014 ${hasta}</p></div><div style="background:#e8eaf6;padding:12px 20px;margin-bottom:8px;border-radius:0 0 8px 8px"><strong>${causas.length}</strong> causa${causas.length !== 1 ? 's' : ''} con novedades</div>${rows}<p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px">MEV Monitor</p></body></html>`;
}

const jobs = {};
function formatDate(d) { return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear(); }

app.post('/api/scan', async (req, res) => {
  const { usuario, password, fechaDesde, fechaHasta, emailDestino } = req.body;
  if (!usuario || !password || !emailDestino) return res.status(400).json({ error: 'Faltan campos' });
  const hoy = new Date();
  const desde = fechaDesde || formatDate(new Date(hoy - 7 * 86400000));
  const hasta = fechaHasta || formatDate(hoy);
  const cfg = { host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: process.env.SMTP_SECURE === 'true', user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  if (!cfg.user || !cfg.pass) return res.status(500).json({ error: 'SMTP no configurado' });
  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running', startedAt: new Date().toISOString() };
  scanMEV({ usuario, clave: password, fechaDesde: desde, fechaHasta: hasta, emailDestino, smtpConfig: cfg })
    .then(result => { jobs[jobId] = { status: 'done', result }; })
    .catch(err => { jobs[jobId] = { status: 'error', error: err.message }; });
  res.json({ jobId, message: 'Scan iniciado', fechaDesde: desde, fechaHasta: hasta });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MEV Monitor en puerto ' + PORT));
