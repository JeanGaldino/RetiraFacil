# Integração de retiradas com Google Sheets

O Google Sheets é a fonte dos registros; Firebase autentica os usuários. O navegador chama o Worker na mesma origem, e o Worker chama o Apps Script com POST autenticado.

## Implantação obrigatória

1. Faça backup da planilha. Abra Extensões > Apps Script na planilha correta e substitua o conteúdo pelo Code.gs deste repositório. Não publique segredos no GitHub.
2. Em Configurações do projeto > Propriedades do script, configure RF_SPREADSHEET_ID com o ID entre /d/ e /edit na URL da planilha (sem a URL completa). Configure RF_API_SECRET com o mesmo valor do segredo APPS_SCRIPT_SHARED_SECRET do Worker.
3. Em Implantar > Gerenciar implantações, edite a implantação usada pelo Worker, selecione Nova versão, executar como proprietário e acesso apropriado para chamadas do Worker (sem login interativo; o código exige o segredo em cada POST). Confirme que a URL /exec coincide com APPS_SCRIPT_WEBAPP_URL no Cloudflare. Se mudou a implantação, atualize a variável no Cloudflare e wrangler.jsonc. Não troque pela antiga URL usada no navegador.
4. Implemente o Worker e os arquivos estáticos da mesma revisão. Preserve os segredos e bindings existentes. Atualize a página com Ctrl+Shift+R.
5. Em uma linha de teste autorizada, confirme uma retirada e verifique E (data), G (assinatura), I (retirado por) no Sheets. Verifique que as outras colunas permanecem intactas. Repita somente em ambiente de teste para conferir a idempotência de apresentação (uma entrega existente não é sobrescrita). Teste também homônimos com exames diferentes e registros ambíguos. A identificação inclui aba, linha, nome e exame; não substitui um identificador imutável de paciente. Não reorganize a planilha durante o teste.

## Diagnóstico
- NAO_AUTORIZADO: confira a correspondência dos dois segredos.
- APPS_SCRIPT_RESPOSTA_INVALIDA / APPS_SCRIPT_HTTP: confira a versão /exec, a configuração de acesso e as permissões.
- ERRO_INTERNO: confira Execuções no Apps Script, acesso à planilha e RF_SPREADSHEET_ID.
- REGISTRO_ALTERADO / AMBIGUO: atualize a pesquisa e confira a linha correta; não force gravação em homônimos indistinguíveis.
- REGISTRO_PARCIAL / GRAVACAO_NAO_CONFIRMADA: confira E/G/I antes de repetir, pois pode ter ocorrido uma gravação parcial.
- OCUPADO: tente novamente após alguns segundos.

O Worker só retorna sucesso se a resposta contiver os campos de entrega. O script atual relê as células após flush para validar. O cache KV tem consistência eventual e pode mostrar uma versão antiga brevemente. Não há alteração nas colunas K/L nem gravação de exames no Firestore. A migração de registros históricos do Firebase, se necessária, deve ser conciliada separadamente sem sobrescrever registros existentes.

