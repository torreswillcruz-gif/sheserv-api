# Pagamentos: como trocar o mock pelo gateway real

Hoje o módulo roda inteiro sobre o `MockGateway` (`PAYMENT_GATEWAY=mock`). O
domínio (taxa, split, assinatura, direitos, repasses, dados da nota) não sabe
qual PSP está por trás: ele só fala com a interface `PaymentGateway`
(`gateway/PaymentGateway.js`) e só conhece `recipientId` e os eventos
normalizados do webhook. Trocar o mock pelo Pagar.me é escrever **uma classe**.

## Passo a passo (Pagar.me)

1. **Criar `gateway/PagarmeGateway.js`** estendendo `PaymentGateway`, com os
   mesmos métodos do `MockGateway`. A credencial (chave secreta da conta da
   plataforma) fica só nesta classe, lida de `PAGARME_SECRET_KEY`. Uma
   credencial só: as prestadoras são recebedores, sem conta nem login.
2. **Registrar a classe** em `gateway/index.js` (`case "pagarme"`) e acrescentar
   `"pagarme"` em `SUPPORTED_GATEWAYS`.
3. **Variáveis no Render** (as duas APIs): `PAYMENT_GATEWAY=pagarme` e
   `PAGARME_SECRET_KEY` na `marketplace-api`. O admin mostra o gateway
   ativo, mas não troca: quem manda é a variável.
4. **Webhook**: cadastrar no painel do Pagar.me a URL
   `https://<api>/webhooks/payments` com os eventos de cobrança e de recebedor.
   `parseWebhook` confere a autenticidade e converte para o nosso enum.
5. **App**: o cartão passa a ser tokenizado direto no Pagar.me (SDK ou
   checkout deles) e o app manda só o token. Tokenização não é abstraída de
   propósito: tokens não são portáveis entre PSPs.
6. Rodar `npm test` e o teste de ponta a ponta (`test/payments_e2e.test.js`)
   contra um banco descartável, com o adapter novo em modo de teste.

## Mapeamento previsto (API v5)

Confirme cada item na documentação oficial antes de implementar: estes
pontos não foram testados contra a API real.

| Interface | Pagar.me | Observação |
|---|---|---|
| `createRecipient` | `POST /core/v5/recipients` | Conta bancária padrão + `transfer_settings`. Pessoa física pede dados de KYC (nascimento, renda, ocupação, endereço) que o mock não exige: acrescentar ao formulário |
| `getRecipientStatus` | `GET /core/v5/recipients/{id}` | |
| `updateRecipientPayoutSchedule` | `PATCH /core/v5/recipients/{id}/transfer-settings` | Até onde sei, aceita `Daily`, `Weekly` e `Monthly`. O app usa semanal (padrão) e mensal |
| `createKycLink` | `POST /core/v5/recipients/{id}/kyc_link` | Link da prova de vida (selfie + documento) que a prestadora abre no celular. O resultado vira `RECIPIENT_KYC_APPROVED`/`RECIPIENT_KYC_REJECTED` no `parseWebhook` (confirmar o nome do evento de KYC na documentação) |
| `saveCard` | `POST /core/v5/customers` (uma vez) e `POST /core/v5/customers/{id}/cards` com `token` | O app tokeniza com a chave pública (`POST /core/v5/tokens?appId=`), num `CardTokenizer` novo no lugar do `DemoCardTokenizer`. Cobrança e assinatura com cartão salvo usam `card_id` (`metodoPagamento.cartaoId`) |
| `deleteCard` | `DELETE /core/v5/customers/{id}/cards/{card_id}` | |
| `createCharge` | `POST /core/v5/orders` | Split com `type: "flat"` (centavos absolutos) por recebedor; a taxa do gateway fica com a plataforma (`charge_processing_fee`) |
| `createSubscription` | `POST /core/v5/subscriptions` | Confirmar se a assinatura aceita split. Se não aceitar, o ciclo pode ser cobrado por `createCharge` com o cartão salvo, e o domínio não muda |
| `updateSubscriptionAmount` | atualização de itens/valor da assinatura | Usado na repactuação e quando o desconto de repasse muda o split do ciclo |
| `cancelSubscription` | `DELETE /core/v5/subscriptions/{id}` | |
| `refund` | `DELETE /core/v5/charges/{id}` com `amount` | Estorno parcial ou total, revertendo o split |
| `parseWebhook` | `charge.paid` → `PAYMENT_CONFIRMED`, `charge.payment_failed` → `PAYMENT_FAILED`, `charge.refunded` → `PAYMENT_REFUNDED`, status do recebedor → `RECIPIENT_APPROVED`/`RECIPIENT_REJECTED` | Na dúvida, consultar a cobrança pela API antes de confiar no corpo |

## O que já está pronto para a troca

- Split sempre em centavos absolutos (`charge_splits`), nunca percentual.
- Titular da cobrança gravado por cobrança (`charges.charge_owner`), vindo de
  `capabilities().titularDaCobranca`. O Asaas inverte o sentido
  (`AsaasGateway.js`, stub documentado).
- Colunas `gateway`, `gateway_recipient_id`, `gateway_charge_id` e
  `gateway_subscription_id` separadas: numa migração, os dois PSPs coexistem.
- Webhooks guardados brutos (`payment_webhook_events.raw_payload`) e
  normalizados para o enum próprio; repetidos são descartados.
- Toda operação de cobrança é idempotente: `Idempotency-Key` obrigatória do
  app, e chaves determinísticas nas chamadas ao gateway.

## Diferenças que o mock não simula

- Liquidação real (cartão costuma ser D+30 sem antecipação): ajuste
  `settlement_days_card` e `settlement_days_pix` no admin ao contrato.
- Custos reais do gateway (`gateway_cost_*` no admin), que entram na margem.
- Confirmação de repasse: no mock, o repasse "sai" na data prevista
  (`maintenance.js`). No PSP real, use os eventos de transferência dele.
- Endpoints `/dev/payments/*` só existem com `NODE_ENV != production` e
  gateway mock.
