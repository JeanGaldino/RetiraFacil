
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
