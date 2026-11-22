# Marketplace API

## Rodar localmente
    cp .env.example .env   # preencha os valores
    npm install
    export $(cat .env | xargs) && npm run dev

## Deploy no Render
1. Suba para o GitHub.
2. Render > New + > Blueprint > selecione o repositório (usa o render.yaml).
3. Quando pedir DATABASE_URL, cole a string do seu banco (AWS RDS). Nunca commite essa string.
4. No AWS: instância com acesso público e Security Group liberando a porta 5432 para os IPs de saída do Render.
5. As tabelas são criadas automaticamente na primeira inicialização.

## Pendências (marcadas como TODO no código)
- Gateway de pagamento (Pix/cartão)
- Provedor de OTP (SMS)
- Provedor de verificação de identidade + upload com URL assinada
- Notificação de SOS
- Filtro por distância (falta área de atendimento no ERD)
- Ativação de prestadoras (activation_status) é feita pelo backoffice

## Solicitações e orçamentos
- `POST /api/v1/requests` cria uma solicitação.
- `GET /api/v1/requests` lista solicitações do cliente ou da prestadora.
- `POST /api/v1/requests/{id}/quotes` envia uma proposta e reserva 1 cota.
- `POST /api/v1/quotes/{id}/approve` aprova uma proposta e encerra as demais.
- `GET/POST /api/v1/quotes/{id}/messages` lista e envia mensagens da negociação.
- `POST /api/v1/quotes/{id}/counter` salva uma contraproposta e nova validade.
- `POST /api/v1/quotes/{id}/reject` recusa uma proposta.
- Mini-ERP: `/api/v1/me/plan`, `/financial`, `/clients`, `/stats`, `/promotions`,
  `/purchases`, `/team` e `/notifications`.
- O pagamento externo continua dependente de gateway aprovado e conta da loja.
- Máximo de 3 orçamentos abertos por solicitação.
- Limites mensais: Gratuito 20; Standard 40; Pro 100; Premium ilimitado.
