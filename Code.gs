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
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  if(!ss)throw new Error("Planilha vinculada indisponível.");
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
          // Identificador visual estável para a interface; a entrega é por nome + aba.
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
function rfEntregar(data) {
  const paciente=rfTexto(data.paciente),abaNome=rfTexto(data.aba);
  const colaborador=rfTexto(data.colaborador),retiradoPor=rfTexto(data.retiradoPor);
  if(!paciente || paciente.length>200 || !abaNome || abaNome.length>120 ||
     !colaborador || colaborador.length>150 || !retiradoPor || retiradoPor.length>150)
    return {sucesso:false,codigo:"INVALIDO"};
  return rfBloqueio(function(){
    const aba=rfPlanilha().getSheetByName(abaNome);
    if(!aba || aba.getLastRow()<2)return {sucesso:false,codigo:"NAO_ENCONTRADO"};
    const rows=aba.getRange(2,1,aba.getLastRow()-1,9).getValues();
    const encontrados=[];
    for(let i=0;i<rows.length;i++)
      if(rfNome(rows[i][0])===rfNome(paciente))encontrados.push({linha:i+2,row:rows[i]});
    if(encontrados.length===0)return {sucesso:false,codigo:"NAO_ENCONTRADO"};
    // Não escolhe arbitrariamente entre homônimos, mesmo que um esteja entregue.
    if(encontrados.length!==1)return {sucesso:false,codigo:"AMBIGUO"};
    const {linha,row}=encontrados[0];
    if(rfTexto(row[4]) || rfTexto(row[6]) || rfTexto(row[8]))
      return {sucesso:false,codigo:"JA_ENTREGUE"};
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
    return {sucesso:true,entrega:{aba:abaNome,dataRetirada,colaborador:assinatura,quemRetirou:retiradoPor}};
  });
}
