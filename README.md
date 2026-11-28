# Marketplace API

## Rodar localmente
    cp .env.example .env   # preencha os valores
    npm install
    export $(cat .env | xargs) && npm run dev

## Deploy no Render
1. Suba para o GitHub.
2. Render > New + > Blueprint > selecione o repositório (usa o render.yaml).
3. Quando pedir DATABASE_URL, cole a string do seu banco (AWS RDS). Nunca commite essa string.
4. Configure `DATABASE_URL` e `JWT_SECRET` do `sheserve-admin-api` com os mesmos valores usados pelo `marketplace-api`.
5. No AWS: instância com acesso público e Security Group liberando a porta 5432 para os IPs de saída do Render.
6. Implante o `marketplace-api` primeiro; o serviço admin depende do esquema principal do banco.

## API administrativa

O serviço separado `admin-api/` compartilha o banco e os tokens JWT do
`marketplace-api`. Consulte [admin-api/README.md](./admin-api/README.md) para
provisionar o papel administrativo e os endpoints de aprovação, planos e auditoria.
O cadastro público não pode criar administradores.

## Pagamentos (modo demonstração)
Módulo completo sobre o `MockGateway` (`PAYMENT_GATEWAY=mock`), no formato do Pagar.me:
taxa embutida no preço da cliente, split em centavos, assinaturas com retentativa,
direitos de agendamento, repasse semanal, dados de nota por cobrança e webhooks.
- Código: `src/payments/` (motor da taxa em `money.js`, máquina de estados em
  `subscriptionStateMachine.js`); esquema em `src/payments_schema.sql`.
- Trocar pelo gateway real: [src/payments/README.md](./src/payments/README.md).
- Seed de demonstração: `npm run seed:demo` (`-- --reset` para recriar). Contas em
  `@demo.sheserve.app`, senha `demo1234`.
- Ponta a ponta contra um banco descartável:
  `PAYMENTS_E2E_DATABASE_URL=postgres://... node --test test/payments_e2e.test.js`.
- Configuração no painel admin, seção **Pagamentos**.

## Pendências (marcadas como TODO no código)
- Gateway de pagamento real (hoje: mock; ver src/payments/README.md)
- Provedor de OTP (SMS)
- Provedor de verificação de identidade + upload com URL assinada
- Notificação de SOS
- Filtro por distância (falta área de atendimento no ERD)
- Aprovação de prestadoras é feita pela API administrativa

## Solicitações e orçamentos
- `POST /api/v1/requests` cria uma solicitação.
- `GET /api/v1/requests` lista solicitações do cliente ou da prestadora.
- `POST /api/v1/requests/{id}/quotes` envia uma proposta e reserva 1 cota.
- `POST /api/v1/quotes/{id}/approve` aprova uma proposta e encerra as demais.
- `GET/POST /api/v1/quotes/{id}/messages` lista e envia mensagens da negociação.
- `POST /api/v1/quotes/{id}/counter` salva uma contraproposta e nova validade.
- `POST /api/v1/quotes/{id}/reject` recusa uma proposta.
- Mini-ERP: `/api/v1/me/plan`, `/financial`, `/inventory`, `/clients`, `/stats`, `/insights`,
  `/promotions`, `/purchases`, `/team` e `/notifications`.
- O painel financeiro é servido por `/api/v1/me/financial/dashboard?period=week|month|year`;
  o fluxo de caixa agrega dias, semanas do mês ou meses do ano, e `byCategory` separa o que
  veio de atendimentos do app do que entrou por fora. Um "a receber" pode ser marcado como
  recebido (`PATCH .../entries/{id}/received`) e lançamentos feitos à mão podem ser excluídos.
- Ao concluir um atendimento, a API cria uma única movimentação "A receber" ligada ao pedido.
  Ela permanece como recebível enquanto o repasse estiver pendente.
- `/api/v1/me/stats` inclui atendimentos e clientes atendidos, valores concluídos e série
  mensal de atendimentos, clientes, receitas e despesas.
- `/api/v1/me/insights` devolve os totais mensais do financeiro (6 meses fechados + o atual)
  e o resumo do inventário; o app calcula as dicas, o ponto de equilíbrio e a previsão.
- Ferramentas do Pro (`src/routes/business.js`): perfil da marca (`/me/branding`, aparece no
  catálogo só com o recurso `branding`), dados fiscais e notas de serviço (`/me/fiscal`,
  `/me/invoices`, hoje em rascunho; a integração de emissão está avaliada em
  `docs/NOTAS_FISCAIS.md` no app) e orçamento livre (`/me/custom-quotes`).
- Inventário (`/api/v1/me/inventory`, recurso `inventory`, do Standard em diante): itens com
  quantidade, mínimo e custo; compra, uso, perda e contagem em transação, sem deixar o estoque
  negativo (409 `insufficient_stock`). Compra e perda podem gerar a saída no financeiro.
- O pagamento externo continua dependente de gateway aprovado e conta da loja.
- Máximo de 3 orçamentos abertos por solicitação.
- Limites mensais: Gratuito 20; Standard 40; Pro 100; Premium ilimitado.
