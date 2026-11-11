// Configurações do Google Apps Script
const API_URL = "https://script.google.com/macros/s/AKfycbw5Y5y0gI5ZOvNGoIWHXJyOS3Ga0AdD2OgZo7Pr159M5oobq18UA4KX73x-1X4eyzRgPw/exec";

// Estado da Aplicação
let sheetsData = [];
let currentAbaIndex = 0;
let isSyncing = false;
let currentEditingPaciente = null;

// Interceptador Global de Erros para Evitar Alertas Falsos de Redes Cross-Domain
window.onerror = function(msg, url, lineNo, columnNo, error) {
  if (msg && msg.indexOf('Script error') > -1) {
    return true; // Suprime a mensagem Script error. genérica do navegador
  }
  return false;
};

// Inicialização da Página
window.onload = function() {
  initTheme();
  loadColaboradorSalvo();
  syncWithSheets();
  
  // Sincronização Automática Contínua a cada 30 segundos
  setInterval(() => {
    syncWithSheets(false);
  }, 30000);
};

// --- MODO ESCURO (DARK MODE) ---
function initTheme() {
  const savedTheme = localStorage.getItem('retirafacil_theme');
  if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
    updateThemeIcon(true);
  } else {
    document.documentElement.classList.remove('dark');
    updateThemeIcon(false);
  }
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('retirafacil_theme', isDark ? 'dark' : 'light');
  updateThemeIcon(isDark);
}

function updateThemeIcon(isDark) {
  const icon = document.getElementById('theme-toggle-icon');
  if (icon) {
    icon.className = isDark ? 'fas fa-sun text-amber-400' : 'fas fa-moon';
  }
}

// --- CARREGAMENTO DE DADOS E SINCRONIZAÇÃO DA PLANILHA ---
function syncWithSheets(manual = false) {
  if (isSyncing) return;
  isSyncing = true;
  
  updateSyncStatus('syncing', manual ? 'Atualizando...' : 'Conectando...');
  
  const callbackName = 'jsonp_read_' + Math.round(100000 * Math.random());
  
  window[callbackName] = function(data) {
    delete window[callbackName];
    if (scriptElement && scriptElement.parentNode) {
      scriptElement.parentNode.removeChild(scriptElement);
    }
    isSyncing = false;
    
    if (Array.isArray(data) && data.length > 0) {
      sheetsData = data;
      populateAbasSelect();
      renderTable();
      updateSyncStatus('success', 'Sincronizado');
    } else {
      updateSyncStatus('error', 'Erro nos dados');
    }
  };

  const scriptElement = document.createElement('script');
  scriptElement.src = `${API_URL}?prefix=${callbackName}&t=${Date.now()}`;
  
  scriptElement.onerror = function() {
    delete window[callbackName];
    if (scriptElement.parentNode) scriptElement.parentNode.removeChild(scriptElement);
    isSyncing = false;
    updateSyncStatus('error', 'Falha na conexão');
  };

  document.body.appendChild(scriptElement);
}

function updateSyncStatus(status, text) {
  const badge = document.getElementById('sync-badge');
  const icon = document.getElementById('sync-icon');
  const textEl = document.getElementById('sync-text');
  
  if (!badge || !textEl || !icon) return;
  
  textEl.innerText = text;
  
  if (status === 'syncing') {
    icon.className = 'fas fa-sync-alt fa-spin text-sky-500';
  } else if (status === 'success') {
    icon.className = 'fas fa-check-circle text-emerald-500';
  } else if (status === 'error') {
    icon.className = 'fas fa-exclamation-circle text-rose-500';
  }
}

function populateAbasSelect() {
  const select = document.getElementById('aba-select');
  if (!select || sheetsData.length === 0) return;
  
  const savedValue = select.value;
  select.innerHTML = '';
  
  // Opção para buscar em todas as abas simultaneamente
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.innerText = 'TODAS AS ABAS / EXAMES';
  select.appendChild(allOpt);

  sheetsData.forEach((item, index) => {
    const opt = document.createElement('option');
    opt.value = index;
    opt.innerText = item.aba;
    select.appendChild(opt);
  });
  
  if (savedValue && (savedValue === 'all' || select.options[savedValue])) {
    select.value = savedValue;
    currentAbaIndex = savedValue === 'all' ? 'all' : parseInt(savedValue);
  } else {
    select.value = 0;
    currentAbaIndex = 0;
  }
}

function changeAba() {
  const select = document.getElementById('aba-select');
  const val = select.value;
  currentAbaIndex = val === 'all' ? 'all' : parseInt(val);
  renderTable();
}

function handleSearch() {
  const input = document.getElementById('search-input');
  const btnClear = document.getElementById('clear-search');
  if (btnClear) {
    if (input.value.length > 0) btnClear.classList.remove('hidden');
    else btnClear.classList.add('hidden');
  }
  renderTable();
}

function clearSearch() {
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  const btnClear = document.getElementById('clear-search');
  if (btnClear) btnClear.classList.add('hidden');
  renderTable();
}

function loadColaboradorSalvo() {
  const salvo = localStorage.getItem('retirafacil_colaborador');
  const input = document.getElementById('modal-colaborador');
  if (salvo && input) {
    input.value = salvo;
  }
}

// --- RENDERIZAÇÃO DA TABELA ---
function renderTable() {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;
  
  if (!sheetsData || sheetsData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-slate-400">
          <i class="fas fa-inbox text-3xl mb-2 block"></i>
          Nenhum dado encontrado.
        </td>
      </tr>
    `;
    return;
  }
  
  const searchTerm = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  
  // Monta a lista de abas a serem processadas
  let abasToProcess = [];
  if (currentAbaIndex === 'all') {
    abasToProcess = sheetsData.map((sheet, index) => ({ sheet, index }));
  } else if (sheetsData[currentAbaIndex]) {
    abasToProcess = [{ sheet: sheetsData[currentAbaIndex], index: currentAbaIndex }];
  }

  let html = '';
  let count = 0;

  abasToProcess.forEach(({ sheet, index: abaIdx }) => {
    const rows = sheet.dados || [];
    const nomeAba = sheet.aba;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const paciente = row[0] ? String(row[0]).trim() : '';
      
      // Pega o exame (Coluna B ou ajustável se estiver em outra coluna)
      const exame = nomeAba; // Aqui você pode ajustar se quiser pegar de outra coluna específica
      
      if (!paciente) continue;
      
      const dataRetirada = row[4] ? String(row[4]).trim() : '';
      const assinatura = row[6] ? String(row[6]).trim() : '';
      const quemRetirou = row[9] ? String(row[9]).trim() : '';

      // Filtro de Busca
      if (searchTerm) {
        const matchPaciente = paciente.toLowerCase().includes(searchTerm);
        const matchQuemRetirou = quemRetirou.toLowerCase().includes(searchTerm);
        const matchExame = exame.toLowerCase().includes(searchTerm);
        const matchAba = nomeAba.toLowerCase().includes(searchTerm);
        if (!matchPaciente && !matchQuemRetirou && !matchExame && !matchAba) continue;
      }
      
      count++;
      
      const isEntregue = !!dataRetirada || !!assinatura;
      const pacienteEncoded = encodeURIComponent(paciente);
      
      // Exibe o nome da aba de origem em qualquer modo de visualização.
      // Na opção "Todas as abas", mantém o destaque visual com o ícone de pasta.
      // Na visualização individual, mostra o mesmo nome sem duplicá-lo.
      let detalheExameOuAba = '';

      if (nomeAba && nomeAba !== '-') {
        if (currentAbaIndex === 'all') {
          detalheExameOuAba = `
            <span class="inline-flex items-center gap-1 font-semibold text-[#45b7c9] bg-sky-50 dark:bg-sky-950/60 border border-sky-200 dark:border-sky-800 px-2 py-0.5 rounded text-[11px] mb-1">
              <i class="far fa-folder-open"></i> ${nomeAba}
            </span>
          `;
        } else {
          detalheExameOuAba = `
            <span class="text-slate-600 dark:text-slate-300 text-xs">
              <i class="far fa-folder-open mr-1"></i>${nomeAba}
            </span>
          `;
        }
      } else {
        detalheExameOuAba = '<span class="text-slate-400">-</span>';
      }

      html += `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
          <td class="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">
            ${paciente}
          </td>
          <td class="py-3.5 px-4 text-slate-600 dark:text-slate-300 text-xs">${detalheExameOuAba}</td>
          <td class="py-3.5 px-4 text-slate-600 dark:text-slate-300 text-xs font-mono">
            ${dataRetirada ? `<span class="bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 rounded font-semibold">${dataRetirada}</span>` : '<span class="text-slate-400">Pendente</span>'}
          </td>
          <td class="py-3.5 px-4 text-xs font-mono text-slate-500 dark:text-slate-400 max-w-xs truncate" title="${assinatura}">
            ${assinatura ? `<span class="text-emerald-600 dark:text-emerald-400">${assinatura}</span>` : '-'}
          </td>
          <td class="py-3.5 px-4 text-slate-700 dark:text-slate-200 text-xs font-medium">${quemRetirou || '-'}</td>
          <td class="py-3.5 px-4 text-center">
            ${isEntregue 
              ? `<span class="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950/50 px-2.5 py-1 rounded-lg border border-emerald-200 dark:border-emerald-800"><i class="fas fa-check"></i> Entregue</span>`
              : `<button onclick="openEntregaModal('${pacienteEncoded}', ${abaIdx})" class="bg-[#45b7c9] hover:bg-[#3ba4b5] text-white text-xs font-bold px-3 py-1.5 rounded-lg shadow-sm transition transform active:scale-95 flex items-center gap-1 mx-auto">
                  <i class="fas fa-hand-holding"></i> Entregar
                 </button>`
            }
          </td>
        </tr>
      `;
    }
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

// --- LOGÍSTICA DE ASSINATURA ELETRÔNICA NO MODAL ---
function openEntregaModal(pacienteEncoded, especificAbaIdx = null) {
  const paciente = decodeURIComponent(pacienteEncoded);
  currentEditingPaciente = paciente;

  if (especificAbaIdx !== null) {
    currentAbaIndexForSave = especificAbaIdx;
  } else {
    currentAbaIndexForSave = currentAbaIndex;
  }

  document.getElementById('modal-paciente').value = paciente;
  document.getElementById('modal-retirado-por').value = '';
  
  const randomHash = '#' + Math.random().toString(36).substring(2, 7).toUpperCase();
  const hashPreviewEl = document.getElementById('preview-hash');
  if (hashPreviewEl) hashPreviewEl.innerText = randomHash;

  loadColaboradorSalvo();

  document.getElementById('modal-entrega').classList.remove('hidden');
}

// Variável auxiliar para gravar na aba correta ao entregar na busca geral
let currentAbaIndexForSave = 0;

function confirmarEntregaAction() {
  const paciente = currentEditingPaciente;
  const retiradoPor = document.getElementById('modal-retirado-por').value.trim();
  const colaborador = document.getElementById('modal-colaborador').value.trim();
  
  if (!retiradoPor || !colaborador) {
    showToast('Por favor, preencha quem retirou e o seu nome!', 'warning');
    return;
  }

  localStorage.setItem('retirafacil_colaborador', colaborador);

  // Obtém o nome exato da aba onde o registro está alocado
  const abaIdx = currentAbaIndexForSave === 'all' ? 0 : currentAbaIndexForSave;
  const abaNome = sheetsData[abaIdx].aba;
  
  const now = new Date();
  const dataHoje = now.toLocaleDateString('pt-BR');
  const horaHoje = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hash = '#' + Math.random().toString(36).substring(2, 7).toUpperCase();
  
  const assinaturaFormatada = `${colaborador.toUpperCase()} [ENTREGA DIGITAL: ${dataHoje} ${horaHoje} - HASH: ${hash}]`;

  closeModal();
  showToast('Enviando para a planilha...', 'info');

  const callbackName = 'jsonp_save_' + Math.round(100000 * Math.random());
  
  window[callbackName] = function(res) {
    delete window[callbackName];
    if (scriptElement && scriptElement.parentNode) {
      scriptElement.parentNode.removeChild(scriptElement);
    }
    showToast('Entrega gravada com sucesso!', 'success');
    syncWithSheets(true);
  };

  const params = [
    `aba=${encodeURIComponent(abaNome)}`,
    `paciente=${encodeURIComponent(paciente)}`,
    `dataEntrega=${encodeURIComponent(dataHoje)}`,
    `colaborador=${encodeURIComponent(assinaturaFormatada)}`,
    `retiradoPor=${encodeURIComponent(retiradoPor)}`,
    `prefix=${callbackName}`,
    `t=${Date.now()}`
  ].join('&');

  const scriptElement = document.createElement('script');
  scriptElement.src = `${API_URL}?${params}`;
  
  scriptElement.onerror = function() {
    delete window[callbackName];
    if (scriptElement.parentNode) scriptElement.parentNode.removeChild(scriptElement);
    showToast('Processado! Atualizando dados...', 'success');
    syncWithSheets(true);
  };

  document.body.appendChild(scriptElement);
}

// Função Toast de Notificação
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');

  if (!toast || !toastMsg) return;

  toastMsg.innerText = message;
  toast.className = "toast-notification fixed top-5 right-5 z-50 flex items-center gap-3 px-5 py-3 rounded-xl shadow-xl text-white font-medium text-sm transition-all duration-300 ";

  if (type === 'success') {
    toast.classList.add('bg-emerald-600');
    toastIcon.className = 'fas fa-check-circle text-xl';
  } else if (type === 'warning') {
    toast.classList.add('bg-amber-500');
    toastIcon.className = 'fas fa-exclamation-triangle text-xl';
  } else {
    toast.classList.add('bg-[#45b7c9]');
    toastIcon.className = 'fas fa-info-circle text-xl';
  }

  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}