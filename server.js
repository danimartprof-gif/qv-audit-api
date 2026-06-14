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
const CLIENTS_FOLDER = process.env.QV_CLIENTS_FOLDER || '';

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
async function sheetRead(tab, range) {
  if (!SHEET_ID) return [];
  try {
    const token = await gmailToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab+'!'+range)}`;
    const r = await fetch(url, { headers:{Authorization:`Bearer ${token}`} });
    if (!r.ok) { console.error('sheet read', tab, r.status); return []; }
    const j = await r.json(); return j.values || [];
  } catch (e) { console.error('sheet read error:', e.message); return []; }
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
      Objetivo: ${form.objetivo||'—'}<br>Enlaces: ${form.enlaces||'—'}<br>
      <b style="color:#aab4c4">Web:</b> Dominio: ${form.dominio||'—'} (${form.dominio_registrador||'—'}) · Web actual: ${form.web_actual||'—'} · Branding: ${form.branding||'—'}${form.web_objetivo?`<br>Quiere transmitir: ${form.web_objetivo}`:''}
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

// Materiales que pedimos al cliente para construir su web de marca personal
function webMaterialsEmailHtml(form, folderUrl) {
  const li = (t)=>`<li style="margin:0 0 9px;color:#cbd5e1;font-size:14px;line-height:1.7">${t}</li>`;
  return `<div style="${EM.wrap}">
    ${emHeader('Quantum Ventures · Tu web de marca personal', form.nombre||'—', form.nicho||'', false)}
    <p style="${EM.para}">Hemos recibido tu auditoría. Para montar tu web de marca personal hemos creado un <b style="color:#e7ecf3">espacio privado en Drive</b> solo para ti. Sube ahí todo lo que puedas y nosotros nos encargamos del resto (diseño, desarrollo y conexión de tu dominio a nuestros servidores).</p>
    <div style="${EM.card}">${emLabel('Tu carpeta privada','#22d3ee')}<div style="font-size:14px"><a href="${folderUrl}" style="color:#22d3ee">${folderUrl}</a></div></div>
    ${emLabel('Lo que necesitamos de ti','#22d3ee')}
    <ul style="margin:0 0 22px;padding-left:20px">
      ${li('<b>Dominio:</b> '+(form.dominio&&form.dominio.toLowerCase()!=='no tengo'?`${form.dominio} — danos acceso al panel de ${form.dominio_registrador||'tu registrador'} (o los DNS) para conectarlo.`:'si no tienes, te lo registramos nosotros.'))}
      ${li('<b>Logo y branding:</b> logo en alta calidad, colores y tipografías si los tienes.')}
      ${li('<b>Fotos y vídeos tuyos:</b> retratos, entrenando, lifestyle, en buena calidad.')}
      ${li('<b>Textos:</b> quién eres, tu historia, a quién ayudas y tu promesa.')}
      ${li('<b>Servicios / productos:</b> qué vendes, precios y qué incluye cada uno.')}
      ${li('<b>Pruebas sociales:</b> testimonios, antes/después, resultados de clientes, logos de marcas.')}
      ${li('<b>Redes y enlaces:</b> Instagram, YouTube, TikTok, WhatsApp, etc.')}
      ${li('<b>Referencias:</b> 2-3 webs que te gusten (de estilo o de competencia).')}
    </ul>
    <div style="${EM.footer}">Cualquier duda, responde a este email. — Equipo Quantum Ventures</div>
  </div>`;
}
async function sendClientMail(token, to, subject, html) {
  const head = [`From: Quantum Ventures <${SENDER}>`, `To: ${to}`, `Bcc: ${RECIPIENTS}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', '', html];
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({raw:b64url(head.join('\r\n'))})});
  if (!r.ok) throw new Error('gmail client send '+r.status+' '+await r.text());
}
// Al recibir la auditoría de marca personal: crea espacio Drive del cliente + le pide los materiales de la web
async function autoOnboardWeb(form) {
  if (!CLIENTS_FOLDER) { console.error('autoOnboard: no CLIENTS_FOLDER'); return; }
  const token = await gmailToken();
  const root = await driveCreateFolder(token, form.nombre.trim(), CLIENTS_FOLDER);
  for (const sub of CLIENT_SUBFOLDERS) { try { await driveCreateFolder(token, sub, root.id); } catch(e){ console.error('subfolder', sub, e.message); } }
  if (form.email) { try { await driveShare(token, root.id, form.email.trim()); } catch(e){ console.error('share', e.message); } }
  await logSheet('Clientes', [nowES(), form.nombre, form.email||'', root.webViewLink||'', form.dominio||'', 'web-auditoria']);
  try { await sendClientMail(token, form.email.trim(), `Tu web de marca personal · ${form.nombre} — siguientes pasos`, webMaterialsEmailHtml(form, root.webViewLink)); } catch(e){ console.error('web materials mail', e.message); }
  return root.webViewLink;
}

// ===== Respuesta automática al influencer al recibir cada auditoría =====
const AUDIT_FORMS = {
  marca:    { tab:'Interes',  label:'tu auditoría de marca personal',        otherLabel:'la auditoría de tu producto o servicio', otherUrl:'https://quantumventures.io/auditoria-servicio' },
  producto: { tab:'Producto', label:'la auditoría de tu producto o servicio', otherLabel:'tu auditoría de marca personal',          otherUrl:'https://quantumventures.io/auditoria' }
};
async function emailInTab(tab, email) {
  const e = (''+(email||'')).trim().toLowerCase();
  if (!e) return false;
  const rows = await sheetRead(tab, 'A2:C');
  return rows.some(r => (''+(r[2]||'')).trim().toLowerCase() === e);
}
const emBtn = (href,txt)=>`<a href="${href}" style="display:inline-block;background:linear-gradient(100deg,#22d3ee,#6366f1);color:#06070d;font-weight:700;border-radius:999px;padding:13px 26px;text-decoration:none;font-size:15px">${txt}</a>`;
const emStep = (n,done,txt)=>`<tr><td style="padding:6px 12px 6px 0;vertical-align:middle"><span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;border-radius:50%;font-size:13px;font-weight:700;${done?'background:linear-gradient(100deg,#22d3ee,#6366f1);color:#06070d':'background:#1b2233;color:#8b97a8;border:1px solid rgba(255,255,255,.14)'}">${done?'✓':n}</span></td><td style="padding:6px 0;color:${done?'#e7ecf3':'#9aa6b8'};font-size:14.5px;vertical-align:middle">${txt}${done?' <span style="color:#34d399;font-size:13px">· recibida</span>':''}</td></tr>`;
function ackReceivedHtml(form, kind) {
  const cfg = AUDIT_FORMS[kind];
  const first = ((form.nombre||'').trim().split(/\s+/)[0]) || 'Hola';
  return `<div style="${EM.wrap}">
    ${emHeader('Quantum Ventures · Auditoría privada', first, 'paso recibido', false)}
    <p style="${EM.para}">Hemos recibido ${cfg.label} ✓. Nuestro equipo ya la tiene y la analizará de forma privada.</p>
    <div style="${EM.card}">
      ${emLabel('Tu auditoría, en dos pasos','#22d3ee')}
      <table style="border-collapse:collapse;margin:0 0 16px">${kind==='marca'?emStep(1,true,'Marca personal')+emStep(2,false,'Producto o servicio'):emStep(1,false,'Marca personal')+emStep(2,true,'Producto o servicio')}</table>
      <p style="color:#aab4c4;font-size:14px;line-height:1.7;margin:0 0 18px">Te falta un paso: completa también ${cfg.otherLabel}. Juntas nos dan la foto completa de tu marca y tu negocio — y con eso te preparamos el análisis y los siguientes pasos.</p>
      ${emBtn(cfg.otherUrl,'Completar el paso que falta →')}
    </div>
    <div style="${EM.footer}">En cuanto tengamos los dos pasos, te respondemos a este email con tus resultados.<br>— Equipo Quantum Ventures · quantumventures.io</div>
  </div>`;
}
function ackCompleteHtml(form) {
  const first = ((form.nombre||'').trim().split(/\s+/)[0]) || 'Hola';
  return `<div style="${EM.wrap}">
    ${emHeader('Quantum Ventures · Auditoría completa', first, 'los dos pasos recibidos', false)}
    <p style="${EM.para}">Tu auditoría está <b style="color:#e7ecf3">completa</b> ✓✓. Ya tenemos los dos pasos — tu marca personal y tu producto o servicio — y nuestro equipo está analizando tu caso en privado.</p>
    <div style="${EM.card}">
      ${emLabel('Qué pasa ahora','#22d3ee')}
      <ul style="margin:0;padding-left:20px">
        <li style="margin:0 0 9px;color:#cbd5e1;font-size:14px;line-height:1.7">Analizamos tu marca, tu audiencia y tu negocio con nuestro sistema.</li>
        <li style="margin:0 0 9px;color:#cbd5e1;font-size:14px;line-height:1.7">Medimos la brecha entre tu monetización actual y tu potencial real.</li>
        <li style="margin:0;color:#cbd5e1;font-size:14px;line-height:1.7">Te respondemos a este email con tus resultados y los siguientes pasos.</li>
      </ul>
    </div>
    <p style="${EM.para}">No tienes que hacer nada más. Si quieres adelantarnos algo, responde a este email.</p>
    <div style="${EM.footer}">— Equipo Quantum Ventures · quantumventures.io</div>
  </div>`;
}
async function sendAuditAck(form, kind) {
  if (!form.email) return;
  const cfg = AUDIT_FORMS[kind];
  const otherTab = kind==='marca' ? AUDIT_FORMS.producto.tab : AUDIT_FORMS.marca.tab;
  const complete = await emailInTab(otherTab, form.email);
  const token = await gmailToken();
  const first = ((form.nombre||'').trim().split(/\s+/)[0]) || '';
  const subject = complete ? `${first?first+', tu':'Tu'} auditoría está completa ✓ — ya estamos analizando tu caso`
                           : `Hemos recibido ${kind==='marca'?'tu auditoría de marca personal':'la auditoría de tu producto'} ✓ — te falta 1 paso`;
  await sendClientMail(token, form.email.trim(), subject, complete ? ackCompleteHtml(form) : ackReceivedHtml(form, kind));
}

async function handleAudit(form) {
  if(!form || !form.nombre || !form.email) { const e=new Error('missing fields'); e.code=400; throw e; }
  const rating = await score(form);
  await sendEmail(form, rating);
  await logSheet('Interes', [nowES(), form.nombre, form.email, form.nicho||'', form.handle_principal||'', form.instagram||'', form.youtube||'', form.tiktok||'', form.engagement_pct||'', form.monetizacion_actual||'', form.ingresos_aprox||'', form.equipo||'', form.objetivo||'', rating.tier, rating.quantum_score, rating.resumen||'', form.dominio||'', form.web_actual||'']);
  try { await sendAuditAck(form, 'marca'); } catch(e){ console.error('ack marca error:', e.message); }
  let folder = '';
  try { folder = await autoOnboardWeb(form) || ''; } catch(e){ console.error('autoOnboardWeb error:', e.message); }
  return { ok:true, tier:rating.tier, score:rating.quantum_score, folder };
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
  try { await sendAuditAck(form, 'producto'); } catch(e){ console.error('ack producto error:', e.message); }
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

// ===== Proyecto Villa Brisa (Bali) — formulario de propiedades =====
const VILLA_SHEET = process.env.VILLA_SHEET_ID || '';
function villaEmailHtml(form) {
  const row=(k,v)=>`<tr><td style="padding:6px 16px 6px 0;color:#9aa6b8;font-size:14px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#e7ecf3;font-size:14px">${v||'—'}</td></tr>`;
  return `<div style="${EM.wrap}">
    ${emHeader('Proyecto Villa Brisa · Ficha de propiedad', form.villa||'—', form.modalidad||'', false)}
    ${emLabel('La villa','#22d3ee')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Ubicación',form.ubicacion)}${row('Enlaces',form.enlaces)}${row('Habitaciones / Baños',(form.habitaciones||'—')+' / '+(form.banos||'—'))}${row('Huéspedes',form.huespedes)}${row('M2',form.m2)}${row('Piscina y extras',form.extras)}</table>
    ${emLabel('Servicios y situación actual','#22d3ee')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Servicios incluidos',form.servicios)}${row('¿Alquilada ahora?',form.alquilada)}${row('Canales actuales',form.canales)}${row('Precio actual',form.precio_actual)}${row('Ocupación',form.ocupacion)}${row('Licencia turística',form.licencia)}</table>
    ${emLabel('Modelo deseado','#a855f7')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Modalidad',form.modalidad)}${row('Precio objetivo',form.precio_objetivo)}${row('Estancia mínima',form.estancia_min)}${row('Disponibilidad',form.disponibilidad)}${row('Restricciones',form.restricciones)}</table>
    ${emLabel('Colaboración con agencias','#34d399')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Tipo de acuerdo',form.tipo_acuerdo)}${row('% / condiciones',form.condiciones)}${row('Exclusividad',form.exclusividad)}${row('Mercados objetivo',form.mercados)}${row('Qué debe cubrir la agencia',form.cobertura)}${row('Objetivo ingresos/mes',form.objetivo_ingresos)}</table>
    <div style="${EM.footer}">Contacto: ${form.contacto||'—'} · ${form.email||'—'} · ${form.telefono||'—'}<br>${form.comentarios?('Comentarios: '+form.comentarios+'<br>'):''}Guardado en la hoja "Villa Brisa — Formularios de propiedades" (Drive del proyecto).</div>
  </div>`;
}
async function handleVilla(form) {
  if(!form || !form.villa || !form.email) { const e=new Error('missing fields'); e.code=400; throw e; }
  const token = await gmailToken();
  await sendHtmlMail(token, `Villa Brisa · Ficha recibida — ${form.villa} (${form.modalidad||''})`, villaEmailHtml(form), null);
  if (VILLA_SHEET) {
    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${VILLA_SHEET}/values/${encodeURIComponent('Villas')}!A1:append?valueInputOption=RAW`;
      const row = [nowES(), form.villa||'', form.ubicacion||'', form.enlaces||'', form.habitaciones||'', form.banos||'', form.huespedes||'', form.m2||'', form.extras||'', form.servicios||'', form.alquilada||'', form.canales||'', form.precio_actual||'', form.ocupacion||'', form.licencia||'', form.modalidad||'', form.precio_objetivo||'', form.estancia_min||'', form.disponibilidad||'', form.restricciones||'', form.tipo_acuerdo||'', form.condiciones||'', form.exclusividad||'', form.mercados||'', form.cobertura||'', form.objetivo_ingresos||'', form.contacto||'', form.email||'', form.telefono||'', form.comentarios||''];
      const r = await fetch(url, { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({ values:[row] }) });
      if (!r.ok) console.error('villa sheet', r.status, await r.text());
    } catch(e){ console.error('villa sheet error:', e.message); }
  }
  try { await sendClientMail(token, form.email.trim(), `Hemos recibido la ficha de ${form.villa} ✓ — Proyecto Villa Brisa`,
    `<div style="${EM.wrap}">${emHeader('Proyecto Villa Brisa · Bali', (form.contacto||'').split(/\s+/)[0]||'Hola', 'ficha recibida', false)}
    <p style="${EM.para}">Hemos recibido la ficha de <b style="color:#e7ecf3">${form.villa}</b> ✓. Con esta información preparamos el dossier de la propiedad y arrancamos la búsqueda de agencias partner en los mercados que nos has indicado (${form.mercados||'por definir'}).</p>
    <p style="${EM.para}">Si tienes la segunda villa pendiente, rellena también su ficha — cada propiedad lleva su propio dossier.</p>
    <div style="${EM.footer}">— Equipo del proyecto · te contactaremos con los siguientes pasos</div></div>`); } catch(e){ console.error('villa ack', e.message); }
  return { ok:true };
}

// ===== Brave The World — auditoría de negocio =====
function braveEmailHtml(f) {
  return `<div style="${EM.wrap}">
    ${emHeader('Brave The World · Auditoría', (f.nombre||'').split(/\s+/)[0]||'Equipo', 'nueva auditoría recibida', true)}
    ${emLabel('Contacto','#f97316')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Nombre',f.nombre)}${row('Email',f.email)}${row('Teléfono',f.telefono)}${row('Mejor hora',f.hora_contacto)}</table>
    ${emLabel('Números del negocio','#2dd4bf')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Clientes 12m',f.clientes_12m)}${row('Ticket medio',f.ticket_medio)}${row('Facturación mensual',f.facturacion_mensual)}${row('Margen %',f.margen)}${row('Plazas por grupo',f.plazas_grupo)}${row('Viajes/año actual',f.viajes_anuales)}</table>
    ${emLabel('Llenar viajes','#f97316')}<p style="${EM.para}">${f.llenar_viajes||'—'}</p>
    ${emLabel('Proceso de ventas','#2dd4bf')}<p style="${EM.para}">${f.proceso_ventas||'—'}</p>
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Leads/mes',f.leads_mes)}${row('Ventas/mes',f.ventas_mes)}${row('Objeción principal',f.objecion_principal)}${row('CRM actual',f.crm)}${row('Horas/sem ventas',f.horas_ventas)}</table>
    ${emLabel('Canales de captación','#f97316')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Instagram',f.canal_instagram)}${row('TikTok',f.canal_tiktok)}${row('YouTube',f.canal_youtube)}${row('Google orgánico',f.canal_google)}${row('Meta Ads',f.canal_metaads)}${row('Google Ads',f.canal_googleads)}${row('Boca a boca',f.canal_bocaaboca)}${row('Influencers',f.canal_influencers)}${row('Email marketing',f.canal_email)}${row('WhatsApp',f.canal_whatsapp)}</table>
    <table style="border-collapse:collapse;margin:0 0 18px">${row('IG seguidores',f.ig_seguidores)}${row('IG alcance medio',f.ig_alcance)}${row('Budget ads/mes',f.budget_ads)}${row('Lista emails',f.lista_emails)}</table>
    ${emLabel('Tracking clientes','#2dd4bf')}<p style="${EM.para}">${f.tracking_clientes||'—'}</p>
    ${emLabel('Programa de gimnasios','#f97316')}
    <p style="${EM.para}">${f.gimnasios_contactados||'—'}</p>
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Estimación gimnasios ES',f.estimacion_gimnasios)}${row('Estructura comisión',f.estructura_comision)}${row('Landing co-branded',f.landing_cobranded)}${row('Freno actual',f.freno_gimnasios)}</table>
    ${emLabel('Tipo de socios','#2dd4bf')}<p style="${EM.para}">${f.tipo_socios||'—'}</p>
    ${emLabel('Web y herramientas','#f97316')}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Tech web',f.tech_web)}${row('Visitas/mes',f.visitas_web)}${row('SEO actual',f.seo_actual)}${row('Google My Business',f.gmb)}${row('Usa GHL',f.usa_ghl)}${row('Presupuesto/mes tools',f.presupuesto_mensual)}</table>
    ${emLabel('Objetivos','#2dd4bf')}
    <p style="${EM.para}"><b>Objetivo principal:</b> ${f.objetivo_principal||'—'}</p>
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Partners objetivo (6m)',f.objetivo_partners)}${row('Facturación objetivo (12m)',f.objetivo_facturacion)}${row('Viajes/año objetivo',f.objetivo_viajes)}</table>
    <p style="${EM.para}"><b>Prioridades:</b><br>${(f.prioridades||'—').replace(/\n/g,'<br>')}</p>
    ${f.otro?`<p style="${EM.para}"><b>Otros comentarios:</b><br>${f.otro.replace(/\n/g,'<br>')}</p>`:''}
    <div style="${EM.footer}">Formulario Brave The World · ${f.email||'—'} · ${f.telefono||'—'}</div>
  </div>`;
}
async function handleBraveTheWorld(form) {
  if(!form || !form.nombre || !form.email) { const e=new Error('missing fields'); e.code=400; throw e; }
  const token = await gmailToken();
  await sendHtmlMail(token, `Brave The World · Auditoría recibida — ${form.nombre}`, braveEmailHtml(form), null);
  try { await sendClientMail(token, form.email.trim(), `Auditoría recibida · Brave The World ✓`,
    `<div style="${EM.wrap}">${emHeader('Brave The World', (form.nombre||'').split(/\s+/)[0]||'Hola', 'auditoría recibida', false)}
    <p style="${EM.para}">Hemos recibido vuestras respuestas ✓. Dani revisará todo y os contactará en menos de 48h con los próximos pasos para construir vuestro sistema de ventas escalable.</p>
    <p style="${EM.para}">Si tenéis algo que añadir, escribidnos directamente por WhatsApp.</p>
    <div style="${EM.footer}">— Dani Martínez · Quantum Ventures</div></div>`);
  } catch(e){ console.error('btw ack', e.message); }
  return { ok:true };
}

// ===== Jaan España — pipeline de venues (form + CRM real) =====
const JAAN_SHEET = process.env.JAAN_SHEET_ID || '';
const JAAN_KEY = process.env.JAAN_KEY || '';
const JAAN_STAGES = ['Nuevo contacto','Análisis completado','Interesado','Muestras / piloto','Propuesta formal','Negociación','GANADO','Descartado'];
function jaanEmailHtml(form, id) {
  const row=(k,v)=>`<tr><td style="padding:6px 16px 6px 0;color:#9aa6b8;font-size:14px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#e7ecf3;font-size:14px">${v||'—'}</td></tr>`;
  return `<div style="${EM.wrap}">
    ${emHeader('Jaan España · Nuevo venue en el pipeline', form.local||'—', form.ciudad||'', false)}
    <table style="border-collapse:collapse;margin:0 0 18px">${row('Tipo',form.tipo)}${row('Contacto',(form.contacto||'')+(form.cargo?(' · '+form.cargo):''))}${row('Email',form.email)}${row('Teléfono/WhatsApp',form.telefono)}${row('Agua premium actual',form.agua_actual)}${row('Coste botella',form.coste)}${row('PVP en mesa',form.pvp)}${row('Consumo mensual',form.consumo)}${row('Interés',form.interes)}${row('Referido por',form.referido)}${row('Comentarios',form.comentarios)}</table>
    <div style="${EM.footer}">ID ${id} · Etapa inicial: Nuevo contacto · CRM: quantumventures.io/crm-jaan · Hoja "Jaan España — Pipeline de venues"</div>
  </div>`;
}
async function handleJaanVenue(form) {
  if(!form || !form.local || !form.contacto) { const e=new Error('missing fields'); e.code=400; throw e; }
  const token = await gmailToken();
  const id = 'V'+Date.now().toString(36).toUpperCase();
  if (JAAN_SHEET) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${JAAN_SHEET}/values/${encodeURIComponent('Pipeline')}!A1:append?valueInputOption=RAW`;
    const row = [id, nowES(), 'Nuevo contacto', form.local||'', form.tipo||'', form.ciudad||'', form.contacto||'', form.cargo||'', form.email||'', form.telefono||'', form.agua_actual||'', form.coste||'', form.pvp||'', form.consumo||'', form.interes||'', form.referido||'Magalis', form.comentarios||''];
    const r = await fetch(url, { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({ values:[row] }) });
    if (!r.ok) console.error('jaan sheet', r.status, await r.text());
  }
  try { await sendHtmlMail(token, `Jaan 💧 Nuevo venue: ${form.local} (${form.ciudad||'—'})`, jaanEmailHtml(form, id), null); } catch(e){ console.error('jaan mail', e.message); }
  return { ok:true, id };
}
async function handleJaanPipeline(key) {
  if (!JAAN_KEY || key !== JAAN_KEY) { const e=new Error('forbidden'); e.code=403; throw e; }
  const token = await gmailToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${JAAN_SHEET}/values/${encodeURIComponent('Pipeline')}!A2:Q500`, { headers:{Authorization:`Bearer ${token}`} });
  const j = r.ok ? await r.json() : {};
  const H2 = ['id','fecha','etapa','local','tipo','ciudad','contacto','cargo','email','telefono','agua_actual','coste','pvp','consumo','interes','referido','comentarios'];
  return { ok:true, stages: JAAN_STAGES, leads: (j.values||[]).map(v=>Object.fromEntries(H2.map((h,i)=>[h, v[i]||'']))) };
}
async function handleJaanStage(form) {
  if (!JAAN_KEY || form.k !== JAAN_KEY) { const e=new Error('forbidden'); e.code=403; throw e; }
  if (!form.id || !JAAN_STAGES.includes(form.etapa)) { const e=new Error('missing fields'); e.code=400; throw e; }
  const token = await gmailToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${JAAN_SHEET}/values/${encodeURIComponent('Pipeline')}!A1:A500`, { headers:{Authorization:`Bearer ${token}`} });
  const vals = r.ok ? (await r.json()).values||[] : [];
  const idx = vals.findIndex(v=>(v[0]||'')===form.id);
  if (idx < 0) { const e=new Error('missing fields'); e.code=400; throw e; }
  const u = `https://sheets.googleapis.com/v4/spreadsheets/${JAAN_SHEET}/values/${encodeURIComponent('Pipeline')}!C${idx+1}?valueInputOption=RAW`;
  const r2 = await fetch(u, { method:'PUT', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({ values:[[form.etapa]] }) });
  if (!r2.ok) throw new Error('stage update '+r2.status);
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
      ${row('Teléfono', form.telefono)}${row('A qué se dedica', form.actividad)}${row('Cómo lo conocí', form.como_conoci)}${row('Por qué es interesante', form.por_que)}${row('Tipo de vínculo', form.tipo_vinculo)}${row('Links / Redes', form.links)}${row('Contexto', form.contexto)}
    </table>
    ${enrich ? `<div style="${EM.card}">${emLabel('Perfil enriquecido · LinkedIn, webs y proyectos','#22d3ee')}<div style="font-size:14px;color:#e7ecf3;line-height:1.7;white-space:pre-wrap">${enrich.replace(/</g,'&lt;')}</div></div>` : ''}
    <div style="${EM.footer}">Guardado en tu hoja de contactos.</div>
  </div>`;
}

async function handleContacto(form) {
  if(!form || !form.nombre) { const e=new Error('missing fields'); e.code=400; throw e; }
  let enrich = '';
  const wants = (''+(form.buscar||'')).toLowerCase();
  if (wants==='si' || wants==='sí' || wants==='true' || wants==='1' || wants==='on') {
    try {
      const q = `Eres analista de RED DE CONTACTOS DE ALTO VALOR de Quantum Ventures. Investiga en internet (LinkedIn si está disponible, webs relacionadas, empresas y proyectos en los que participa) para COMPLETAR el perfil de este contacto. Objetivo: evaluar su valor para (a) colaboraciones estratégicas — financiación, abrir mercados, partnership, rev share — y (b) posibles CONTRATACIONES / incorporación al equipo.
DATOS BASE: Nombre: ${form.nombre}. Teléfono: ${form.telefono||'(no aportado)'} (solo dato, no buscable). Actividad: ${form.actividad||'(desconocida)'}. Links/redes: ${form.links||'(ninguno)'}. Contexto aportado: ${form.contexto||form.por_que||'(ninguno)'}.
Devuelve en español, estructurado y conciso: 1) QUIÉN ES (2-3 líneas); 2) LINKEDIN / rol actual / trayectoria; 3) EMPRESAS Y PROYECTOS actuales; 4) WEBS Y PRESENCIA online; 5) POTENCIAL DE COLABORACIÓN ESTRATÉGICA para QV (financiación / abrir mercados / partnership / rev share), concreto; 6) POTENCIAL DE CONTRATACIÓN (qué rol o aporte podría encajar); 7) PRÓXIMO PASO sugerido; 8) FIABILIDAD: qué has verificado y qué no. Si no encuentras info fiable de un punto, dilo en lugar de inventar.`;
      enrich = await geminiSearch(q);
    } catch(e) { enrich = '(No se pudo enriquecer automáticamente: ' + e.message + ')'; }
  }
  const token = await gmailToken();
  await sendHtmlMail(token, `Nuevo contacto · ${form.nombre}`, contactoEmailHtml(form, enrich), null);
  await logSheet('Contactos', [nowES(), form.nombre, form.telefono||'', form.actividad||'', form.como_conoci||'', form.por_que||'', form.tipo_vinculo||'', form.links||'', form.contexto||'', enrich]);
  return { ok:true, enriched: !!enrich };
}

// ===== Venue lead (Bali) — captación de hoteles/restaurantes para suministro de agua =====
function venueEmailHtml(form) {
  const row=(k,v)=>`<tr><td style="padding:6px 16px 6px 0;color:#9aa6b8;font-size:14px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#e7ecf3;font-size:14px">${v||'—'}</td></tr>`;
  return `<div style="${EM.wrap}">
    ${emHeader('Tigris × Quantum Ventures · New venue lead (Bali)', form.venue||'—', form.type||'', false)}
    <p style="${EM.para}">A venue in Bali submitted its current water supply. The team should follow up.</p>
    ${emLabel('Contact','#22d3ee')}
    <table style="border-collapse:collapse;margin:0 0 22px">
      ${row('Venue', form.venue)}${row('Type', form.type)}${row('Contact', form.contact_name)}${row('Phone / WhatsApp', form.phone)}${row('Email', form.email)}${row('Area / location', form.location)}
    </table>
    ${emLabel('Premium bottled water (current)','#22d3ee')}
    <table style="border-collapse:collapse;margin:0 0 22px">
      ${row('Brand', form.premium_brand)}${row('Monthly volume', form.premium_volume)}${row('Current supplier', form.premium_supplier)}${row('Price paid', form.premium_price)}
    </table>
    ${emLabel('Gallon &amp; everyday water (current)','#a855f7')}
    <table style="border-collapse:collapse;margin:0 0 22px">
      ${row('Brand', form.canned_brand)}${row('Monthly volume', form.canned_volume)}${row('Current supplier', form.canned_supplier)}${row('Price paid', form.canned_price)}
    </table>
    ${form.notes?`<div style="${EM.card}">${emLabel('Notes','#22d3ee')}<div style="font-size:14px;color:#e7ecf3;line-height:1.7">${(''+form.notes).replace(/</g,'&lt;')}</div></div>`:''}
    <div style="${EM.footer}">Lead captured via quantumventures.io/bali/supply · saved to the tracking sheet (Venues tab).</div>
  </div>`;
}

async function handleVenue(form) {
  if(!form || !form.venue || !(form.phone||form.email)) { const e=new Error('missing fields'); e.code=400; throw e; }
  const ref = (form.ref||'').trim();
  const token = await gmailToken();
  await sendHtmlMail(token, `Venue lead (Bali) · ${form.venue||''}${form.type?(' — '+form.type):''}${ref?(' · ref:'+ref):''}`, venueEmailHtml(form), null);
  await logSheet('Venues', [nowES(), form.venue||'', form.type||'', form.contact_name||'', form.phone||'', form.email||'', form.location||'', form.premium_brand||'', form.premium_volume||'', form.premium_supplier||'', form.premium_price||'', form.canned_brand||'', form.canned_volume||'', form.canned_supplier||'', form.canned_price||'', form.notes||'', ref]);
  return { ok:true };
}

// ===== Ambassadors (influencers que representan la marca) — alta + listado para prueba social =====
function slugCode(s){ return (''+(s||'')).toLowerCase().replace(/[^a-z0-9]+/g,'').slice(0,16); }
const isApproved = (v)=>['approved','aprobado','si','sí','true','1','yes','y','on'].includes((''+(v||'')).trim().toLowerCase());

async function handleAmbassador(form) {
  if(!form || !form.handle) { const e=new Error('missing fields'); e.code=400; throw e; }
  const platform = (form.plataforma||'instagram').toLowerCase().trim();
  const handle = (form.handle||'').replace(/^@/,'').replace(/.*\//,'').trim();
  const code = slugCode(form.code || handle);
  const estado = isApproved(form.aprobado!==undefined?form.aprobado:'approved') ? 'approved' : 'pending';
  await logSheet('Ambassadors', [nowES(), form.nombre||'', platform, handle, form.nicho||'', form.followers||'', code, estado, form.notas||'']);
  try { const token = await gmailToken(); await sendHtmlMail(token, `Embajador ${estado} · ${form.nombre||handle} (@${handle})`, `<div style="${EM.wrap}">${emHeader('Quantum Ventures · Nuevo embajador',form.nombre||('@'+handle),platform,false)}<p style="${EM.para}">Estado: <b style="color:#22d3ee">${estado}</b> · Código: <b>${code}</b> · Nicho: ${form.nicho||'—'} · Followers: ${form.followers||'—'}</p><div style="${EM.footer}">Si está approved, ya aparece en la web y formularios (prueba social). Link de referido: quantumventures.io/bali/supply?ref=${code}</div></div>`, null); } catch(e){ console.error('amb email', e.message); }
  return { ok:true, code, estado };
}

async function getAmbassadors() {
  const rows = await sheetRead('Ambassadors', 'A2:I1000');
  const seen = new Set(); const out = [];
  for (const r of rows) {
    if ((r[7]||'').trim().toLowerCase() !== 'approved') continue;
    const platform = (r[2]||'instagram').toLowerCase().trim();
    const handle = (r[3]||'').replace(/^@/,'').trim();
    if (!handle || seen.has(platform+'/'+handle)) continue;
    seen.add(platform+'/'+handle);
    out.push({ name:r[1]||'', platform, handle, niche:r[4]||'', code:r[6]||'', avatar:`https://unavatar.io/${platform}/${encodeURIComponent(handle)}` });
  }
  return out;
}

// ===== Cliente: crea estructura de carpetas en Drive + comparte =====
const CLIENT_SUBFOLDERS = ['00 · Marca (branding previo)','01 · Negocio','02 · Contenido (emails y landings)','03 · Fotos y vídeo','04 · Legal y fiscal','05 · Entregables QV'];

async function driveCreateFolder(token, name, parent) {
  const body = { name, mimeType:'application/vnd.google-apps.folder' };
  if (parent) body.parents = [parent];
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if (!r.ok) throw new Error('drive folder '+r.status+' '+await r.text());
  return r.json();
}
async function driveShare(token, fileId, email) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=true`, {method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({ role:'writer', type:'user', emailAddress:email })});
  if (!r.ok) throw new Error('drive share '+r.status+' '+await r.text());
  return r.json();
}

async function handleCliente(form) {
  if(!form || !form.nombre) { const e=new Error('missing fields'); e.code=400; throw e; }
  if(!CLIENTS_FOLDER) { const e=new Error('clients folder not configured'); e.code=500; throw e; }
  const token = await gmailToken();
  const root = await driveCreateFolder(token, form.nombre.trim(), CLIENTS_FOLDER);
  for (const sub of CLIENT_SUBFOLDERS) { try { await driveCreateFolder(token, sub, root.id); } catch(e){ console.error('subfolder', sub, e.message); } }
  if (form.email) { try { await driveShare(token, root.id, form.email.trim()); } catch(e){ console.error('share', e.message); } }
  await logSheet('Clientes', [nowES(), form.nombre, form.email||'', root.webViewLink||'']);
  try {
    const html = `<div style="${EM.wrap}">${emHeader('Quantum Ventures · Carpeta de cliente creada', form.nombre, form.email||'', false)}<p style="${EM.para}">Carpeta compartida creada con estructura (Marca · Negocio · Contenido · Fotos/vídeo · Legal/fiscal · Entregables).</p><div style="${EM.card}">${emLabel('Carpeta Drive','#22d3ee')}<div style="font-size:14px"><a href="${root.webViewLink}" style="color:#22d3ee">${root.webViewLink}</a></div></div><div style="${EM.footer}">Compartida con ${form.email||'(sin email)'} · guía de carga: quantumventures.io/onboarding</div></div>`;
    await sendHtmlMail(token, `Cliente creado · ${form.nombre}`, html, null);
  } catch(e){ console.error('cliente email', e.message); }
  return { ok:true, url: root.webViewLink };
}

if (require.main === module) {
  const server = http.createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin', CORS);
    res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }
    if(req.method==='GET' && req.url==='/health'){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"ok":true,"v":"ack-1"}'); }
    if(req.method==='GET' && req.url==='/api/ambassadors'){
      getAmbassadors().then(list=>{ res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public, max-age=120'}); res.end(JSON.stringify(list)); })
        .catch(e=>{ console.error('ambassadors error:', e.message); res.writeHead(200,{'Content-Type':'application/json'}); res.end('[]'); });
      return;
    }
    if(req.method==='GET' && req.url.startsWith('/api/jaan-pipeline')){
      const key = new URL(req.url, 'http://x').searchParams.get('k') || '';
      handleJaanPipeline(key).then(out=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(out)); })
        .catch(e=>{ const code=e.code===403?403:500; res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:code===403?'forbidden':'internal'})); });
      return;
    }
    if(req.method==='POST' && (req.url==='/api/audit' || req.url==='/api/audit-product' || req.url==='/api/fiscal' || req.url==='/api/contacto' || req.url==='/api/cliente' || req.url==='/api/venue' || req.url==='/api/ambassador' || req.url==='/api/villa-brisa' || req.url==='/api/jaan-venue' || req.url==='/api/jaan-stage' || req.url==='/api/brave-the-world')){
      const handler = req.url==='/api/audit-product' ? handleProduct : req.url==='/api/fiscal' ? handleFiscal : req.url==='/api/contacto' ? handleContacto : req.url==='/api/cliente' ? handleCliente : req.url==='/api/venue' ? handleVenue : req.url==='/api/ambassador' ? handleAmbassador : req.url==='/api/villa-brisa' ? handleVilla : req.url==='/api/jaan-venue' ? handleJaanVenue : req.url==='/api/jaan-stage' ? handleJaanStage : req.url==='/api/brave-the-world' ? handleBraveTheWorld : handleAudit;
      let body=''; req.on('data',c=>{body+=c; if(body.length>1e6) req.destroy();});
      req.on('end', async ()=>{
        try{ const form=JSON.parse(body||'{}'); const out=await handler(form); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(out)); }
        catch(e){ const code=e.code===400?400:e.code===403?403:500; console.error('audit error:', e.message); res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:code===400?'missing fields':code===403?'forbidden':'internal'})); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(process.env.PORT||8080, ()=>console.log('QV audit API on '+(process.env.PORT||8080)));
}

module.exports = { score, sendEmail, handleAudit, scoreProduct, handleProduct, emailHtml, productEmailHtml, getAvatar, primaryProfile, handleFiscal, logSheet, handleContacto, geminiSearch, handleCliente, handleVenue, handleAmbassador, getAmbassadors, sheetRead, sendAuditAck, ackReceivedHtml, ackCompleteHtml, emailInTab };
