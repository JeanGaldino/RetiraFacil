
const SESSION_DURATION = 8 * 60 * 60;
const COOKIE_NAME = "retirafacil_session";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // Bloqueio global de manutenção: intercepta todas as páginas e APIs
      // antes de qualquer autenticação ou operação com exames.
      if (env.MAINTENANCE_MODE !== "off") {
        if (request.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/robots.txt")) {
          return new Response(null, {status: 204, headers: SECURITY_HEADERS});
        }
        if (request.method === "GET" && (url.pathname === "/maintenance" || url.pathname === "/maintenance.html" || url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/panel-adm.html" || !url.pathname.startsWith("/api/"))) {
          return maintenancePage();
        }
        return json({error: "RetiraFácil temporariamente indisponível para manutenção."}, 503, {"Retry-After": "3600"});
      }

      if (url.pathname === "/api/login" && request.method === "POST") {
        return await login(request, env);
      }

      if (url.pathname === "/api/session" && request.method === "GET") {
        return await checkSession(request, env);
      }

      if (url.pathname === "/api/logout" && request.method === "POST") {
        return await logout(request, env);
      }

      if (url.pathname === "/api/admin/verify" && request.method === "POST") {
        return await verifyAdminPassword(request, env);
      }
      if (url.pathname === "/api/admin/session" && request.method === "GET") {
        return await checkAdminAccess(request, env);
      }

      if (url.pathname === "/api/admin/users" && ["GET", "POST"].includes(request.method)) {
        return await gerenciarUsuarios(request, env);
      }
      if (/^\/api\/admin\/users\/[^/]+$/.test(url.pathname) && request.method === "PATCH") {
        return await gerenciarUsuarios(request, env);
      }

      // O login atual do RetiraFácil é feito no navegador pelo Firebase Auth.
      // Os arquivos estáticos precisam estar acessíveis para a tela de login abrir.
      // Os dados continuam protegidos pelas regras do Firestore e as APIs
      // administrativas exigem autenticação e autorização no servidor.
      if (!env.ASSETS) {
        return json({ error: "Armazenamento de arquivos não configurado." }, 500);
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "Rota de API não encontrada." }, 404);
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error("Erro no Worker:", error);

      return json({
        error: "Erro interno no servidor."
      }, 500);
    }
  }
};

// Senha administrativa armazenada somente no ambiente do Cloudflare Worker.
const ADMIN_SESSION_DURATION = 10 * 60;
const ADMIN_COOKIE = "retirafacil_admin";

async function fetchAdminUid(request, env) {
  if (!env.FIREBASE_WEB_API_KEY) return null;
  const bearer = request.headers.get("Authorization") || "";
  if (!bearer.startsWith("Bearer ") || bearer.length > 8192) return null;
  try {
    const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(env.FIREBASE_WEB_API_KEY), {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({idToken: bearer.slice(7)})
    });
    if (!response.ok) return null;
    const data = await response.json();
    const user = data.users?.[0];
    return user && !user.disabled && user.localId ? user.localId : null;
  } catch (error) {
    console.error("Erro ao verificar autenticação:", error);
    return null;
  }
}
async function verifyAdminPassword(request, env) {
  if (!env.SESSIONS || !env.ADMIN_PASSWORD || !env.FIREBASE_WEB_API_KEY)
    return json({error:"Verificação administrativa não configurada no servidor."}, 503);
  if (!isSameOrigin(request)) return json({error:"Origem não autorizada."}, 403);
  if (!(request.headers.get("Content-Type") || "").includes("application/json"))
    return json({error:"Formato inválido."}, 415);
  const uid = await fetchAdminUid(request, env);
  if (!uid) return json({error:"Sessão do colaborador inválida."}, 401);
  let body;
  try { body = await request.json(); } catch { return json({error:"Requisição inválida."}, 400); }
  const password = body?.password;
  if (typeof password !== "string" || password.length > 256 || !password.length)
    return json({error:"Senha inválida."}, 400);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = "admin-attempts:" + ip + ":" + uid;
  const attempts = Number(await env.SESSIONS.get(rateKey) || 0);
  if (attempts >= 5) return json({error:"Muitas tentativas. Tente novamente em alguns minutos."}, 429);
  if (!constantTimeEqual(password, env.ADMIN_PASSWORD)) {
    await env.SESSIONS.put(rateKey, String(attempts + 1), {expirationTtl:600});
    return json({error:"Senha administrativa incorreta."}, 401);
  }
  await env.SESSIONS.delete(rateKey);
  const ticket = randomToken();
  await env.SESSIONS.put("admin-session:"+ticket, uid, {expirationTtl:ADMIN_SESSION_DURATION});
  return json({success:true}, 200, {"Set-Cookie":ADMIN_COOKIE+"="+ticket+"; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age="+ADMIN_SESSION_DURATION});
}
async function checkAdminAccess(request, env) {
  if (!env.SESSIONS || !env.FIREBASE_WEB_API_KEY) return json({error:"Acesso não configurado."}, 503);
  const uid = await fetchAdminUid(request, env);
  if (!uid) return json({error:"Sessão do colaborador inválida."}, 401);
  const ticket = getCookie(request, ADMIN_COOKIE);
  if (!ticket || !/^[a-f0-9]{64}$/.test(ticket)) return json({error:"Senha administrativa não confirmada."}, 403);
  const storedUid = await env.SESSIONS.get("admin-session:"+ticket);
  if (storedUid !== uid) return json({error:"Confirmação administrativa expirada."}, 403);
  return json({authenticated:true});
}


// Operações privilegiadas usam Firebase Admin via OAuth de conta de serviço.
// Configure FIREBASE_SERVICE_ACCOUNT_JSON como segredo no Worker.
function contaServico(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON não configurado.');
  const service = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!service.client_email || !service.private_key || service.project_id !== 'retirafacil-75fd6') throw new Error('Credenciais Firebase inválidas.');
  return service;
}
function codificarBase64Url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let str = '';
  for (const byte of bytes) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function accessTokenFirebase(env) {
  const service = contaServico(env);
  const now = Math.floor(Date.now() / 1000);
  const header = codificarBase64Url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claims = codificarBase64Url(JSON.stringify({
    iss:service.client_email, sub:service.client_email,
    aud:'https://oauth2.googleapis.com/token',
    scope:'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore',
    iat:now, exp:now + 3600
  }));
  const bytes = new TextEncoder().encode(header + '.' + claims);
  const pem = service.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const binary = atob(pem);
  const der = Uint8Array.from(binary, c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes);
  const assertion = header + '.' + claims + '.' + codificarBase64Url(new Uint8Array(signature));
  const res = await fetch('https://oauth2.googleapis.com/token', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Falha na autenticação da conta de serviço.');
  return data.access_token;
}
const FIRESTORE_USERS = 'projects/retirafacil-75fd6/databases/(default)/documents/artifacts/retira-facil-app/public/data/usuarios';
async function firebaseRequest(url, token, options = {}) {
  const res = await fetch(url, {...options,headers:{Authorization:'Bearer '+token,...(options.headers || {})}});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Firebase Admin API:',res.status,JSON.stringify(data).slice(0,500));
    const error = new Error(data.error?.message || 'Falha na operação Firebase.');
    error.status = res.status;
    throw error;
  }
  return data;
}
function valor(field) { return field?.stringValue ?? field?.booleanValue ?? ''; }
function firestorePerfil(doc) {
  return {
    uid:doc.name?.split('/').pop(),
    nome:valor(doc.fields?.nome),
    usuario:valor(doc.fields?.usuario),
    tipo:valor(doc.fields?.tipo),
    ativo:valor(doc.fields?.ativo) === true
  };
}
function fieldString(v) {return {stringValue:String(v)}}
async function perfilPorUid(uid, token) {
  try {
    const doc = await firebaseRequest('https://firestore.googleapis.com/v1/'+FIRESTORE_USERS+'/'+encodeURIComponent(uid),token);
    return firestorePerfil(doc);
  } catch(e) {
    if(e.status===404)return null;
    throw e;
  }
}
async function authorizeUserManager(request,env) {
  const uid=await fetchAdminUid(request,env);
  if(!uid) return {error:json({error:'Sua sessão expirou. Faça login novamente.'},401)};
  const token=await accessTokenFirebase(env);
  const perfil=await perfilPorUid(uid,token);
  if(!perfil || !perfil.ativo || perfil.tipo!=='admin')return {error:json({error:'Acesso permitido somente a administradores ativos.'},403)};
  // Confirma a senha adicional por ticket de curta duração do Worker.
  const ticket=getCookie(request,ADMIN_COOKIE);
  if(!ticket || !/^[a-f0-9]{64}$/.test(ticket) || !env.SESSIONS || await env.SESSIONS.get('admin-session:'+ticket)!==uid)
    return {error:json({error:'Confirme novamente a senha administrativa antes de gerenciar usuários.'},403)};
  return {uid,token};
}
async function listarUsuarios(token) {
  const result=[];
  let pageToken='';
  do {
    const url='https://firestore.googleapis.com/v1/'+FIRESTORE_USERS+'?pageSize=200'+(pageToken?'&pageToken='+encodeURIComponent(pageToken):'');
    const data=await firebaseRequest(url,token);
    result.push(...(data.documents || []).map(firestorePerfil));
    pageToken=data.nextPageToken || '';
  } while(pageToken && result.length<2000);
  return result;
}
async function gerenciarUsuarios(request,env) {
  if (!env.FIREBASE_WEB_API_KEY || !env.SESSIONS || !env.ADMIN_PASSWORD || !env.FIREBASE_SERVICE_ACCOUNT_JSON)
    return json({error:'Gerenciamento de usuários não configurado no Cloudflare.'},503);
  if(request.method!=='GET' && !isSameOrigin(request))return json({error:'Origem não autorizada.'},403);
  let access;
  try {access=await authorizeUserManager(request,env)} catch(error) {
    console.error('Erro ao autorizar administrador:',error);
    return json({error:'Erro na configuração ou autorização do Firebase.'},503);
  }
  if(access.error)return access.error;
  const {uid:adminUid,token}=access;
  try {
    if(request.method==='GET') {
      const users=await listarUsuarios(token);
      return json({users:users.sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'))});
    }
    if(!(request.headers.get('Content-Type') || '').includes('application/json'))
      return json({error:'Formato inválido.'},415);
    const body=await request.json().catch(()=>null);
    if(!body || typeof body!=='object')return json({error:'Dados inválidos.'},400);
    if(request.method==='PATCH') {
      const uid=decodeURIComponent(new URL(request.url).pathname.split('/').pop());
      if(!/^[a-zA-Z0-9]{10,128}$/.test(uid))return json({error:'Identificador inválido.'},400);
      if(typeof body.ativo!=='boolean')return json({error:'Status inválido.'},400);
      if(uid===adminUid && body.ativo===false)return json({error:'Não é permitido desativar a própria conta.'},400);
      const current=await perfilPorUid(uid,token);
      if(!current)return json({error:'Usuário não encontrado.'},404);
      const patch={fields:{ativo:{booleanValue:body.ativo}}};
      await firebaseRequest('https://firestore.googleapis.com/v1/'+FIRESTORE_USERS+'/'+uid+'?updateMask.fieldPaths=ativo',token,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
      // Também bloqueia o login de uma conta inativa no Firebase Authentication.
      await firebaseRequest('https://identitytoolkit.googleapis.com/v1/projects/retirafacil-75fd6/accounts:update',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({localId:uid,disable:!body.ativo})});
      return json({success:true});
    }
    const nome=typeof body.nome==='string'?body.nome.trim():'';
    const usuario=typeof body.usuario==='string'?body.usuario.trim().toLowerCase():'';
    const senha=body.senha;
    const tipo=body.tipo;
    if(nome.length<3 || nome.length>100 || !/^[a-z0-9._-]{3,40}$/.test(usuario) ||
       typeof senha!=='string' || senha.length<8 || senha.length>128 || !['admin','colaborador'].includes(tipo))
      return json({error:'Informe nome, usuário válido, senha de no mínimo 8 caracteres e permissão.'},400);
    const email=usuario+'@retirafacil-75fd6.firebaseapp.com';
    let created;
    try {
      created=await firebaseRequest('https://identitytoolkit.googleapis.com/v1/projects/retirafacil-75fd6/accounts',token,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email,password:senha,emailVerified:true,disabled:false,displayName:nome})
      });
    } catch(e) {
      if(e.status===400 && /EMAIL_EXISTS|EMAIL_ALREADY_EXISTS/.test(e.message))
        return json({error:'Este nome de usuário já existe.'},409);
      throw e;
    }
    const newUid=created.localId || created.uid;
    if(!newUid)throw new Error('Firebase não retornou o identificador do novo usuário.');
    try {
      await firebaseRequest('https://firestore.googleapis.com/v1/'+FIRESTORE_USERS+'/'+encodeURIComponent(newUid),token,{
        method:'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({fields:{
          nome:fieldString(nome),usuario:fieldString(usuario),tipo:fieldString(tipo),
          ativo:{booleanValue:true},criadoPor:fieldString(adminUid),
          criadoEm:{timestampValue:new Date().toISOString()}
        }})
      });
    } catch(e) {
      // Conta sem perfil não pode acessar o sistema; tenta desfazer sua criação.
      try {await firebaseRequest('https://identitytoolkit.googleapis.com/v1/projects/retirafacil-75fd6/accounts:delete',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({localId:newUid})})} catch(rollbackError) {console.error('Falha no rollback de cadastro:',rollbackError)}
      throw e;
    }
    return json({success:true,uid:newUid},201);
  } catch(error) {
    console.error('Erro no gerenciamento de usuários:',error);
    if(error.status===403)return json({error:'A conta de serviço não tem permissão para gerenciar os usuários.'},503);
    return json({error:'Não foi possível realizar a operação. Verifique a configuração Firebase.'},500);
  }
}

async function login(request, env) {
  if (!env.SESSIONS || !env.ACCESS_PASSWORD) {
    return json({ error: "Autenticação não configurada." }, 500);
  }

  if (!isSameOrigin(request)) {
    return json({ error: "Origem não autorizada." }, 403);
  }

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.includes("application/json")) {
    return json({ error: "Formato inválido." }, 415);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const password = body?.password;

  if (typeof password !== "string" || password.length < 1 || password.length > 256) {
    return json({ error: "Senha inválida." }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `login-attempts:${ip}`;
  const attempts = Number(await env.SESSIONS.get(rateKey) || 0);

  if (attempts >= 10) {
    return json({ error: "Muitas tentativas. Aguarde alguns minutos." }, 429);
  }

  if (!constantTimeEqual(password, env.ACCESS_PASSWORD)) {
    await env.SESSIONS.put(rateKey, String(attempts + 1), {
      expirationTtl: 600
    });

    return json({ error: "Senha incorreta." }, 401);
  }

  await env.SESSIONS.delete(rateKey);

  const token = randomToken();

  await env.SESSIONS.put(`session:${token}`, "valid", {
    expirationTtl: SESSION_DURATION
  });

  return json(
    { success: true, expiresIn: SESSION_DURATION },
    200,
    {
      "Set-Cookie":
        `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION}`
    }
  );
}

async function checkSession(request, env) {
  const valid = await getSession(request, env);

  return json({
    authenticated: Boolean(valid),
    expiresIn: valid ? SESSION_DURATION : 0
  });
}

async function logout(request, env) {
  if (!isSameOrigin(request)) {
    return json({ error: "Origem não autorizada." }, 403);
  }

  const token = getCookie(request, COOKIE_NAME);

  if (token && env.SESSIONS) {
    await env.SESSIONS.delete(`session:${token}`);
  }

  return json(
    { success: true },
    200,
    {
      "Set-Cookie":
        `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
    }
  );
}

async function getSession(request, env) {
  if (!env.SESSIONS) return false;

  const token = getCookie(request, COOKIE_NAME);

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return false;
  }

  const value = await env.SESSIONS.get(`session:${token}`);

  return value === "valid";
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");

    if (separator === -1) continue;

    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();

    if (key === name) return value;
  }

  return null;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();

  const left = encoder.encode(a);
  const right = encoder.encode(b);

  let difference = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);

  for (let i = 0; i < maxLength; i++) {
    difference |= (left[i] || 0) ^ (right[i] || 0);
  }

  return difference === 0;
}

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");

  if (!origin) return false;

  return origin === new URL(request.url).origin;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extraHeaders
    }
  });
}

function maintenancePage() {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#45b7c9">
  <title>Em manutenção | RetiraFácil</title>
  <style>
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    body{min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(145deg,#e8f8fa,#f8fafc 60%,#eaf0f7);color:#233345}
    main{width:min(100%,480px);padding:44px 32px;text-align:center;background:#fff;border:1px solid #e1eaf0;border-radius:28px;box-shadow:0 24px 70px #17394b17}
    .symbol{width:88px;height:88px;border-radius:24px;background:#e8f8fa;color:#278fa1;display:grid;place-items:center;margin:0 auto 24px;font-size:42px}
    h1{font-size:30px;letter-spacing:-.7px;margin:0 0 12px}p{line-height:1.65;color:#5b6a7b;margin:0 0 18px}
    .brand{font-size:14px;font-weight:750;letter-spacing:.3px;color:#269bb1;margin-bottom:18px}
    .status{display:inline-flex;gap:9px;align-items:center;background:#fff5db;color:#956208;border-radius:99px;padding:9px 15px;font-size:13px;font-weight:700;margin:10px 0 26px}
    .dot{width:8px;height:8px;background:#e0a122;border-radius:50%}
    small{color:#83919e;display:block}
  </style>
</head>
<body><main role="main">
  <div class="symbol" aria-hidden="true">⚙</div>
  <div class="brand">AmorSaúde · RetiraFácil</div>
  <h1>Sistema em manutenção</h1>
  <p>Estamos realizando ajustes para melhorar o funcionamento do RetiraFácil. Durante esse período, o acesso e as retiradas de exames estão temporariamente indisponíveis.</p>
  <div class="status"><span class="dot"></span> Acesso temporariamente suspenso</div>
  <small>Agradecemos a compreensão. Tente novamente mais tarde.</small>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "Retry-After": "3600", "X-Content-Type-Options": "nosniff"}
  });
}
