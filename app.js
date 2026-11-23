// ======================================================
// RETIRAFÁCIL AMORSAÚDE - APP.JS
// Autenticação Firebase + Firestore + Google Sheets
// ======================================================

// Configurações reais do seu projeto Firebase
const firebaseConfig = {
  apiKey: "AIzaSyAVziMgrM1zKUqITTVzxAR2_69Tx2-s_hY",
  authDomain: "retirafacil-v2.firebaseapp.com",
  projectId: "retirafacil-v2",
  storageBucket: "retirafacil-v2.firebasestorage.app",
  messagingSenderId: "186933697505",
  appId: "1:186933697505:web:7a095646b976ec8c1550a0",
  measurementId: "G-4FVMXVH1DJ"
};

// A integração com Google Sheets é exclusivamente pelo Worker autenticado.

// Caminhos do Firestore
const FIRESTORE_APP_ID = "retira-facil-app";
const FIRESTORE_BASE = "artifacts";

// Estado da aplicação
let sheetsData = [];
let currentAbaIndex = "all";
let currentEditingPaciente = null;
let currentAbaIndexForSave = 0;
let db = null;
let auth = null;
let currentUser = null;
let currentUserProfile = null;
let unsubscribeExames = null;
let examesPollTimer = null;
let examesSyncGeneration = 0;
let examesRequestInFlight = false;
let entregaEmAndamento = false;
const entregasLocaisPendentes = new Map();
let unsubscribeAvisos = null;
let avisoAtualId = null;
let avisosPendentes = [];
let avisosEmModal = [];
let avisoModalAtivo = null;
let avisosLidos = new Set();
let currentDocIdToUpdate = "";
let currentAbaNomeToUpdate = "";
let currentExameToUpdate = "";


// ======================================================
// CARREGAMENTO DOS SDKs DO FIREBASE
// ======================================================

function loadFirebaseSDKs() {
  return new Promise((resolve, reject) => {
    if (
      window.firebase &&
      window.firebase.apps &&
      window.firebase.firestore &&
      window.firebase.auth
    ) {
      resolve();
      return;
    }

    const carregarScript = (src) => {
      return new Promise((res, rej) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = res;
        script.onerror = () => rej(
          new Error("Não foi possível carregar: " + src)
        );
        document.head.appendChild(script);
      });
    };

    const base = "https://www.gstatic.com/firebasejs/10.8.0/";

    const carregar = async () => {
      if (!window.firebase || !window.firebase.apps) {
        await carregarScript(base + "firebase-app-compat.js");
      }

      if (!window.firebase.auth) {
        await carregarScript(base + "firebase-auth-compat.js");
      }

      if (!window.firebase.firestore) {
        await carregarScript(base + "firebase-firestore-compat.js");
      }
    };

    carregar().then(resolve).catch(reject);
  });
}


// ======================================================
// INICIALIZAÇÃO
// ======================================================

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();

  const loginForm = document.getElementById("login-form");

  if (loginForm) {
    loginForm.addEventListener("submit", realizarLogin);
  }

  updateSyncStatus("syncing", "Carregando Firebase...");

  try {
    await loadFirebaseSDKs();

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.firestore();
    auth = firebase.auth();

    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    auth.onAuthStateChanged(async (user) => {
      if (!user) {
        encerrarSessaoVisual();
        return;
      }

      await validarUsuarioAutenticado(user);
    });

  } catch (erro) {
    console.error("Erro ao inicializar Firebase:", erro);
    updateSyncStatus("error", "Erro de autenticação");
    mostrarErroLogin(
      "Não foi possível conectar ao serviço. Verifique sua internet e tente novamente."
    );
  }
});


// ======================================================
function exibirSplashLogin() {
  const el = document.getElementById("login-splash");
  if (el) { el.classList.remove("hidden"); el.classList.add("flex"); }
}
function ocultarSplashLogin() {
  const el = document.getElementById("login-splash");
  if (el) { el.classList.add("hidden"); el.classList.remove("flex"); }
}

// AUTENTICAÇÃO: LOGIN
// ======================================================

async function realizarLogin(event) {
  event.preventDefault();

  const usuarioInput = document.getElementById("login-usuario");
  const senhaInput = document.getElementById("login-senha");
  const botao = document.getElementById("login-button");

  const usuario = usuarioInput
    ? usuarioInput.value.trim().toLowerCase()
    : "";

  const senha = senhaInput ? senhaInput.value : "";

  if (!usuario || !senha) {
    mostrarErroLogin("Preencha o usuário e a senha.");
    return;
  }

  if (!/^[a-z0-9._-]+$/.test(usuario) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario)) {
    mostrarErroLogin("O nome de usuário contém caracteres inválidos.");
    return;
  }

  if (!auth) {
    mostrarErroLogin("O serviço de autenticação ainda não está disponível.");
    return;
  }

  if (botao) {
    botao.disabled = true;
    botao.innerHTML =
      '<i class="fas fa-spinner fa-spin mr-2"></i> Verificando...';
  }

  limparErroLogin();
  exibirSplashLogin();

  try {
    // O Firebase Authentication utiliza e-mail/senha.
    // O colaborador digita somente o nome de usuário.
    const emailInterno = usuario.includes("@") ? usuario : `${usuario}@retirafacil-v2.firebaseapp.com`;
    try {
      await auth.signInWithEmailAndPassword(emailInterno, senha);
    } catch (erro) {
      if (usuario.includes("@") || !["auth/user-not-found","auth/wrong-password","auth/invalid-credential"].includes(erro.code)) throw erro;
      await auth.signInWithEmailAndPassword(`${usuario}@retirafacil-75fd6.firebaseapp.com`, senha);
    }

    if (senhaInput) senhaInput.value = "";

  } catch (erro) {
    console.error("Erro no login:", erro);

    let mensagem =
      "Não foi possível entrar. Verifique seu usuário e sua senha.";

    if (
      erro.code === "auth/user-not-found" ||
      erro.code === "auth/wrong-password" ||
      erro.code === "auth/invalid-credential"
    ) {
      mensagem = "Usuário ou senha incorretos.";
    } else if (erro.code === "auth/too-many-requests") {
      mensagem =
        "Muitas tentativas de acesso. Aguarde um pouco e tente novamente.";
    } else if (erro.code === "auth/network-request-failed") {
      mensagem = "Falha de conexão. Verifique sua internet.";
    } else if (erro.code === "auth/invalid-email") {
      mensagem = "Nome de usuário inválido.";
    }

    mostrarErroLogin(mensagem);
    ocultarSplashLogin();

  } finally {
    if (botao) {
      botao.disabled = false;
      botao.innerHTML =
        '<i class="fas fa-sign-in-alt mr-2"></i> Entrar no sistema';
    }
  }
}


// ======================================================
// VALIDAR USUÁRIO NO FIRESTORE
// ======================================================

async function validarUsuarioAutenticado(user) {
  exibirSplashLogin();
  try {
    updateSyncStatus("syncing", "Validando colaborador...");

    const perfilRef = db
      .collection(FIRESTORE_BASE)
      .doc(FIRESTORE_APP_ID)
      .collection("public")
      .doc("data")
      .collection("usuarios")
      .doc(user.uid);

    const perfilDoc = await perfilRef.get();

    if (!perfilDoc.exists) {
      await auth.signOut();
      mostrarErroLogin(
        "Este usuário não possui cadastro autorizado no RetiraFácil."
      );
      return;
    }

    const perfil = perfilDoc.data();

    if (perfil.ativo !== true) {
      await auth.signOut();
      mostrarErroLogin(
        "Seu acesso está desativado. Procure o administrador."
      );
      return;
    }

    if (
      !perfil.usuario ||
      !perfil.nome ||
      !["admin", "colaborador"].includes(perfil.tipo)
    ) {
      await auth.signOut();
      mostrarErroLogin(
        "Seu cadastro está incompleto. Procure o administrador."
      );
      return;
    }

    currentUser = user;
    currentUserProfile = perfil;

    mostrarAplicacao();
    ocultarSplashLogin();
    iniciarSincronizacaoExames();
    iniciarEscutaAvisos();

  } catch (erro) {
    console.error("Erro ao validar perfil:", erro);

    try {
      await auth.signOut();
    } catch (erroLogout) {
      console.error("Erro ao encerrar sessão inválida:", erroLogout);
    }

    mostrarErroLogin(
      "Não foi possível validar seu cadastro. Verifique as regras do Firestore."
    );
  } finally {
    ocultarSplashLogin();
  }
}


// ======================================================
// EXIBIR A APLICAÇÃO
// ======================================================

function mostrarAplicacao() {
  const loginScreen = document.getElementById("login-screen");
  const appContent = document.getElementById("app-content");

  if (loginScreen) {
    loginScreen.classList.add("hidden");
  }

  if (appContent) {
    appContent.classList.remove("hidden");
    appContent.classList.add("flex");
  }

  const colaboradorInput =
    document.getElementById("modal-colaborador");

  if (colaboradorInput) {
    colaboradorInput.value = "";
    colaboradorInput.readOnly = false;
  }

  const adminButton =
    document.getElementById("btn-admin-access");

  if (adminButton) {
    adminButton.classList.toggle(
      "hidden",
      currentUserProfile.tipo !== "admin"
    );
  }

  configurarBotaoSair();
  limparErroLogin();
}


// ======================================================
// SAIR DA CONTA
// ======================================================

function configurarBotaoSair() {
  const areaBotoes = document.querySelector(
    "header .max-w-7xl > div:last-child"
  );

  if (!areaBotoes) return;

  let botao = document.getElementById("btn-logout");

  if (!botao) {
    botao = document.createElement("button");
    botao.id = "btn-logout";
    botao.type = "button";
    botao.title = "Sair do sistema";

    botao.className =
      "p-2 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950 dark:hover:bg-rose-900 text-rose-600 dark:text-rose-300 rounded-lg text-xs transition flex items-center gap-2";

    botao.innerHTML =
      '<i class="fas fa-sign-out-alt"></i><span class="hidden sm:inline">Sair</span>';

    areaBotoes.appendChild(botao);
  }

  // O botão já existe no HTML; registrar o evento também nesse caso.
  if (botao.dataset.logoutBound !== "true") {
    botao.addEventListener("click", realizarLogout);
    botao.dataset.logoutBound = "true";
  }
}

async function realizarLogout() {
  if (!auth) return;

  try {
    updateSyncStatus("syncing", "Encerrando sessão...");
    await auth.signOut();
  } catch (erro) {
    console.error("Erro ao sair:", erro);
    showToast("Não foi possível encerrar a sessão.", "warning");
  }
}


// ======================================================
// LIMPAR A INTERFACE AO SAIR
// ======================================================

function encerrarSessaoVisual() {
  ocultarSplashLogin();
  fecharModalSenhaAdmin();
  pararSincronizacaoExames();
  entregasLocaisPendentes.clear();

  if (typeof unsubscribeAvisos === "function") unsubscribeAvisos();
  unsubscribeAvisos = null;
  avisoAtualId = null;
  avisoModalAtivo = null; avisosPendentes = []; avisosEmModal = []; avisosLidos = new Set();
  document.getElementById("avisos-list")?.classList.add("hidden");
  const avisoModal = document.getElementById("announcement-alert");
  avisoModal?.classList.add("hidden");
  avisoModal?.classList.remove("flex");
  currentUser = null;
  currentUserProfile = null;
  sheetsData = [];
  currentAbaIndex = "all";
  currentEditingPaciente = null;
  currentDocIdToUpdate = "";
  currentAbaNomeToUpdate = "";

  const appContent = document.getElementById("app-content");
  const loginScreen = document.getElementById("login-screen");

  if (appContent) {
    appContent.classList.add("hidden");
    appContent.classList.remove("flex");
  }

  if (loginScreen) {
    loginScreen.classList.remove("hidden");
  }

  const senhaInput = document.getElementById("login-senha");
  const usuarioInput = document.getElementById("login-usuario");

  if (senhaInput) senhaInput.value = "";
  if (usuarioInput) usuarioInput.focus();

  updateSyncStatus("syncing", "Aguardando login");
}


// ======================================================
// MENSAGENS DA TELA DE LOGIN
// ======================================================

function mostrarErroLogin(mensagem) {
  const elemento = document.getElementById("login-error");
  if (!elemento) return;

  elemento.textContent = mensagem;
  elemento.classList.remove("hidden");
}

function limparErroLogin() {
  const elemento = document.getElementById("login-error");
  if (!elemento) return;

  elemento.textContent = "";
  elemento.classList.add("hidden");
}


// ======================================================
// SINCRONIZAÇÃO EM TEMPO REAL DOS EXAMES
// ======================================================

const EXAMES_POLL_INTERVAL_MS = 300000;
function pararSincronizacaoExames() {
  examesSyncGeneration++;
  if (examesPollTimer !== null) clearInterval(examesPollTimer);
  examesPollTimer = null;
  if (typeof unsubscribeExames === "function") unsubscribeExames();
  unsubscribeExames = null;
}
function iniciarSincronizacaoExames() {
  if (!auth || !currentUser || !currentUserProfile) return;
  pararSincronizacaoExames();
  updateSyncStatus("syncing", "Carregando exames da planilha...");
  const generation = examesSyncGeneration;
  void atualizarExamesCompartilhados(generation);
  examesPollTimer = setInterval(() => {
    if (document.visibilityState === "visible") void atualizarExamesCompartilhados(generation);
  }, EXAMES_POLL_INTERVAL_MS);
}
async function atualizarExamesCompartilhados(generation = examesSyncGeneration) {
  if (examesRequestInFlight || !auth?.currentUser) return;
  examesRequestInFlight = true;
  try {
    const user = auth.currentUser;
    const token = await user.getIdToken();
    let cursor = "";
    let concluido = false;
    let totalAbas = 0;
    let abasProcessadas = 0;
    let requisicoes = 0;
    const agrupados = {};
    const idsRecebidos = new Set();
    while (!concluido) {
      if (generation !== examesSyncGeneration || auth.currentUser?.uid !== user.uid) return;
      if (++requisicoes > 500) throw new Error("Limite de lotes excedido.");
      const response = await fetch("/api/exames/lote" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), {
        method: "GET", headers: {Authorization:"Bearer "+token},
        credentials: "same-origin", cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Falha ao carregar lote.");
      if (!Array.isArray(payload.exames) || typeof payload.concluido !== "boolean") throw new Error("Resposta de lote inválida.");
      totalAbas = payload.totalAbas || totalAbas;
      abasProcessadas = payload.abasProcessadas ?? abasProcessadas;
      for (const original of payload.exames) {
        if (!original.id || idsRecebidos.has(original.id)) continue;
        idsRecebidos.add(original.id);
        const item = {...original};
        const id = String(item.id || "");
        const local = entregasLocaisPendentes.get(id);
        if (local) {
          if (item.dataRetirada === local.dataRetirada && item.colaborador === local.colaborador && item.quemRetirou === local.quemRetirou) entregasLocaisPendentes.delete(id);
          else if (!item.dataRetirada && !item.colaborador && !item.quemRetirou) Object.assign(item, local);
          else entregasLocaisPendentes.delete(id);
        }
        const nomeAba = item.abaOrigem || item.aba || "Exames Geral";
        if (!agrupados[nomeAba]) agrupados[nomeAba] = {aba:nomeAba,dados:[]};
        let data = String(item.dataRetirada || "");
        if (data.length > 15) {
          const parsed = new Date(data);
          if (!Number.isNaN(parsed.getTime())) data = parsed.toLocaleDateString("pt-BR");
        }
        agrupados[nomeAba].dados.push([item.paciente || "",item.exame || "","","",data,"",item.colaborador || "","",item.quemRetirou || "",id]);
      }
      if (generation !== examesSyncGeneration || auth.currentUser?.uid !== user.uid) return;
      sheetsData = Object.values(agrupados);
      populateAbasSelect();
      renderTable();
      concluido = payload.concluido;
      if (!concluido && (!payload.cursor || payload.cursor === cursor)) throw new Error("Cursor de sincronização inválido.");
      cursor = payload.cursor || "";
      updateSyncStatus(concluido ? "success" : "syncing",
        concluido ? "Sincronização concluída" : "Carregando abas " + abasProcessadas + "/" + totalAbas + " (dados parciais)");
    }
  } catch(error) {
    if (generation === examesSyncGeneration) {
      console.error("Erro ao consultar exames:",error);
      updateSyncStatus("error","Falha ao atualizar exames");
      if (!sheetsData.length) showToast("Não foi possível carregar exames: "+error.message,"warning");
    }
  } finally {
    examesRequestInFlight = false;
  }
}

// ======================================================
// MODO ESCURO
// ======================================================

function initTheme() {
  const savedTheme = localStorage.getItem("retirafacil_theme");

  if (
    savedTheme === "dark" ||
    (
      !savedTheme &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    )
  ) {
    document.documentElement.classList.add("dark");
    updateThemeIcon(true);
  } else {
    document.documentElement.classList.remove("dark");
    updateThemeIcon(false);
  }
}

function toggleTheme() {
  const isDark =
    document.documentElement.classList.toggle("dark");

  localStorage.setItem(
    "retirafacil_theme",
    isDark ? "dark" : "light"
  );

  updateThemeIcon(isDark);
}

function updateThemeIcon(isDark) {
  const icon = document.getElementById("theme-toggle-icon");

  if (icon) {
    icon.className = isDark
      ? "fas fa-sun text-amber-400"
      : "fas fa-moon";
  }
}


// ======================================================
// STATUS DA SINCRONIZAÇÃO
// ======================================================

function updateSyncStatus(status, text) {
  const badge = document.getElementById("sync-badge");
  const icon = document.getElementById("sync-icon");
  const textEl = document.getElementById("sync-text");

  if (!badge || !textEl || !icon) return;

  textEl.innerText = text;

  if (status === "syncing") {
    icon.className = "fas fa-sync-alt fa-spin text-sky-500";
  } else if (status === "success") {
    icon.className = "fas fa-check-circle text-emerald-500";
  } else if (status === "error") {
    icon.className = "fas fa-exclamation-circle text-rose-500";
  }
}


// ======================================================
// ABAS / PERÍODOS
// ======================================================

function populateAbasSelect() {
  const select = document.getElementById("aba-select");
  if (!select) return;

  const savedValue = select.value;
  select.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.innerText = "TODAS AS ABAS / EXAMES";
  select.appendChild(allOpt);

  sheetsData.forEach((item, index) => {
    const opt = document.createElement("option");
    opt.value = index;
    opt.innerText = item.aba;
    select.appendChild(opt);
  });

  const savedIndex = Number(savedValue);

  const savedIsValidSheet =
    savedValue !== "" &&
    Number.isInteger(savedIndex) &&
    savedIndex >= 0 &&
    savedIndex < sheetsData.length;

  if (savedValue === "all" || !savedIsValidSheet) {
    select.value = "all";
    currentAbaIndex = "all";
  } else {
    select.value = String(savedIndex);
    currentAbaIndex = savedIndex;
  }
}

function changeAba() {
  const select = document.getElementById("aba-select");
  if (!select) return;

  const val = select.value;

  currentAbaIndex =
    val === "all" ? "all" : parseInt(val, 10);

  renderTable();
}


// ======================================================
// PESQUISA
// ======================================================

function handleSearch() {
  const input = document.getElementById("search-input");
  const btnClear = document.getElementById("clear-search");

  if (!input) return;

  if (btnClear) {
    if (input.value.length > 0) {
      btnClear.classList.remove("hidden");
    } else {
      btnClear.classList.add("hidden");
    }
  }

  renderTable();
}

function clearSearch() {
  const input = document.getElementById("search-input");
  if (input) input.value = "";

  const btnClear = document.getElementById("clear-search");
  if (btnClear) btnClear.classList.add("hidden");

  renderTable();
}


// ======================================================
// COLABORADOR AUTENTICADO
// ======================================================

function loadColaboradorSalvo() {
  const input = document.getElementById("modal-colaborador");

  if (input && currentUserProfile) {
    input.value = "";
    input.readOnly = false;
  }
}


// ======================================================
// INDICADORES
// ======================================================

function getPatientRows(sheet) {
  const rows = Array.isArray(sheet?.dados)
    ? sheet.dados
    : [];

  return rows.filter(
    row =>
      Array.isArray(row) &&
      String(row[0] ?? "").trim() !== ""
  );
}

function updateDashboardStats() {
  let abasToCount = [];

  if (currentAbaIndex === "all") {
    abasToCount = sheetsData;
  } else if (sheetsData[currentAbaIndex]) {
    abasToCount = [sheetsData[currentAbaIndex]];
  }

  let total = 0;
  let entregues = 0;

  abasToCount.forEach((sheet) => {
    const registros = getPatientRows(sheet);

    registros.forEach((row) => {
      total++;

      const dataRetirada = String(row[4] ?? "").trim();
      const assinatura = String(row[6] ?? "").trim();

      if (dataRetirada || assinatura || String(row[8] ?? "").trim()) entregues++;
    });
  });

  const totalEl = document.getElementById("stat-total");
  const deliveredEl = document.getElementById("stat-delivered");
  const pendingEl = document.getElementById("stat-pending");

  if (totalEl) {
    totalEl.textContent = total.toLocaleString("pt-BR");
  }

  if (deliveredEl) {
    deliveredEl.textContent = entregues.toLocaleString("pt-BR");
  }

  if (pendingEl) {
    pendingEl.textContent =
      (total - entregues).toLocaleString("pt-BR");
  }
}


// ======================================================
// RENDERIZAÇÃO DA TABELA
// ======================================================

function renderTable() {
  const tbody = document.getElementById("table-body");
  if (!tbody) return;

  updateDashboardStats();

  if (!sheetsData || sheetsData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-slate-400">
          <i class="fas fa-inbox text-3xl mb-2 block"></i>
          Nenhum exame encontrado na planilha.
        </td>
      </tr>
    `;
    return;
  }

  const searchTerm = (
    document.getElementById("search-input")?.value || ""
  ).toLowerCase().trim();

  let abasToProcess = [];

  if (currentAbaIndex === "all") {
    abasToProcess = sheetsData.map((sheet, index) => ({
      sheet,
      index
    }));
  } else if (sheetsData[currentAbaIndex]) {
    abasToProcess = [{
      sheet: sheetsData[currentAbaIndex],
      index: currentAbaIndex
    }];
  }

  let html = "";
  let count = 0;

  abasToProcess.forEach(({ sheet, index: abaIdx }) => {
    const nomeAba = sheet.aba;
    const registros = getPatientRows(sheet);

    registros.forEach((row) => {
      const paciente = String(row[0] ?? "").trim();
      const exame = nomeAba;
      const dataRetirada = row[4]
        ? String(row[4]).trim()
        : "";
      const colaborador = row[6]
        ? String(row[6]).trim()
        : "";
      const quemRetirou = row[8]
        ? String(row[8]).trim()
        : "";
      const docId = row[9] || "";

      if (searchTerm) {
        const matchPaciente =
          paciente.toLowerCase().includes(searchTerm);

        const matchQuemRetirou =
          quemRetirou.toLowerCase().includes(searchTerm);

        const matchExame =
          exame.toLowerCase().includes(searchTerm);

        const matchAba =
          nomeAba.toLowerCase().includes(searchTerm);

        if (
          !matchPaciente &&
          !matchQuemRetirou &&
          !matchExame &&
          !matchAba
        ) {
          return;
        }
      }

      const isEntregue =
        !!dataRetirada || !!colaborador || !!quemRetirou;
      const filtroStatus = document.getElementById("status-filter")?.value || "todos";
      if (filtroStatus === "entregues" && !isEntregue) return;
      if (filtroStatus === "pendentes" && isEntregue) return;

      count++;

      const pacienteEncoded =
        encodeURIComponent(paciente).replace(/'/g, "%27");

      let detalheExameOuAba = "";

      if (nomeAba && nomeAba !== "-") {
        detalheExameOuAba = `
          <span class="inline-flex items-center gap-1 font-semibold text-[#45b7c9] bg-sky-50 dark:bg-sky-950/60 border border-sky-200 dark:border-sky-800 px-2 py-0.5 rounded text-[11px] mb-1">
            <i class="far fa-folder-open"></i> ${nomeAba}
          </span>
        `;
      } else {
        detalheExameOuAba =
          '<span class="text-slate-400">-</span>';
      }

      html += `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
          <td class="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">
            ${paciente}
          </td>

          <td class="py-3.5 px-4 text-slate-600 dark:text-slate-300 text-xs">
            ${detalheExameOuAba}
          </td>

          <td class="py-3.5 px-4 text-slate-600 dark:text-slate-300 text-xs font-mono">
            ${
              dataRetirada
                ? `<span class="bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 rounded font-semibold">${dataRetirada}</span>`
                : '<span class="text-slate-400">Pendente</span>'
            }
          </td>

          <td class="py-3.5 px-4 text-xs font-mono text-slate-500 dark:text-slate-400 max-w-xs truncate" title="${colaborador}">
            ${
              colaborador
                ? `<span class="text-emerald-600 dark:text-emerald-400">${colaborador}</span>`
                : "-"
            }
          </td>

          <td class="py-3.5 px-4 text-slate-700 dark:text-slate-200 text-xs font-medium">
            ${quemRetirou || "-"}
          </td>

          <td class="py-3.5 px-4 text-center">
            ${
              isEntregue
                ? `<span class="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950/50 px-2.5 py-1 rounded-lg border border-emerald-200 dark:border-emerald-800"><i class="fas fa-check"></i> Entregue</span>`
                : `<button onclick="openEntregaModal('${pacienteEncoded}', ${abaIdx}, '${docId}')" class="bg-[#45b7c9] hover:bg-[#3ba4b5] text-white text-xs font-bold px-3 py-1.5 rounded-lg shadow-sm transition transform active:scale-95 flex items-center gap-1 mx-auto">
                    <i class="fas fa-hand-holding"></i> Entregar
                   </button>`
            }
          </td>
        </tr>
      `;
    });
  });

  if (count === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-slate-400">
          <i class="fas fa-search text-2xl mb-2 block"></i>
          Nenhum paciente encontrado.
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = html;
  }
}


// ======================================================
// MODAL DE ENTREGA
// ======================================================

function openEntregaModal(
  pacienteEncoded,
  especificAbaIdx = null,
  docId = ""
) {
  if (!currentUser || !currentUserProfile) {
    showToast("Faça login para realizar uma entrega.", "warning");
    return;
  }

  if (entregaEmAndamento) return;
  const paciente = decodeURIComponent(pacienteEncoded);
  const abaSelecionada = sheetsData[especificAbaIdx];
  const registro = abaSelecionada?.dados.find(r => String(r[9]) === String(docId));
  if (!registro || String(registro[0]).trim() !== paciente || !/^\d+_\d+$/.test(String(docId))) {
    showToast("Registro desatualizado. Atualize os exames e tente novamente.", "warning");
    return;
  }
  if (registro[4] || registro[6] || registro[8]) {
    showToast("Este registro já possui dados de retirada. Confira a planilha.", "warning");
    return;
  }
  currentExameToUpdate = String(registro[1] ?? "");
  currentEditingPaciente = paciente;
  currentDocIdToUpdate = docId;

  if (
    especificAbaIdx !== null &&
    sheetsData[especificAbaIdx]
  ) {
    currentAbaIndexForSave = especificAbaIdx;
    currentAbaNomeToUpdate =
      sheetsData[especificAbaIdx].aba;
  } else {
    currentAbaIndexForSave = currentAbaIndex;
    currentAbaNomeToUpdate = "Exames Geral";
  }

  const pacienteInput =
    document.getElementById("modal-paciente");

  const retiradoPorInput =
    document.getElementById("modal-retirado-por");

  if (pacienteInput) pacienteInput.value = paciente;
  if (retiradoPorInput) retiradoPorInput.value = "";

  loadColaboradorSalvo();

  const randomHash =
    "#" +
    Math.random().toString(36).substring(2, 7).toUpperCase();

  const hashPreviewEl =
    document.getElementById("preview-hash");

  if (hashPreviewEl) {
    hashPreviewEl.innerText = randomHash;
  }

  const modal = document.getElementById("modal-entrega");

  if (modal) modal.classList.remove("hidden");
}


// ======================================================
// CONFIRMAR ENTREGA
// ======================================================

async function confirmarEntregaAction() {
  if (entregaEmAndamento) return;
  const retiradoPor = document.getElementById("modal-retirado-por")?.value.trim() || "";
  const colaborador = document.getElementById("modal-colaborador")?.value.trim() || "";
  if (!currentUser || !currentUserProfile || currentUserProfile.ativo !== true) {
    showToast("Sua sessão não está autorizada.","warning"); return;
  }
  if (!currentEditingPaciente || !retiradoPor || retiradoPor.length > 150 || !colaborador || colaborador.length > 150 || !currentAbaNomeToUpdate || !currentDocIdToUpdate) {
    showToast("Informe quem retirou, o nome do colaborador e selecione um exame válido.","warning"); return;
  }
  entregaEmAndamento = true;
  const botao = document.querySelector('#modal-entrega button[onclick="confirmarEntregaAction()"]');
  const textoBotao = botao?.innerHTML;
  if (botao) { botao.disabled = true; botao.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...'; }
  showToast("Registrando retirada na planilha...","info");
  try {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch("/api/exames/entregar",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify({id:currentDocIdToUpdate,exame:currentExameToUpdate,paciente:currentEditingPaciente,aba:currentAbaNomeToUpdate,retiradoPor,colaborador})
    });
    const result = await response.json().catch(()=>({}));
    const jaEntregue = response.status === 409 && result.codigo === "JA_ENTREGUE";
    const entrega = result.entrega;
    if ((!response.ok || result.success !== true) && !jaEntregue) {
      const codigo = result.codigoScript || result.codigo;
      const erro = new Error((result.error || "Falha ao salvar retirada.") + (codigo ? " (" + codigo + ")" : ""));
      erro.codigo = codigo;
      throw erro;
    }
    if (!entrega?.dataRetirada || !entrega?.colaborador || !entrega?.quemRetirou ||
        entrega.aba !== currentAbaNomeToUpdate || (entrega.id && entrega.id !== currentDocIdToUpdate)) {
      const erro = new Error("Não foi possível confirmar os dados da retirada. Confira a planilha antes de repetir.");
      erro.codigo = jaEntregue ? "JA_ENTREGUE" : "GRAVACAO_NAO_CONFIRMADA";
      throw erro;
    }
    const local = {
      dataRetirada:entrega.dataRetirada,
      colaborador:entrega.colaborador,
      quemRetirou:entrega.quemRetirou
    };
    entregasLocaisPendentes.set(currentDocIdToUpdate,local);
    for (const aba of sheetsData) {
      const row=aba.dados.find(r=>r[9]===currentDocIdToUpdate);
      if(row){row[4]=local.dataRetirada;row[6]=local.colaborador;row[8]=local.quemRetirou;}
    }
    entregaEmAndamento = false;
    closeModal();
    renderTable();
    showToast(jaEntregue ? "Este exame já constava como entregue na planilha." : "Retirada registrada na planilha!",jaEntregue ? "warning" : "success");
  } catch(error) {
    console.error("Erro ao registrar retirada:",error);
    showToast(error.message,"warning");
    if (["JA_ENTREGUE","REGISTRO_ALTERADO","REGISTRO_PARCIAL","GRAVACAO_NAO_CONFIRMADA"].includes(error.codigo)) {
      entregaEmAndamento = false;
      closeModal(); void atualizarExamesCompartilhados();
    }
  } finally {
    entregaEmAndamento=false;
    if(botao){botao.disabled=false; botao.innerHTML=textoBotao;}
  }
}

// ======================================================
// ACESSO ADMINISTRATIVO
// ======================================================

function fecharModalSenhaAdmin() {
  const modal = document.getElementById("modal-admin-password");
  const senha = document.getElementById("admin-password-input");
  const erro = document.getElementById("admin-password-error");
  if (modal) modal.classList.add("hidden");
  if (senha) senha.value = "";
  if (erro) { erro.textContent = ""; erro.classList.add("hidden"); }
}
document.getElementById("btn-admin-access")?.addEventListener("click", () => {
  if (!currentUser || !currentUserProfile || currentUserProfile.tipo !== "admin" || currentUserProfile.ativo !== true) {
    showToast("Você não possui autorização administrativa.", "warning");
    return;
  }
  document.getElementById("modal-admin-password")?.classList.remove("hidden");
  document.getElementById("admin-password-input")?.focus();
});
document.getElementById("admin-password-cancel")?.addEventListener("click", fecharModalSenhaAdmin);
document.getElementById("modal-admin-password")?.addEventListener("click", event => {
  if (event.target.id === "modal-admin-password") fecharModalSenhaAdmin();
});
document.getElementById("admin-password-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  const senha = document.getElementById("admin-password-input")?.value;
  const erro = document.getElementById("admin-password-error");
  const button = document.getElementById("admin-password-submit");
  if (!currentUser || currentUserProfile?.tipo !== "admin") return;
  button.disabled = true;
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch("/api/admin/verify", {
      method: "POST",
      credentials: "same-origin",
      headers: {"Content-Type": "application/json", Authorization: "Bearer " + token},
      body: JSON.stringify({password: senha})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Acesso negado.");
    fecharModalSenhaAdmin();
    window.location.href = "panel-adm.html";
  } catch (error) {
    if (erro) {
      erro.textContent = error.message || "Acesso negado";
      erro.classList.remove("hidden");
    }
  } finally {
    button.disabled = false;
  }
});


// ======================================================
// FECHAR MODAIS E TUTORIAL
// ======================================================

function closeModal() {
  if (entregaEmAndamento) return;
  const modal = document.getElementById("modal-entrega");

  if (modal) modal.classList.add("hidden");
}

function openTutorial() {
  const modal = document.getElementById("modal-tutorial");

  if (modal) modal.classList.remove("hidden");
}

function closeTutorial() {
  const modal = document.getElementById("modal-tutorial");

  if (modal) modal.classList.add("hidden");
}


// ======================================================
// NOTIFICAÇÕES TOAST
// ======================================================

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-message");
  const toastIcon = document.getElementById("toast-icon");

  if (!toast || !toastMsg) return;

  toastMsg.innerText = message;

  toast.className =
    "toast-notification fixed top-5 right-5 z-50 flex items-center gap-3 px-5 py-3 rounded-xl shadow-xl text-white font-medium text-sm transition-all duration-300 ";

  if (type === "success") {
    toast.classList.add("bg-emerald-600");
    if (toastIcon) {
      toastIcon.className = "fas fa-check-circle text-xl";
    }
  } else if (type === "warning") {
    toast.classList.add("bg-amber-500");
    if (toastIcon) {
      toastIcon.className =
        "fas fa-exclamation-triangle text-xl";
    }
  } else {
    toast.classList.add("bg-[#45b7c9]");
    if (toastIcon) {
      toastIcon.className = "fas fa-info-circle text-xl";
    }
  }

  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 3500);
}

function iniciarEscutaAvisos() {
  if (!db || !currentUser) return;
  if (typeof unsubscribeAvisos === "function") unsubscribeAvisos();
  const uid = currentUser.uid;
  const base = db.collection("artifacts").doc("retira-facil-app").collection("public").doc("data");
  const chave = "retirafacil_avisos_lidos_" + uid;
  try { avisosLidos = new Set(JSON.parse(localStorage.getItem(chave) || "[]")); } catch (_) { avisosLidos = new Set(); }
  unsubscribeAvisos = base.collection("avisos").onSnapshot(snapshot => {
    if (currentUser?.uid !== uid) return;
    const now = Date.now();
    const avisos = snapshot.docs.map(d => ({...d.data(), id:d.id})).filter(a => a.ativo !== false && a.mensagem && (!a.expiraEm || (a.expiraEm.toMillis ? a.expiraEm.toMillis() : Date.parse(a.expiraEm)) > now));
    // Documento legado 'atual': permanece compatível, sem duplicar a leitura.
    avisosPendentes = avisos.filter(a => !avisosLidos.has(a.id)).sort((a,b) => (b.criadoEm?.toMillis?.() || 0) - (a.criadoEm?.toMillis?.() || 0));
    avisosEmModal = avisosPendentes.filter(a => a.categoria === "urgente" || a.leituraObrigatoria === true || a.id === "atual");
    renderizarSininho();
    mostrarProximoAviso();
  }, error => console.error("Falha ao receber avisos:", error));
}
function renderizarSininho() {
  const lista = document.getElementById("avisos-list"), contador = document.getElementById("avisos-count");
  if (!lista || !contador) return;
  const informativos = avisosPendentes.filter(a => !avisosEmModal.some(m => m.id === a.id));
  contador.textContent = String(informativos.length);
  contador.classList.toggle("hidden", informativos.length === 0);
  lista.replaceChildren();
  if (!informativos.length) { const p=document.createElement("p"); p.textContent="Nenhum aviso novo."; p.className="text-sm text-slate-500"; lista.appendChild(p); }
  informativos.forEach(a => {
    const item=document.createElement("div"); item.className="border-b dark:border-slate-700 py-3";
    const title=document.createElement("strong"); title.className="block text-sm"; title.textContent=a.titulo || "Comunicado";
    const msg=document.createElement("p"); msg.className="text-sm whitespace-pre-wrap my-2"; msg.textContent=a.mensagem;
    const btn=document.createElement("button"); btn.className="text-xs text-cyan-600 font-semibold"; btn.textContent="Marcar como lido"; btn.onclick=()=>confirmarAviso(a.id);
    item.append(title,msg,btn); lista.appendChild(item);
  });
}
function mostrarProximoAviso() {
  if (avisoModalAtivo || !avisosEmModal.length) return;
  avisoModalAtivo = avisosEmModal[0];
  avisoAtualId = avisoModalAtivo.id;
  const modal=document.getElementById("announcement-alert");
  document.getElementById("announcement-alert-title").textContent=avisoModalAtivo.titulo || "Comunicado da administração";
  document.getElementById("announcement-alert-message").textContent=avisoModalAtivo.mensagem;
  modal?.classList.remove("hidden"); modal?.classList.add("flex");
}
function confirmarAviso(id) {
  if (!currentUser) return;
  avisosLidos.add(id);
  try { localStorage.setItem("retirafacil_avisos_lidos_" + currentUser.uid, JSON.stringify([...avisosLidos])); } catch (_) {}
  avisosPendentes=avisosPendentes.filter(a=>a.id!==id);
  avisosEmModal=avisosEmModal.filter(a=>a.id!==id);
  if (avisoModalAtivo?.id === id) {
    avisoModalAtivo=null; avisoAtualId=null;
    const modal=document.getElementById("announcement-alert");
    modal?.classList.add("hidden"); modal?.classList.remove("flex");
  }
  renderizarSininho(); mostrarProximoAviso();
}
document.getElementById("announcement-alert-confirm")?.addEventListener("click", () => { if(avisoAtualId) confirmarAviso(avisoAtualId); });
document.getElementById("avisos-bell")?.addEventListener("click", () => {
  const lista=document.getElementById("avisos-list"), botao=document.getElementById("avisos-bell");
  lista?.classList.toggle("hidden"); botao?.setAttribute("aria-expanded", String(!lista?.classList.contains("hidden")));
});
