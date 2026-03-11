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
async function mevLogin(usuario, clave) {
  const h = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*', 'Accept-Language': 'es-AR,es;q=0.9' };
  const r1 = await axios.get(MEV_BASE + '/loguin.asp', { timeout: 30000, headers: h });
  const c1 = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const params = new URLSearchParams();
  params.append('usuario', usuario);
  params.append('clave', clave);
  params.append('DeptoRegistrado', 'aa');
  const r2 = await axios.post(MEV_BASE + '/loguin.asp?familiadepto=', params.toString(), {
    timeout: 30000, maxRedirects: 5, validateStatus: s => s < 500,
    headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c1, 'Referer': MEV_BASE + '/loguin.asp', 'Origin': MEV_BASE }
  });
  const c2 = (r2.headers['set-cookie'] || []).map(c => c.split(';')[0]);
  const allCookies = [...c1.split('; '), ...c2].filter(Boolean).filter((v,i,a) => a.findIndex(x => x.split('=')[0] === v.split('=')[0]) === i).join('; ');
  const body = r2.data || '';
  if (body.toLowerCase().includes('clave') && body.toLowerCase().includes('incorrecta')) throw new Error('Credenciales incorrectas.');
  if (r2.request?.path?.includes('loguin') && !body.includes('menu') && !body.includes('causas')) throw new Error('Login fallido. Verificá usuario y clave.');
  return allCookies;
}
async function getOrganismos(cookie) {
  const r = await axios.get(MEV_BASE + '/menu.asp', { timeout: 30000, headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(r.data);
  const orgs = [];
  $('select option').each((_, el) => { const v = $(el).attr('value'), t = $(el).text().trim(); if (v && v.length >= 2 && v !== 'aa' && v !== '0') orgs.push({ id: v, nombre: t }); });
  if (!orgs.length) $('a[href*="organismo"], a[href*="Organismo"]').each((_, el) => { const m = ($(el).attr('href')||'').match(/[Oo]rganismo=([^&]+)/); if (m) orgs.push({ id: m[1], nombre: $(el).text().trim() }); });
  return orgs;
}
async function getCausas(cookie, orgId) {
  const r = await axios.get(MEV_BASE + '/causas.asp?nidOrganismo=' + orgId, { timeout: 90000, headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' } });
  return r.data;
}
function parseCausas(html, orgId) {
  const $ = cheerio.load(html), causas = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    const link = $(row).find('a[href*="nidCausa"]').first();
    if (!link.length) return;
    const m = (link.attr('href')||'').match(/nidCausa[=]([^&]+)/i);
    if (!m) return;
    causas.push({ nidCausa: m[1].trim(), caratula: cells.eq(0).text().trim(), pidJuzgado: cells.eq(1).text().trim(), ultimaNovedad: cells.last().text().trim(), orgId });
  });
  return causas;
}
async function getActuaciones(cookie, nid) {
  const r = await axios.get(MEV_BASE + '/procesales.asp?nidCausa=' + nid, { timeout: 60000, headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(r.data), acts = [];
  $('table tr').each((_, row) => { const cells = $(row).find('td'); const f = cells.eq(0).text().trim(), d = cells.eq(1).text().trim(); if (/d{2}/d{2}/d{4}/.test(f) && d) acts.push({ fecha: f, descripcion: d }); });
  return acts;
}
function pd(s) { if (!s) return null; const m = s.match(/(d{2})/(d{2})/(d{4})/); return m ? new Date(+m[3], +m[2]-1, +m[1]) : null; }
function inRange(s, desde, hasta) { const d = pd(s); if (!d) return false; const a = pd(desde), b = pd(hasta); if (b) b.setHours(23,59,59); return (!a||d>=a)&&(!b||d<=b); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function scanMEV({ usuario, clave, fechaDesde, fechaHasta, emailDestino, smtpConfig }) {
  const cookie = await mevLogin(usuario, clave);
  const orgs = await getOrganismos(cookie);
  if (!orgs.length) throw new Error('No se encontraron organismos.');
  const todas = [];
  for (const o of orgs) { try { todas.push(...parseCausas(await getCausas(cookie, o.id), o.id)); await sleep(400); } catch(e) { console.error('Org error', o.id, e.message); } }
  const conNov = todas.filter(c => inRange(c.ultimaNovedad, fechaDesde, fechaHasta));
  const det = [];
  for (const c of conNov) { try { const acts = (await getActuaciones(cookie, c.nidCausa)).filter(a => inRange(a.fecha, fechaDesde, fechaHasta)); if (acts.length) det.push({...c, actuaciones: acts}); await sleep(300); } catch(e){} }
  if (det.length) await sendEmail(det, emailDestino, fechaDesde, fechaHasta, smtpConfig);
  return { total: todas.length, conNovedades: det.length, emailEnviado: det.length > 0 };
}
async function sendEmail(causas, to, desde, hasta, cfg) {
  const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port||587, secure: cfg.secure||false, auth: { user: cfg.user, pass: cfg.pass } });
  const rows = causas.map(c => '<div style="margin:16px 0;padding:14px;border:1px solid #ddd;border-radius:8px"><h3 style="margin:0 0 6px;color:#1a237e;font-size:14px">'+c.caratula+'</h3><p style="margin:0 0 8px;color:#888;font-size:12px">'+c.pidJuzgado+' | '+c.nidCausa+'</p><table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#f5f5f5"><th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Fecha</th><th style="padding:5px 8px;border:1px solid #ddd;text-align:left">Actuacion</th></tr>'+c.actuaciones.map(a=>'<tr><td style="padding:5px 8px;border:1px solid #ddd;color:#1565c0;white-space:nowrap">'+a.fecha+'</td><td style="padding:5px 8px;border:1px solid #ddd">'+a.descripcion+'</td></tr>').join('')+'</table></div>').join('');
  const html = '<html><body style="font-family:Arial;max-width:700px;margin:0 auto;padding:20px"><div style="background:#1a237e;color:white;padding:18px;border-radius:8px 8px 0 0"><h2 style="margin:0">Novedades MEV</h2><p style="margin:4px 0 0;opacity:.8;font-size:13px">'+desde+' al '+hasta+'</p></div><div style="background:#e8eaf6;padding:10px 18px;margin-bottom:16px;border-radius:0 0 8px 8px"><b>'+causas.length+'</b> causa'+(causas.length!==1?'s':'')+' con novedades</div>'+rows+'</body></html>';
  await t.sendMail({ from: '"MEV Monitor" <'+cfg.user+'>', to, subject: 'Novedades MEV — '+desde+' al '+hasta, html });
}
const jobs = {};
function fd(d) { return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear(); }
app.post('/api/scan', async (req, res) => {
  const { usuario, password, fechaDesde, fechaHasta, emailDestino } = req.body;
  if (!usuario||!password||!emailDestino) return res.status(400).json({ error: 'Faltan campos' });
  const hoy = new Date();
  const cfg = { host: process.env.SMTP_HOST||'smtp.gmail.com', port: +(process.env.SMTP_PORT||587), secure: process.env.SMTP_SECURE==='true', user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  if (!cfg.user||!cfg.pass) return res.status(500).json({ error: 'SMTP no configurado' });
  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'running' };
  scanMEV({ usuario, clave: password, fechaDesde: fechaDesde||fd(new Date(hoy-7*86400000)), fechaHasta: fechaHasta||fd(hoy), emailDestino, smtpConfig: cfg })
    .then(r => { jobs[jobId] = { status: 'done', result: r }; })
    .catch(e => { jobs[jobId] = { status: 'error', error: e.message }; });
  res.json({ jobId });
});
app.get('/api/status/:id', (req, res) => { const j = jobs[req.params.id]; res.status(j?200:404).json(j||{error:'not found'}); });
const PORT = process.env.PORT||3000;
app.listen(PORT, () => console.log('MEV Monitor en puerto '+PORT));
