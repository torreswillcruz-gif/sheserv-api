# Marketplace API

## Rodar localmente
    cp .env.example .env   # preencha os valores
    npm install
    export $(cat .env | xargs) && npm run dev

## Deploy no Render
1. Suba para o GitHub.
2. Render > New + > Blueprint > selecione o repositório (usa o render.yaml, cria API + Postgres).
3. As tabelas são criadas automaticamente na primeira inicialização.

## Pendências (marcadas como TODO no código)
- Gateway de pagamento (Pix/cartão)
- Provedor de OTP (SMS)
- Provedor de verificação de identidade + upload com URL assinada
- Notificação de SOS
- Filtro por distância (falta área de atendimento no ERD)
- Ativação de prestadoras (activation_status) é feita pelo backoffice
