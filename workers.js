
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
      if (url.pathname === "/api/admin/users" && request.method === "POST") {
        return await registerUser(request, env);
      }
      if (url.pathname === "/api/admin/session" && request.method === "GET") {
        return await checkAdminAccess(request, env);
      }

      // As rotas de autenticação não exigem sessão.
      // As demais rotas ainda serão integradas à proteção
      // dos dados na próxima etapa.
      if (!env.ASSETS) {
        return json({ error: "Armazenamento de arquivos não configurado." }, 500);
      }

      const session = await getSession(request, env);

      if (!session) {
        return json({ error: "Acesso não autorizado." }, 401);
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


function firebaseProject(env) { return env.FIREBASE_PROJECT_ID || "retirafacil-75fd6"; }
async function fetchAdminProfile(request, env) {
  const uid = await fetchAdminUid(request, env);
  if (!uid || !env.FIREBASE_ADMIN_SERVICE_ACCOUNT) return null;
  const token = await getServiceToken(env);
  const url = "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(firebaseProject(env)) +
    "/databases/(default)/documents/artifacts/retira-facil-app/public/data/usuarios/" + encodeURIComponent(uid);
  const response = await fetch(url, {headers:{Authorization:"Bearer "+token}});
  if (!response.ok) return null;
  const profile = await response.json();
  const fields = profile.fields || {};
  return fields.tipo?.stringValue === "admin" && fields.ativo?.booleanValue === true ? uid : null;
}
function base64Url(bytes) {
  const b64 = btoa(Array.from(bytes).map(x=>String.fromCharCode(x)).join(""));
  return b64.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
async function getServiceToken(env) {
  const account = JSON.parse(env.FIREBASE_ADMIN_SERVICE_ACCOUNT);
  if (!account.client_email || !account.private_key) throw new Error("Conta de serviço inválida.");
  const header = base64Url(new TextEncoder().encode(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const now = Math.floor(Date.now()/1000);
  const claim = base64Url(new TextEncoder().encode(JSON.stringify({
    iss:account.client_email, sub:account.client_email,
    aud:"https://oauth2.googleapis.com/token",
    scope:"https://www.googleapis.com/auth/cloud-platform", iat:now, exp:now+3600
  })));
  const keyBody = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,"");
  const keyBytes = Uint8Array.from(atob(keyBody),c=>c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8",keyBytes,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const unsigned = header+"."+claim;
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned))));
  const response = await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:unsigned+"."+signature})
  });
  if (!response.ok) throw new Error("Não foi possível autenticar a conta de serviço.");
  const data = await response.json();
  return data.access_token;
}
async function registerUser(request, env) {
  if (!isSameOrigin(request)) return json({error:"Origem não autorizada."},403);
  if (!(request.headers.get("Content-Type")||"").includes("application/json")) return json({error:"Formato inválido."},415);
  if (!env.FIREBASE_ADMIN_SERVICE_ACCOUNT || !env.FIREBASE_WEB_API_KEY)
    return json({error:"Configure FIREBASE_ADMIN_SERVICE_ACCOUNT e FIREBASE_WEB_API_KEY no Worker."},503);
  // Além do token Firebase, consulta o perfil administrativo diretamente no Firestore.
  const adminUid = await fetchAdminProfile(request,env);
  if (!adminUid) return json({error:"Somente administradores ativos podem cadastrar usuários."},403);
  let data;
  try {data=await request.json();}catch{return json({error:"Dados inválidos."},400);}
  const nome=typeof data?.nome==="string"?data.nome.trim():"";
  const usuario=typeof data?.usuario==="string"?data.usuario.trim().toLowerCase():"";
  const senha=data?.senha;
  const tipo=data?.tipo;
  if (!nome || nome.length>100 || !/^[a-z0-9._-]{3,40}$/.test(usuario) ||
      typeof senha!=="string" || senha.length<8 || senha.length>128 ||
      !["admin","colaborador"].includes(tipo))
    return json({error:"Confira nome, usuário, senha e permissão."},400);
  const accessToken=await getServiceToken(env);
  const endpoint="https://identitytoolkit.googleapis.com/v1/projects/"+encodeURIComponent(firebaseProject(env))+"/accounts";
  const email=usuario+"@retirafacil-75fd6.firebaseapp.com";
  const created=await fetch(endpoint+":signUp",{method:"POST",headers:{"Authorization":"Bearer "+accessToken,"Content-Type":"application/json"},
    body:JSON.stringify({email,password:senha,displayName:nome,emailVerified:true,disabled:true})});
  const createdData=await created.json();
  if (!created.ok) {
    const code=createdData.error?.message||"";
    return json({error:code.includes("EMAIL_EXISTS")?"Este usuário já existe.":"Falha ao criar conta no Firebase Authentication."},created.status===400?409:502);
  }
  const uid=createdData.localId;
  if (!uid) return json({error:"Conta criada sem identificador; confira o Firebase Authentication."},502);
  const firestoreUrl="https://firestore.googleapis.com/v1/projects/"+encodeURIComponent(firebaseProject(env))+
    "/databases/(default)/documents/artifacts/retira-facil-app/public/data/usuarios/"+encodeURIComponent(uid);
  const profile=await fetch(firestoreUrl,{method:"PATCH",headers:{"Authorization":"Bearer "+accessToken,"Content-Type":"application/json"},
    body:JSON.stringify({fields:{
      usuario:{stringValue:usuario},nome:{stringValue:nome},tipo:{stringValue:tipo},
      ativo:{booleanValue:true},criadoPor:{stringValue:adminUid},
      criadoEm:{timestampValue:new Date().toISOString()}
    }})});
  if (!profile.ok) {
    console.error("Cadastro de perfil falhou:",profile.status,await profile.text());
    return json({error:"Conta criada desativada, mas o perfil não pôde ser salvo. Verifique as permissões do serviço Firebase."},502);
  }
  const enable=await fetch(endpoint+":update",{method:"POST",headers:{"Authorization":"Bearer "+accessToken,"Content-Type":"application/json"},
    body:JSON.stringify({localId:uid,disabled:false})});
  if (!enable.ok) {
    console.error("Ativação falhou:",enable.status,await enable.text());
    return json({error:"Conta e perfil criados, mas a ativação falhou. Ative-a manualmente no Firebase Authentication."},502);
  }
  return json({success:true,uid,usuario},201);
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
