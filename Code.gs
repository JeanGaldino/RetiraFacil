/**
 * RetiraFácil - Apps Script vinculado à planilha.
 * Publicar como NOVA VERSÃO da implantação /exec existente.
 * Script Property RF_API_SECRET deve corresponder ao segredo do Worker.
 * A: paciente | E: data | G: colaborador/assinatura | I: retirado por.
 * Não escreve nas colunas K ou L.
 */
const RF_TZ = "America/Sao_Paulo";
function doGet() {
  return rfResposta({sucesso:false,codigo:"METODO_NAO_PERMITIDO"});
}
function doPost(e) {
  try {
    const data=JSON.parse(e?.postData?.contents || "{}");
    const secret=PropertiesService.getScriptProperties().getProperty("RF_API_SECRET");
    if (!secret || !rfIgualSeguro(String(data.secret || ""),secret))
      return rfResposta({sucesso:false,codigo:"NAO_AUTORIZADO"});
    if(data.acao==="listar") return rfResposta({sucesso:true,exames:rfListar()});
    if(data.acao==="listar_lote") return rfResposta(rfListarLote(data));
    if(data.acao==="entregar") return rfResposta(rfEntregar(data));
    return rfResposta({sucesso:false,codigo:"ACAO_INVALIDA"});
  } catch(err) {
    console.error(err);
    return rfResposta({sucesso:false,codigo:"ERRO_INTERNO"});
  }
}
function rfResposta(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function rfIgualSeguro(a,b) {
  if(a.length!==b.length)return false;
  let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);
  return d===0;
}
function rfTexto(v) {
  return v instanceof Date?Utilities.formatDate(v,RF_TZ,"dd/MM/yyyy"):String(v==null?"":v).trim();
}
function rfNome(v) {
  return rfTexto(v).replace(/\s+/g," ").toLocaleLowerCase("pt-BR");
}
function rfPlanilha() {
  // Web apps não devem depender do contexto de uma planilha aberta.
  const id=PropertiesService.getScriptProperties().getProperty("RF_SPREADSHEET_ID");
  const ss=id?SpreadsheetApp.openById(id.trim()):SpreadsheetApp.getActiveSpreadsheet();
  if(!ss)throw new Error("Configure RF_SPREADSHEET_ID nas propriedades do script.");
  return ss;
}
function rfBloqueio(fn) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(25000))return {sucesso:false,codigo:"OCUPADO"};
  try{return fn();}finally{lock.releaseLock();}
}
function rfListar() {
  const resultado=(function(){
    const exames=[];
    for(const aba of rfPlanilha().getSheets()){
      const last=aba.getLastRow();
      if(last<2)continue;
      const rows=aba.getRange(2,1,last-1,9).getValues();
      for(let i=0;i<rows.length;i++){
        const r=rows[i],paciente=rfTexto(r[0]);
        if(!paciente || rfNome(paciente)==="nome do paciente")continue;
        exames.push({
          // Identifica a linha exibida. A retirada também confere nome, exame e duplicidade.
          id:aba.getSheetId()+"_"+(i+2),
          paciente,exame:rfTexto(r[1]),
          dataRetirada:rfTexto(r[4]),colaborador:rfTexto(r[6]),
          quemRetirou:rfTexto(r[8]),abaOrigem:aba.getName()
        });
        if(exames.length>20000)throw new Error("Limite de registros excedido.");
      }
    }
    return {sucesso:true,exames};
  })();
  if(!resultado.sucesso)throw new Error("Planilha ocupada.");
  return resultado.exames;
}
/**
 * Sincronização progressiva: no máximo uma aba e 400 registros por chamada.
 * Cursor opaco codifica índice da aba e próxima linha. A API intermediária
 * deve repassar cursor e a resposta completa, sem reconsultar rfListar().
 * A listagem completa existente permanece disponível durante a migração.
 */
function rfListarLote(data) {
  const tamanho = 400;
  const abas = rfPlanilha().getSheets();
  const cursor = String(data.cursor || "");
  let indice = 0, linha = 2;
  if (cursor) {
    const partes = /^(\\d+):(\\d+):(\\d+)$/.exec(cursor);
    if (!partes) return {sucesso:false,codigo:"CURSOR_INVALIDO"};
    indice = Number(partes[1]);
    linha = Number(partes[2]);
    const idEsperado = Number(partes[3]);
    if (!Number.isSafeInteger(indice) || indice < 0 || indice >= abas.length ||
        !Number.isSafeInteger(linha) || linha < 2 ||
        abas[indice].getSheetId() !== idEsperado)
      return {sucesso:false,codigo:"CURSOR_INVALIDO"};
  }
  // Uma aba por chamada evita percorrer todas as abas antes de responder.
  if (indice >= abas.length) return {sucesso:true,exames:[],concluido:true,cursor:null};
  const aba = abas[indice];
  const ultimaLinha = aba.getLastRow();
  const ultimaLida = Math.min(ultimaLinha, linha + tamanho - 1);
  const exames = [];
  if (ultimaLida >= linha) {
    const rows = aba.getRange(linha,1,ultimaLida-linha+1,9).getValues();
    for (let i=0;i<rows.length;i++) {
      const r=rows[i], paciente=rfTexto(r[0]);
      if (!paciente || rfNome(paciente)==="nome do paciente") continue;
      exames.push({
        id:aba.getSheetId()+"_"+(linha+i),
        paciente,exame:rfTexto(r[1]),
        dataRetirada:rfTexto(r[4]),colaborador:rfTexto(r[6]),
        quemRetirou:rfTexto(r[8]),abaOrigem:aba.getName()
      });
    }
  }
  const continuaNaAba = ultimaLida < ultimaLinha;
  const proximoIndice = continuaNaAba ? indice : indice + 1;
  const proximaLinha = continuaNaAba ? ultimaLida + 1 : 2;
  const concluido = proximoIndice >= abas.length;
  return {
    sucesso:true,exames,concluido,
    cursor:concluido ? null : proximoIndice+":"+proximaLinha+":"+abas[proximoIndice].getSheetId(),
    abaAtual:aba.getName(),abasProcessadas:continuaNaAba?indice:indice+1,totalAbas:abas.length
  };
}

function rfEntregar(data) {
  const paciente=rfTexto(data.paciente),abaNome=rfTexto(data.aba);
  const colaborador=rfTexto(data.colaborador),retiradoPor=rfTexto(data.retiradoPor);
  if(!paciente || paciente.length>200 || !abaNome || abaNome.length>120 ||
     !colaborador || colaborador.length>150 || !retiradoPor || retiradoPor.length>150)
    return {sucesso:false,codigo:"INVALIDO"};
  return rfBloqueio(function(){
    const aba=rfPlanilha().getSheetByName(abaNome);
    if(!aba || aba.getLastRow()<2)return {sucesso:false,codigo:"NAO_ENCONTRADO"};
    const id=rfTexto(data.id), exame=rfTexto(data.exame);
    const rows=aba.getRange(2,1,aba.getLastRow()-1,9).getValues();
    const encontrados=[];
    for(let i=0;i<rows.length;i++)
      if(rfNome(rows[i][0])===rfNome(paciente))encontrados.push({linha:i+2,row:rows[i]});
    if(encontrados.length===0)return {sucesso:false,codigo:"NAO_ENCONTRADO"};
    let registro;
    if(id){
      const partes=/^(\d+)_(\d+)$/.exec(id);
      if(!partes || Number(partes[1])!==aba.getSheetId())
        return {sucesso:false,codigo:"REGISTRO_ALTERADO"};
      registro=encontrados.find(item=>item.linha===Number(partes[2]));
      if(!registro || rfTexto(registro.row[1])!==exame)
        return {sucesso:false,codigo:"REGISTRO_ALTERADO"};
      // Dois registros indistinguíveis pelo nome e exame não permitem confirmar
      // qual paciente é o correto, principalmente se uma linha foi movida.
      if(encontrados.filter(item=>rfTexto(item.row[1])===exame).length!==1)
        return {sucesso:false,codigo:"AMBIGUO"};
    }else{
      // Compatibilidade temporária com clientes anteriores.
      if(encontrados.length!==1)return {sucesso:false,codigo:"AMBIGUO"};
      registro=encontrados[0];
    }
    const {linha,row}=registro;
    const atual={id:aba.getSheetId()+"_"+linha,aba:abaNome,dataRetirada:rfTexto(row[4]),colaborador:rfTexto(row[6]),quemRetirou:rfTexto(row[8])};
    if(atual.dataRetirada && atual.colaborador && atual.quemRetirou)
      return {sucesso:false,codigo:"JA_ENTREGUE",entrega:atual};
    if(atual.dataRetirada || atual.colaborador || atual.quemRetirou)
      return {sucesso:false,codigo:"REGISTRO_PARCIAL"};
    const now=new Date();
    const dataRetirada=Utilities.formatDate(now,RF_TZ,"dd/MM/yyyy");
    const hora=Utilities.formatDate(now,RF_TZ,"HH:mm");
    const hash=Utilities.getUuid().slice(0,8).toUpperCase();
    const assinatura=colaborador.toUpperCase()+" [ENTREGA DIGITAL: "+dataRetirada+" "+hora+" HASH: #"+hash+"]";
    const seguro=s=>/^[=+@-]/.test(s)?"'"+s:s;
    aba.getRange(linha,5).setValue(dataRetirada);
    aba.getRange(linha,7).setValue(seguro(assinatura));
    aba.getRange(linha,9).setValue(seguro(retiradoPor));
    SpreadsheetApp.flush();
    const gravado=aba.getRange(linha,5,1,5).getValues()[0];
    const entrega={id:aba.getSheetId()+"_"+linha,aba:abaNome,dataRetirada:rfTexto(gravado[0]),colaborador:rfTexto(gravado[2]),quemRetirou:rfTexto(gravado[4])};
    if(entrega.dataRetirada!==dataRetirada || entrega.colaborador!==assinatura || entrega.quemRetirou!==retiradoPor)
      return {sucesso:false,codigo:"GRAVACAO_NAO_CONFIRMADA"};
    return {sucesso:true,entrega};
  });
}
