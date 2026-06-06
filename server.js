// Quantum Ventures — Audit scoring API (zero-dependency Node service)
// POST /api/audit  -> AI personal-brand analyst scores the influencer and emails dirección.
const http = require('http');
const crypto = require('crypto');

const PROJECT = process.env.GCP_PROJECT;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const RECIPIENTS = process.env.AUDIT_RECIPIENTS || 'dani.martprof@gmail.com';
const SENDER = process.env.SENDER_EMAIL || 'dani.martprof@gmail.com';
const CORS = process.env.CORS_ORIGIN || '*';

const SYS = `Eres un analista experto de Quantum Ventures (venture builder privado para creadores de élite) especializado en AUDITORÍA DE MARCA PERSONAL y PROYECCIÓN DE MONETIZACIÓN. Dado el formulario de un influencer, evalúa su atractivo como PARTNER de QV y devuelve un rating para el equipo de dirección. ICP de QV: creadores con tráfico orgánico YA consolidado + alto valor percibido que permita desarrollar infoproductos, marcas propias (suplementos/ropa/alimentación), comunidad y patrimonio. NO captan creadores en crecimiento inicial. Evalúa 7 dimensiones (0-100): 1) Calidad y tamaño de audiencia, 2) Engagement/comunidad, 3) Potencial de monetización/escalera de valor, 4) Autoridad y marca personal, 5) Diversificación y disposición a productos propios, 6) Madurez de negocio/estructura, 7) Encaje con el modelo QV. Calcula un quantum_score global 0-100 (media ponderada con más peso a monetización y encaje), tier (A=prioridad alta, B=interesante, C=dudoso, PASS=descartar), señales clave, riesgos y next_step. Sé honesto y crítico, no infles. Responde SOLO JSON.`;

const SCHEMA = { type:'object', properties:{
  quantum_score:{type:'integer'}, tier:{type:'string',enum:['A','B','C','PASS']}, resumen:{type:'string'},
  dimensiones:{type:'object',properties:{audiencia:{type:'integer'},engagement:{type:'integer'},monetizacion:{type:'integer'},autoridad:{type:'integer'},diversificacion:{type:'integer'},madurez_negocio:{type:'integer'},encaje_qv:{type:'integer'}}},
  senales_clave:{type:'array',items:{type:'string'}}, riesgos:{type:'array',items:{type:'string'}}, next_step:{type:'string'}
}, required:['quantum_score','tier','resumen','dimensiones','senales_clave','riesgos','next_step'] };

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

async function vertexToken() {
  const sa = JSON.parse(process.env.SA_JSON);
  const now = Math.floor(Date.now()/1000);
  const head = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claim = b64url(JSON.stringify({iss:sa.client_email, scope:'https://www.googleapis.com/auth/cloud-platform', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600}));
  const s = crypto.createSign('RSA-SHA256'); s.update(head+'.'+claim); s.end();
  const jwt = head+'.'+claim+'.'+b64url(s.sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt})});
  const j = await r.json(); if(!j.access_token) throw new Error('vertex token: '+JSON.stringify(j)); return j.access_token;
}

async function score(form) {
  const token = await vertexToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = { systemInstruction:{parts:[{text:SYS}]}, contents:[{role:'user',parts:[{text:'Formulario del influencer:\n'+JSON.stringify(form)}]}], generationConfig:{temperature:0.4,responseMimeType:'application/json',responseSchema:SCHEMA} };
  const r = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok) throw new Error('vertex '+r.status+' '+await r.text());
  const j = await r.json();
  return JSON.parse(j.candidates[0].content.parts[0].text);
}

async function gmailToken() {
  const r = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GMAIL_CLIENT_ID,client_secret:process.env.GMAIL_CLIENT_SECRET,refresh_token:process.env.GMAIL_REFRESH_TOKEN,grant_type:'refresh_token'})});
  const j = await r.json(); if(!j.access_token) throw new Error('gmail token: '+JSON.stringify(j)); return j.access_token;
}

function emailHtml(form, r) {
  const dim = r.dimensiones||{};
  const bar = (v)=>`<div style="background:#1b2233;border-radius:6px;height:8px;width:160px;display:inline-block;vertical-align:middle"><div style="background:linear-gradient(90deg,#22d3ee,#6366f1);height:8px;border-radius:6px;width:${Math.max(0,Math.min(100,v))}%"></div></div>`;
  const row = (k,v)=>`<tr><td style="padding:4px 12px 4px 0;color:#8b97a8;font-size:13px">${k}</td><td style="padding:4px 0">${bar(v)} <b style="color:#e7ecf3;font-size:13px">${v}</b></td></tr>`;
  const li = (arr,c)=>(arr||[]).map(x=>`<li style="margin:4px 0;color:${c}">${x}</li>`).join('');
  const tierColor = {A:'#22d3ee',B:'#6366f1',C:'#f59e0b',PASS:'#f87171'}[r.tier]||'#8b97a8';
  return `<div style="font-family:Inter,Arial,sans-serif;background:#06070d;color:#e7ecf3;padding:24px;border-radius:14px;max-width:640px">
    <div style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#22d3ee">Quantum Ventures · Nuevo lead auditado</div>
    <h2 style="margin:8px 0 2px;font-size:22px">${form.nombre||'—'} <span style="color:#8b97a8;font-weight:400">· ${form.nicho||''}</span></h2>
    <div style="margin:14px 0;display:flex;gap:14px;align-items:center">
      <div style="font-size:40px;font-weight:800;color:#fff">${r.quantum_score}<span style="font-size:18px;color:#8b97a8">/100</span></div>
      <div style="background:${tierColor};color:#06070d;font-weight:700;border-radius:999px;padding:6px 16px">TIER ${r.tier}</div>
    </div>
    <p style="color:#aab4c4;font-size:14px;line-height:1.6">${r.resumen||''}</p>
    <table style="margin:14px 0;border-collapse:collapse">${row('Audiencia',dim.audiencia)}${row('Engagement',dim.engagement)}${row('Monetización',dim.monetizacion)}${row('Autoridad',dim.autoridad)}${row('Diversificación',dim.diversificacion)}${row('Madurez negocio',dim.madurez_negocio)}${row('Encaje QV',dim.encaje_qv)}</table>
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <div><div style="color:#22d3ee;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">Señales</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#cbd5e1">${li(r.senales_clave,'#cbd5e1')}</ul></div>
      <div><div style="color:#f59e0b;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">Riesgos</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#cbd5e1">${li(r.riesgos,'#cbd5e1')}</ul></div>
    </div>
    <div style="margin-top:16px;background:#0c0e17;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px">
      <div style="color:#22d3ee;font-size:12px;text-transform:uppercase;letter-spacing:.1em">Next step</div>
      <div style="font-size:14px;color:#e7ecf3;margin-top:4px">${r.next_step||''}</div>
    </div>
    <div style="margin-top:18px;border-top:1px solid rgba(255,255,255,.08);padding-top:14px;font-size:12px;color:#8b97a8">
      <b style="color:#aab4c4">Datos del formulario</b><br>
      Email: ${form.email||'—'} · País: ${form.pais||'—'} · Handle: ${form.handle_principal||'—'}<br>
      Plataformas: IG ${form.instagram||'—'} · YT ${form.youtube||'—'} · TikTok ${form.tiktok||'—'} · Otra ${form.otra||'—'} · Eng ${form.engagement_pct||'—'}%<br>
      Monetización: ${form.monetizacion_actual||'—'} · Ingresos/mes: ${form.ingresos_aprox||'—'} · Equipo: ${form.equipo||'—'}<br>
      Objetivo: ${form.objetivo||'—'}<br>Enlaces: ${form.enlaces||'—'}
    </div>
  </div>`;
}

async function sendEmail(form, rating) {
  const token = await gmailToken();
  const subject = `Lead [Tier ${rating.tier} · ${rating.quantum_score}] ${form.nombre||''} — ${form.nicho||''}`;
  const html = emailHtml(form, rating);
  const mime = [
    `From: Quantum Ventures <${SENDER}>`,
    `To: ${RECIPIENTS}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '', html
  ].join('\r\n');
  const raw = b64url(mime);
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw})});
  if(!r.ok) throw new Error('gmail send '+r.status+' '+await r.text());
}

async function handleAudit(form) {
  if(!form || !form.nombre || !form.email) { const e=new Error('missing fields'); e.code=400; throw e; }
  const rating = await score(form);
  await sendEmail(form, rating);
  return { ok:true, tier:rating.tier, score:rating.quantum_score };
}

if (require.main === module) {
  const server = http.createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin', CORS);
    res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }
    if(req.method==='GET' && req.url==='/health'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"ok":true}'); }
    if(req.method==='POST' && req.url==='/api/audit'){
      let body=''; req.on('data',c=>{body+=c; if(body.length>1e6) req.destroy();});
      req.on('end', async ()=>{
        try{ const form=JSON.parse(body||'{}'); const out=await handleAudit(form); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(out)); }
        catch(e){ const code=e.code===400?400:500; console.error('audit error:', e.message); res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:code===400?'missing fields':'internal'})); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(process.env.PORT||8080, ()=>console.log('QV audit API on '+(process.env.PORT||8080)));
}

module.exports = { score, sendEmail, handleAudit };
