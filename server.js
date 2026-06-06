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
const SHEET_ID = process.env.AUDIT_SHEET_ID || '';

const SYS = `Eres un analista experto de Quantum Ventures (venture builder privado para creadores de élite) especializado en AUDITORÍA DE MARCA PERSONAL y PROYECCIÓN DE MONETIZACIÓN. Dado el formulario de un influencer, evalúa su atractivo como PARTNER de QV y devuelve un rating para el equipo de dirección. ICP de QV: creadores con tráfico orgánico YA consolidado + alto valor percibido que permita desarrollar infoproductos, marcas propias (suplementos/ropa/alimentación), comunidad y patrimonio. NO captan creadores en crecimiento inicial. Evalúa 7 dimensiones (0-100): 1) Calidad y tamaño de audiencia, 2) Engagement/comunidad, 3) Potencial de monetización/escalera de valor, 4) Autoridad y marca personal, 5) Diversificación y disposición a productos propios, 6) Madurez de negocio/estructura, 7) Encaje con el modelo QV. Calcula un quantum_score global 0-100 (media ponderada con más peso a monetización y encaje), tier (A=prioridad alta, B=interesante, C=dudoso, PASS=descartar), señales clave, riesgos y next_step. Sé honesto y crítico, no infles. Responde SOLO JSON.`;

const SCHEMA = { type:'object', properties:{
  quantum_score:{type:'integer'}, tier:{type:'string',enum:['A','B','C','PASS']}, resumen:{type:'string'},
  dimensiones:{type:'object',properties:{audiencia:{type:'integer'},engagement:{type:'integer'},monetizacion:{type:'integer'},autoridad:{type:'integer'},diversificacion:{type:'integer'},madurez_negocio:{type:'integer'},encaje_qv:{type:'integer'}}},
  senales_clave:{type:'array',items:{type:'string'}}, riesgos:{type:'array',items:{type:'string'}}, next_step:{type:'string'}
}, required:['quantum_score','tier','resumen','dimensiones','senales_clave','riesgos','next_step'] };

const PRODUCT_SYS = `Eres analista senior de Quantum Ventures, experto en EVALUAR EL POTENCIAL DE ESCALABILIDAD EMPRESARIAL de un producto/servicio de un creador. El creador opera en un NICHO concreto (campos 'nicho'/'nicho_label' + preguntas específicas del nicho): ADAPTA los criterios, el lenguaje y los benchmarks a ese nicho (ej. fitness/nutrición: retención, adherencia y escalado one-to-many; creación con IA/animaciones: throughput, tiempo por entrega y automatización del pipeline; consultoría: productización, estandarización y dependencia del fundador). Trabajamos por nicho, así que valora cada caso con la lógica de SU nicho. Recibes una auditoría intensiva del producto/servicio (qué vende, formato de entrega, herramientas, capacidad, precios, costes, márgenes, ingresos, recurrencia, churn, mercado, diferenciación, ambición). Evalúa con CRITERIOS OBJETIVOS (economía unitaria y márgenes, ingresos y recurrencia, capacidad/automatización y apalancamiento de entrega, tamaño/demanda de mercado, dependencia del fundador) y CRITERIOS SUBJETIVOS (diferenciación y foso defensivo, fuerza de marca/autoridad, calidad y madurez del producto, ambición y mentalidad del fundador, encaje con el modelo QV de construir activos). Da un scalability_score 0-100, un veredicto para el CONSEJO (Dani y Marcelino) entre 'GO' (colaborar), 'EXPLORE' (explorar/condicionado) o 'NO_GO' (descartar), sub-scores objetivos y subjetivos, palancas de crecimiento, cuellos de botella, y una recomendacion_consejo accionable y honesta (sin inflar). Responde SOLO JSON.`;

const PRODUCT_SCHEMA = { type:'object', properties:{
  scalability_score:{type:'integer'}, veredicto:{type:'string',enum:['GO','EXPLORE','NO_GO']}, resumen:{type:'string'},
  objetivo:{type:'object',properties:{economia_unitaria:{type:'integer'},ingresos_recurrencia:{type:'integer'},capacidad_automatizacion:{type:'integer'},mercado_demanda:{type:'integer'},dependencia_fundador:{type:'integer'}}},
  subjetivo:{type:'object',properties:{diferenciacion:{type:'integer'},marca_autoridad:{type:'integer'},madurez_producto:{type:'integer'},ambicion_fundador:{type:'integer'},encaje_qv:{type:'integer'}}},
  palancas:{type:'array',items:{type:'string'}}, cuellos_botella:{type:'array',items:{type:'string'}}, recomendacion_consejo:{type:'string'}
}, required:['scalability_score','veredicto','resumen','objetivo','subjetivo','palancas','cuellos_botella','recomendacion_consejo'] };

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

async function vertexToken() {
  const sa = JSON.parse(process.env.SA_JSON || Buffer.from(process.env.SA_JSON_B64 || '', 'base64').toString('utf8'));
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

function primaryProfile(form) {
  const handle = (form.handle_principal||'').replace(/^@/,'').trim();
  const links = (form.enlaces||'') + ' ' + (form.handle_principal||'');
  const m = links.match(/(instagram|youtube|tiktok|twitter|x)\.com\/(@?[A-Za-z0-9_.\-]+)/i);
  if (m) { let p=m[1].toLowerCase(); if(p==='x') p='twitter'; return { platform:p, handle:m[2].replace(/^@/,'') }; }
  if (form.instagram && handle) return { platform:'instagram', handle };
  if (form.youtube && handle) return { platform:'youtube', handle };
  if (form.tiktok && handle) return { platform:'tiktok', handle };
  if (handle) return { platform:'instagram', handle };
  return null;
}

async function getAvatar(form) {
  const p = primaryProfile(form);
  if (!p) return null;
  const urls = [
    `https://unavatar.io/${p.platform}/${encodeURIComponent(p.handle)}?fallback=false`,
    `https://unavatar.io/${encodeURIComponent(p.handle)}?fallback=false`
  ];
  for (const u of urls) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 8000);
      const r = await fetch(u, { redirect:'follow', signal:ctrl.signal }); clearTimeout(t);
      if (!r.ok) continue;
      const ct = r.headers.get('content-type')||'';
      if (!ct.startsWith('image/')) continue;
      const ab = await r.arrayBuffer();
      if (ab.byteLength < 500) continue;
      return { buf: Buffer.from(ab), ct };
    } catch(e) {}
  }
  return null;
}

async function logSheet(tab, row) {
  if (!SHEET_ID) return;
  try {
    const token = await gmailToken(); // dani's token also carries the spreadsheets scope
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW`;
    const r = await fetch(url, { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({ values:[row] }) });
    if (!r.ok) console.error('sheet log', tab, r.status, await r.text());
  } catch (e) { console.error('sheet log error:', e.message); }
}
const nowES = () => { try { return new Date().toLocaleString('es-ES',{timeZone:'Europe/Madrid'}); } catch(e){ return new Date().toISOString(); } };

async function sendHtmlMail(token, subject, html, avatar) {
  const head = [`From: Quantum Ventures <${SENDER}>`, `To: ${RECIPIENTS}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'MIME-Version: 1.0'];
  let mime;
  if (avatar) {
    const bnd = 'qvrel'+Date.now();
    mime = [...head, `Content-Type: multipart/related; boundary="${bnd}"`, '',
      `--${bnd}`, 'Content-Type: text/html; charset=UTF-8', '', html, '',
      `--${bnd}`, `Content-Type: ${avatar.ct}`, 'Content-Transfer-Encoding: base64', 'Content-ID: <avatar>', 'Content-Disposition: inline', '', avatar.buf.toString('base64'),
      `--${bnd}--`, ''].join('\r\n');
  } else {
    mime = [...head, 'Content-Type: text/html; charset=UTF-8', '', html].join('\r\n');
  }
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({raw:b64url(mime)})});
  if (!r.ok) throw new Error('gmail send '+r.status+' '+await r.text());
}

// shared email styling helpers (consistent sizes + spacing, dark bg / light text)
const EM = {
  wrap: 'font-family:Inter,Arial,sans-serif;background:#06070d;color:#e7ecf3;padding:32px;border-radius:14px;max-width:640px',
  eyebrow: 'font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;font-weight:600',
  name: 'margin:14px 0 22px;font-size:20px;font-weight:700;color:#ffffff;line-height:1.35',
  para: 'color:#aab4c4;font-size:15px;line-height:1.75;margin:0 0 24px',
  card: 'background:#0c0e17;border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:18px;margin:0 0 24px',
  footer: 'border-top:1px solid rgba(255,255,255,.10);padding-top:18px;font-size:13px;color:#8b97a8;line-height:1.9'
};
const emLabel = (t,c)=>`<div style="color:${c};font-size:12px;text-transform:uppercase;letter-spacing:.12em;font-weight:600;margin:0 0 12px">${t}</div>`;
const emBar = (v)=>`<span style="display:inline-block;width:150px;height:8px;border-radius:6px;background:#1b2233;vertical-align:middle"><span style="display:inline-block;height:8px;border-radius:6px;background:linear-gradient(90deg,#22d3ee,#6366f1);width:${Math.max(0,Math.min(100,v||0))}%"></span></span>`;
const emRow = (k,v)=>`<tr><td style="padding:7px 16px 7px 0;color:#9aa6b8;font-size:14px;white-space:nowrap">${k}</td><td style="padding:7px 0">${emBar(v)} <b style="color:#e7ecf3;font-size:14px;padding-left:8px">${v??'—'}</b></td></tr>`;
const emList = (arr)=>`<ul style="margin:0 0 24px;padding-left:20px">`+(arr||[]).map(x=>`<li style="margin:0 0 9px;color:#cbd5e1;font-size:14px;line-height:1.7">${x}</li>`).join('')+`</ul>`;
const emScore = (n,badgeText,badgeColor,caption)=>`<table style="border-collapse:collapse;margin:0 0 22px"><tr>
      <td style="vertical-align:middle;padding-right:16px"><span style="font-size:38px;font-weight:800;color:#ffffff">${n}</span><span style="font-size:16px;color:#8b97a8">/100</span></td>
      <td style="vertical-align:middle;padding-right:14px"><span style="background:${badgeColor};color:#06070d;font-weight:700;font-size:13px;border-radius:999px;padding:7px 16px">${badgeText}</span></td>
      ${caption?`<td style="vertical-align:middle;color:#8b97a8;font-size:13px">${caption}</td>`:''}
    </tr></table>`;
const emHeader = (eyebrow,name,sub,hasAvatar)=>`<table style="border-collapse:collapse;margin:0 0 22px"><tr>
      ${hasAvatar?`<td style="vertical-align:middle;padding-right:14px"><img src="cid:avatar" width="50" height="50" alt="" style="border-radius:50%;display:block;border:1px solid rgba(255,255,255,.18)"></td>`:''}
      <td style="vertical-align:middle">
        <div style="${EM.eyebrow}">${eyebrow}</div>
        <div style="font-size:20px;font-weight:700;color:#ffffff;line-height:1.35;margin-top:7px">${name} <span style="color:#8b97a8;font-weight:400">· ${sub}</span></div>
      </td>
    </tr></table>`;

function emailHtml(form, r, hasAvatar) {
  const dim = r.dimensiones||{};
  const tierColor = {A:'#22d3ee',B:'#6366f1',C:'#f59e0b',PASS:'#f87171'}[r.tier]||'#8b97a8';
  return `<div style="${EM.wrap}">
    ${emHeader('Quantum Ventures · Nuevo lead auditado', form.nombre||'—', form.nicho||'', hasAvatar)}
    ${emScore(r.quantum_score, 'TIER '+r.tier, tierColor, 'Interés / encaje')}
    <p style="${EM.para}">${r.resumen||''}</p>
    ${emLabel('Dimensiones','#22d3ee')}
    <table style="border-collapse:collapse;margin:0 0 26px">${emRow('Audiencia',dim.audiencia)}${emRow('Engagement',dim.engagement)}${emRow('Monetización',dim.monetizacion)}${emRow('Autoridad',dim.autoridad)}${emRow('Diversificación',dim.diversificacion)}${emRow('Madurez negocio',dim.madurez_negocio)}${emRow('Encaje QV',dim.encaje_qv)}</table>
    ${emLabel('Señales','#22d3ee')}${emList(r.senales_clave)}
    ${emLabel('Riesgos','#f59e0b')}${emList(r.riesgos)}
    <div style="${EM.card}">${emLabel('Next step','#22d3ee')}<div style="font-size:15px;color:#e7ecf3;line-height:1.75">${r.next_step||''}</div></div>
    <div style="${EM.footer}">
      <b style="color:#aab4c4;font-size:13px">Datos del formulario</b><br>
      Email: ${form.email||'—'} · País: ${form.pais||'—'} · Handle: ${form.handle_principal||'—'}<br>
      Plataformas: IG ${form.instagram||'—'} · YT ${form.youtube||'—'} · TikTok ${form.tiktok||'—'} · Otra ${form.otra||'—'} · Eng ${form.engagement_pct||'—'}%<br>
      Monetización: ${form.monetizacion_actual||'—'} · Ingresos/mes: ${form.ingresos_aprox||'—'} · Equipo: ${form.equipo||'—'}<br>
      Trayectoria: ${form.anios_activo||'—'} años · ${form.frecuencia||'—'} · lista ${form.lista_email||'—'} · lanzamientos ${form.lanzamientos||'—'}<br>
      Objetivo: ${form.objetivo||'—'}<br>Enlaces: ${form.enlaces||'—'}
    </div>
  </div>`;
}

async function sendEmail(form, rating) {
  const token = await gmailToken();
  const avatar = await getAvatar(form).catch(()=>null);
  const subject = `Lead [Tier ${rating.tier} · ${rating.quantum_score}] ${form.nombre||''} — ${form.nicho||''}`;
  const html = emailHtml(form, rating, !!avatar);
  await sendHtmlMail(token, subject, html, avatar);
}

async function handleAudit(form) {
  if(!form || !form.nombre || !form.email) { const e=new Error('missing fields'); e.code=400; throw e; }
  const rating = await score(form);
  await sendEmail(form, rating);
  await logSheet('Interes', [nowES(), form.nombre, form.email, form.nicho||'', form.handle_principal||'', form.instagram||'', form.youtube||'', form.tiktok||'', form.engagement_pct||'', form.monetizacion_actual||'', form.ingresos_aprox||'', form.equipo||'', form.objetivo||'', rating.tier, rating.quantum_score, rating.resumen||'']);
  return { ok:true, tier:rating.tier, score:rating.quantum_score };
}

async function scoreProduct(form) {
  const token = await vertexToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = { systemInstruction:{parts:[{text:PRODUCT_SYS}]}, contents:[{role:'user',parts:[{text:'Auditoría intensiva de producto/servicio del creador:\n'+JSON.stringify(form)}]}], generationConfig:{temperature:0.4,responseMimeType:'application/json',responseSchema:PRODUCT_SCHEMA} };
  const r = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok) throw new Error('vertex '+r.status+' '+await r.text());
  const j = await r.json();
  return JSON.parse(j.candidates[0].content.parts[0].text);
}

function productEmailHtml(form, r, hasAvatar) {
  const o=r.objetivo||{}, s=r.subjetivo||{};
  const vc={GO:'#22d3ee',EXPLORE:'#f59e0b',NO_GO:'#f87171'}[r.veredicto]||'#8b97a8';
  return `<div style="${EM.wrap}">
    ${emHeader('Quantum Ventures · Auditoría de producto/servicio · para el Consejo', form.nombre||'—', form.producto||form.nicho||'', hasAvatar)}
    ${emScore(r.scalability_score, r.veredicto, vc, 'Potencial de escalabilidad')}
    <p style="${EM.para}">${r.resumen||''}</p>
    ${emLabel('Criterios objetivos','#22d3ee')}
    <table style="border-collapse:collapse;margin:0 0 24px">${emRow('Economía unitaria',o.economia_unitaria)}${emRow('Ingresos / recurrencia',o.ingresos_recurrencia)}${emRow('Capacidad / automatización',o.capacidad_automatizacion)}${emRow('Mercado / demanda',o.mercado_demanda)}${emRow('Dependencia fundador',o.dependencia_fundador)}</table>
    ${emLabel('Criterios subjetivos','#a855f7')}
    <table style="border-collapse:collapse;margin:0 0 26px">${emRow('Diferenciación',s.diferenciacion)}${emRow('Marca / autoridad',s.marca_autoridad)}${emRow('Madurez producto',s.madurez_producto)}${emRow('Ambición fundador',s.ambicion_fundador)}${emRow('Encaje QV',s.encaje_qv)}</table>
    ${emLabel('Palancas de crecimiento','#22d3ee')}${emList(r.palancas)}
    ${emLabel('Cuellos de botella','#f59e0b')}${emList(r.cuellos_botella)}
    <div style="${EM.card}">${emLabel('Recomendación para el consejo','#22d3ee')}<div style="font-size:15px;color:#e7ecf3;line-height:1.75">${r.recomendacion_consejo||''}</div></div>
    <div style="${EM.footer}"><b style="color:#aab4c4;font-size:13px">Datos del formulario</b><br>${Object.entries(form).map(([k,v])=>`${k}: ${v}`).join(' · ')}</div>
  </div>`;
}

async function sendProductEmail(form, rating) {
  const token = await gmailToken();
  const avatar = await getAvatar(form).catch(()=>null);
  const subject = `Auditoría producto [${rating.veredicto} · ${rating.scalability_score}] ${form.nombre||''}`;
  const html = productEmailHtml(form, rating, !!avatar);
  await sendHtmlMail(token, subject, html, avatar);
}

async function handleProduct(form) {
  if(!form || !form.nombre || !form.email) { const e=new Error('missing fields'); e.code=400; throw e; }
  const rating = await scoreProduct(form);
  await sendProductEmail(form, rating);
  await logSheet('Producto', [nowES(), form.nombre, form.email, form.nicho_label||form.nicho||'', form.producto||'', form.precio||'', form.margen||'', form.ingresos_mes||'', form.recurrencia||'', rating.veredicto, rating.scalability_score, rating.resumen||'', rating.recomendacion_consejo||'']);
  return { ok:true, veredicto:rating.veredicto, score:rating.scalability_score };
}

// ===== Fiscal / estructura =====
const FISCAL_SYS = `Eres asesor de ESTRUCTURA para Quantum Ventures. Dada la situación fiscal/legal actual de un creador (persona física o empresa, país, residencia fiscal, régimen, IVA, facturación, estructura existente), redacta una NOTA ORIENTATIVA breve para el equipo: estructura recomendada para la colaboración (p. ej. autónomo vs SL; posible holding + SPV por marca según el modelo QV), puntos a validar y banderas/riesgos. IMPORTANTE: NO es asesoramiento fiscal/legal vinculante; indica SIEMPRE que debe validarlo un asesor fiscal/abogado. Responde SOLO JSON.`;
const FISCAL_SCHEMA = { type:'object', properties:{ estructura_recomendada:{type:'string'}, puntos_validar:{type:'array',items:{type:'string'}}, notas:{type:'string'} }, required:['estructura_recomendada','puntos_validar','notas'] };

async function genJSON(sys, schema, prefix, form) {
  const token = await vertexToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = { systemInstruction:{parts:[{text:sys}]}, contents:[{role:'user',parts:[{text:prefix+JSON.stringify(form)}]}], generationConfig:{temperature:0.4,responseMimeType:'application/json',responseSchema:schema} };
  const r = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok) throw new Error('vertex '+r.status+' '+await r.text());
  const j = await r.json(); return JSON.parse(j.candidates[0].content.parts[0].text);
}

function fiscalEmailHtml(form) {
  const row=(k,v)=>`<tr><td style="padding:6px 16px 6px 0;color:#9aa6b8;font-size:14px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#e7ecf3;font-size:14px">${v||'—'}</td></tr>`;
  return `<div style="${EM.wrap}">
    ${emHeader('Quantum Ventures · Datos fiscales para contrato', form.nombre||'—', form.tipo||'', false)}
    <table style="border-collapse:collapse;margin:0 0 18px">
      ${row('Tipo', form.tipo)}${row('Nombre / Razón social', form.nombre)}${row('NIF / CIF', form.nif_cif)}${row('Domicilio fiscal', form.domicilio)}${row('Ciudad', form.ciudad)}${row('CP', form.cp)}${row('País', form.pais)}${row('Representante legal', form.representante)}${row('NIF representante', form.nif_representante)}${row('Email', form.email)}${row('Teléfono', form.telefono)}
    </table>
    <div style="${EM.footer}">Datos recogidos para la redacción del contrato comercial. Guardados en la hoja de registro (pestaña Fiscal).</div>
  </div>`;
}

async function handleFiscal(form) {
  if(!form || !form.nombre || !form.email) { const e=new Error('missing fields'); e.code=400; throw e; }
  const token = await gmailToken();
  await sendHtmlMail(token, `Datos fiscales · ${form.nombre||''} (${form.tipo||''})`, fiscalEmailHtml(form), null);
  await logSheet('Fiscal', [nowES(), form.tipo||'', form.nombre||'', form.nif_cif||'', form.domicilio||'', form.ciudad||'', form.cp||'', form.pais||'', form.representante||'', form.nif_representante||'', form.email||'', form.telefono||'']);
  return { ok:true };
}

// ===== Contactos (CRM personal) con enriquecimiento por búsqueda web (Gemini grounding) =====
async function geminiSearch(prompt) {
  const token = await vertexToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = { contents:[{role:'user',parts:[{text:prompt}]}], tools:[{googleSearch:{}}], generationConfig:{temperature:0.3} };
  const r = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok) throw new Error('vertex '+r.status+' '+await r.text());
  const j = await r.json(); const c = j.candidates && j.candidates[0];
  return ((c && c.content && c.content.parts) || []).map(p=>p.text||'').join('').trim();
}

function contactoEmailHtml(form, enrich) {
  const row=(k,v)=>`<tr><td style="padding:6px 16px 6px 0;color:#9aa6b8;font-size:14px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#e7ecf3;font-size:14px">${v||'—'}</td></tr>`;
  return `<div style="${EM.wrap}">
    ${emHeader('Quantum Ventures · Nuevo contacto', form.nombre||'—', form.tipo_vinculo||'', false)}
    <table style="border-collapse:collapse;margin:0 0 16px">
      ${row('A qué se dedica', form.actividad)}${row('Cómo lo conocí', form.como_conoci)}${row('Por qué es interesante', form.por_que)}${row('Tipo de vínculo', form.tipo_vinculo)}${row('Links / Redes', form.links)}
    </table>
    ${enrich ? `<div style="${EM.card}">${emLabel('Enriquecimiento (búsqueda en internet)','#22d3ee')}<div style="font-size:14px;color:#e7ecf3;line-height:1.7;white-space:pre-wrap">${enrich.replace(/</g,'&lt;')}</div></div>` : ''}
    <div style="${EM.footer}">Guardado en tu hoja de contactos.</div>
  </div>`;
}

async function handleContacto(form) {
  if(!form || !form.nombre) { const e=new Error('missing fields'); e.code=400; throw e; }
  let enrich = '';
  const wants = (''+(form.buscar||'')).toLowerCase();
  if (wants==='si' || wants==='sí' || wants==='true' || wants==='1' || wants==='on') {
    try {
      const q = `Eres analista de Quantum Ventures. Investiga en internet quién es esta persona/marca y su potencial para alianzas comerciales (rev share, servicios, ampliar red). Nombre: ${form.nombre}. Actividad: ${form.actividad||''}. Links/redes: ${form.links||''}. Devuelve en español: (1) Quién es, 2-3 líneas; (2) Relevancia/tamaño si aplica (audiencia, empresa...); (3) Potencial comercial concreto para QV en 3-4 puntos. Si no encuentras información fiable, indícalo claramente.`;
      enrich = await geminiSearch(q);
    } catch(e) { enrich = '(No se pudo enriquecer automáticamente: ' + e.message + ')'; }
  }
  const token = await gmailToken();
  await sendHtmlMail(token, `Nuevo contacto · ${form.nombre}`, contactoEmailHtml(form, enrich), null);
  await logSheet('Contactos', [nowES(), form.nombre, form.actividad||'', form.como_conoci||'', form.por_que||'', form.tipo_vinculo||'', form.links||'', enrich]);
  return { ok:true, enriched: !!enrich };
}

if (require.main === module) {
  const server = http.createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin', CORS);
    res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }
    if(req.method==='GET' && req.url==='/health'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"ok":true}'); }
    if(req.method==='POST' && (req.url==='/api/audit' || req.url==='/api/audit-product' || req.url==='/api/fiscal' || req.url==='/api/contacto')){
      const handler = req.url==='/api/audit-product' ? handleProduct : req.url==='/api/fiscal' ? handleFiscal : req.url==='/api/contacto' ? handleContacto : handleAudit;
      let body=''; req.on('data',c=>{body+=c; if(body.length>1e6) req.destroy();});
      req.on('end', async ()=>{
        try{ const form=JSON.parse(body||'{}'); const out=await handler(form); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(out)); }
        catch(e){ const code=e.code===400?400:500; console.error('audit error:', e.message); res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:code===400?'missing fields':'internal'})); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(process.env.PORT||8080, ()=>console.log('QV audit API on '+(process.env.PORT||8080)));
}

module.exports = { score, sendEmail, handleAudit, scoreProduct, handleProduct, emailHtml, productEmailHtml, getAvatar, primaryProfile, handleFiscal, logSheet, handleContacto, geminiSearch };
