# Cadastro de usuários pelo painel administrativo

Esta funcionalidade requer que o arquivo `workers.js` seja implantado como Cloudflare Worker na **mesma origem** do site e que as rotas `/api/admin/users` sejam encaminhadas ao Worker. Publicar apenas `panel-adm.html` não habilita a criação de contas.

## Configuração

1. No Cloudflare Worker, configure `FIREBASE_SERVICE_ACCOUNT_JSON` como **Secret**, contendo o JSON completo de uma conta de serviço Firebase/Google Cloud, do projeto `retirafacil-75fd6`. **Nunca** coloque esse JSON no GitHub ou no HTML.
2. A conta de serviço precisa de permissões adequadas para administrar usuários do Firebase Authentication e documentos da coleção de usuários no Firestore. Atribua somente as permissões necessárias.
3. Preserve os bindings `SESSIONS`, `FIREBASE_WEB_API_KEY`, `ADMIN_PASSWORD` e `ASSETS` já previstos no Worker. A senha administrativa deve ficar em `ADMIN_PASSWORD`, não no JavaScript público.
4. A interface chama `GET /api/admin/users` para listar, `POST /api/admin/users` para cadastrar e `PATCH /api/admin/users/:uid` para ativar/desativar.
5. As operações exigem token Firebase de um administrador ativo e cookie de confirmação administrativa de curta duração gerado por `POST /api/admin/verify`. O painel continua a exigir um perfil `tipo: "admin"`.

## Atenção à implantação atual

O `app.js` foi ajustado nesta branch para validar a senha no Worker por meio de `POST /api/admin/verify`, em vez de conferir uma senha escrita no JavaScript público.

O sistema usa internamente e-mail sintético no formato `usuario@retirafacil-75fd6.firebaseapp.com`, embora a tela de login peça apenas o nome de usuário. Senhas jamais devem ser salvas em documentos Firestore.

Teste a criação, a ativação, a desativação e a tentativa de acesso por um colaborador sem permissão administrativa antes de publicar em produção. Faça cópia de segurança e valide as regras Firestore atuais.
