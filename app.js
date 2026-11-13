// ======================================================
// RETIRAFÁCIL AMORSAÚDE - APP.JS
// Autenticação Firebase + Firestore + Google Sheets
// ======================================================

// Configurações reais do seu projeto Firebase
const firebaseConfig = {
  apiKey: "AIzaSyD64_kOztghmGXcJOWF3IbTKHFlfRCedEk",
  authDomain: "retirafacil-75fd6.firebaseapp.com",
  projectId: "retirafacil-75fd6",
  storageBucket: "retirafacil-75fd6.firebasestorage.app",
  messagingSenderId: "81541416059",
  appId: "1:81541416059:web:7611e1cbf1bd05052fcede",
  measurementId: "G-62N41ZGE4S"
};

// URL de envio para a planilha Google Sheets
const APPS_SCRIPT_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbz2DOHliN6C1hdVNn2hn1QYVaG3mBUmVNkMDoSdWDMJhhbDslDEol1YPmelJQfoC5w3Dg/exec";

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
let currentDocIdToUpdate = "";
let currentAbaNomeToUpdate = "";


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

  if (!/^[a-z0-9._-]+$/.test(usuario)) {
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
    const emailInterno =
      `${usuario}@retirafacil-75fd6.firebaseapp.com`;

    await auth.signInWithEmailAndPassword(emailInterno, senha);

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
    colaboradorInput.value = currentUserProfile.nome;
    colaboradorInput.readOnly = true;
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

    botao.addEventListener("click", realizarLogout);
    areaBotoes.appendChild(botao);
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
  if (typeof unsubscribeExames === "function") {
    unsubscribeExames();
    unsubscribeExames = null;
  }

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

function iniciarSincronizacaoExames() {
  if (!db || !currentUser || !currentUserProfile) return;

  if (typeof unsubscribeExames === "function") {
    unsubscribeExames();
    unsubscribeExames = null;
  }

  updateSyncStatus("syncing", "Conectando aos exames...");

  unsubscribeExames = db
    .collection(FIRESTORE_BASE)
    .doc(FIRESTORE_APP_ID)
    .collection("public")
    .doc("data")
    .collection("exames")
    .onSnapshot((snapshot) => {
      const examesAgrupados = {};

      snapshot.forEach((docItem) => {
        const item = docItem.data();
        const nomeAba =
          item.abaOrigem || item.aba || "Exames Geral";

        if (!examesAgrupados[nomeAba]) {
          examesAgrupados[nomeAba] = {
            aba: nomeAba,
            dados: []
          };
        }

        let dataFormatada = item.dataRetirada || "";

        if (dataFormatada.length > 15) {
          try {
            const data = new Date(dataFormatada);

            if (!isNaN(data.getTime())) {
              dataFormatada = data.toLocaleDateString("pt-BR");
            }
          } catch (erro) {
            console.warn("Não foi possível formatar a data:", erro);
          }
        }

        examesAgrupados[nomeAba].dados.push([
          item.paciente || "",
          item.exame || "",
          "",
          "",
          dataFormatada,
          "",
          item.colaborador || "",
          "",
          item.quemRetirou || "",
          docItem.id
        ]);
      });

      sheetsData = Object.values(examesAgrupados);

      if (sheetsData.length === 0) {
        updateSyncStatus("success", "Conectado (sem exames)");
      } else {
        updateSyncStatus("success", "Conectado (Firebase)");
      }

      populateAbasSelect();
      renderTable();

    }, (error) => {
      console.error("Erro ao escutar Firestore:", error);
      updateSyncStatus("error", "Erro ao carregar exames");

      showToast(
        "Não foi possível carregar os exames. Verifique as regras do Firebase.",
        "warning"
      );
    });
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
    input.value = currentUserProfile.nome;
    input.readOnly = true;
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

      if (dataRetirada || assinatura) entregues++;
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
          Nenhum exame encontrado no Firebase.
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

      count++;

      const isEntregue =
        !!dataRetirada || !!colaborador;

      const pacienteEncoded =
        encodeURIComponent(paciente);

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
// ENVIO PARA A PLANILHA VIA JSONP
// ======================================================

function enviarParaPlanilha(dados) {
  return new Promise((resolve, reject) => {
    const callbackName =
      "retiraFacil_" +
      Date.now() +
      "_" +
      Math.random().toString(36).substring(2, 8);

    const params = new URLSearchParams({
      acao: "entregar",
      aba: dados.aba,
      paciente: dados.paciente,
      dataEntrega: dados.dataEntrega,
      colaborador: dados.colaborador,
      retiradoPor: dados.retiradoPor,
      callback: callbackName
    });

    const script = document.createElement("script");
    let finalizado = false;

    function limpar() {
      if (finalizado) return;

      finalizado = true;
      clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
    }

    const timeout = setTimeout(() => {
      limpar();
      reject(
        new Error(
          "Tempo esgotado aguardando confirmação da planilha."
        )
      );
    }, 20000);

    window[callbackName] = (resposta) => {
      limpar();

      if (resposta && resposta.sucesso) {
        resolve(resposta);
      } else {
        reject(
          new Error(
            resposta?.mensagem ||
            "O Apps Script não confirmou a gravação."
          )
        );
      }
    };

    script.onerror = () => {
      limpar();
      reject(
        new Error(
          "Não foi possível acessar o Google Apps Script."
        )
      );
    };

    script.src =
      APPS_SCRIPT_WEBAPP_URL + "?" + params.toString();

    document.head.appendChild(script);
  });
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

  const paciente = decodeURIComponent(pacienteEncoded);

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
  const paciente = currentEditingPaciente;

  const retiradoPorEl =
    document.getElementById("modal-retirado-por");

  const retiradoPor = retiradoPorEl
    ? retiradoPorEl.value.trim()
    : "";

  // O nome vem do perfil autenticado, nunca do campo editável.
  if (
    !currentUser ||
    !currentUserProfile ||
    currentUserProfile.ativo !== true
  ) {
    showToast(
      "Sua sessão não está autorizada. Entre novamente.",
      "warning"
    );
    return;
  }

  const colaborador = currentUserProfile.nome;

  if (!paciente) {
    showToast(
      "Não foi possível identificar o paciente.",
      "warning"
    );
    return;
  }

  if (!retiradoPor) {
    showToast(
      "Informe quem está retirando o exame.",
      "warning"
    );
    return;
  }

  if (!db || !currentDocIdToUpdate) {
    showToast(
      "Não foi possível identificar o registro no Firebase.",
      "warning"
    );
    return;
  }

  const now = new Date();
  const dataHoje = now.toLocaleDateString("pt-BR");

  const horaHoje = now.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const hash =
    "#" +
    Math.random().toString(36).substring(2, 7).toUpperCase();

  const assinaturaFormatada =
    `${colaborador.toUpperCase()} [ENTREGA DIGITAL: ${dataHoje} ${horaHoje} HASH: ${hash}]`;

  showToast("Gravando entrega no Firebase...", "info");

  // Primeiro grava no Firebase.
  try {
    await db
      .collection(FIRESTORE_BASE)
      .doc(FIRESTORE_APP_ID)
      .collection("public")
      .doc("data")
      .collection("exames")
      .doc(currentDocIdToUpdate)
      .update({
        dataRetirada: dataHoje,
        colaborador: assinaturaFormatada,
        quemRetirou: retiradoPor
      });

  } catch (erroFirebase) {
    console.error(
      "Erro ao atualizar Firebase:",
      erroFirebase
    );

    showToast(
      "Não foi possível salvar no Firebase.",
      "warning"
    );
    return;
  }

  // Depois envia para a planilha e aguarda confirmação.
  try {
    showToast(
      "Firebase atualizado. Gravando na planilha...",
      "info"
    );

    const resultado = await enviarParaPlanilha({
      aba: currentAbaNomeToUpdate || "Exames Geral",
      paciente: paciente,
      dataEntrega: dataHoje,
      colaborador: assinaturaFormatada,
      retiradoPor: retiradoPor
    });

    console.log("Confirmação da planilha:", resultado);

    closeModal();

    showToast(
      "Entrega salva no Firebase e na Planilha!",
      "success"
    );

  } catch (erroPlanilha) {
    console.error(
      "Firebase foi atualizado, mas a planilha falhou:",
      erroPlanilha
    );

    closeModal();

    showToast(
      "Firebase salvo, mas a planilha não confirmou: " +
      erroPlanilha.message,
      "warning"
    );
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
document.getElementById("admin-password-form")?.addEventListener("submit", event => {
  event.preventDefault();
  const senha = document.getElementById("admin-password-input")?.value;
  const erro = document.getElementById("admin-password-error");
  if (senha === "Amor@2026") {
    fecharModalSenhaAdmin();
    window.location.href = "panel-adm.html";
  } else if (erro) {
    erro.textContent = "Acesso negado";
    erro.classList.remove("hidden");
  }
});


// ======================================================
// FECHAR MODAIS E TUTORIAL
// ======================================================

function closeModal() {
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
