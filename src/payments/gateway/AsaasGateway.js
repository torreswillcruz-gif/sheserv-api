// Stub do Asaas: nenhuma chamada de rede. Existe para provar que a interface
// aguenta um PSP que inverte o sentido da cobrança, e para documentar o que
// muda quando (e se) ele for implementado.
//
// Diferenças do Asaas em relação ao Pagar.me (e onde o código já aguenta):
// - a cobrança nasce na SUBCONTA da prestadora, não na conta da plataforma:
//   capabilities().titularDaCobranca = 'recebedor', e charges.charge_owner
//   grava isso por cobrança;
// - cada subconta tem a própria API key. Ela fica DENTRO deste adapter (num
//   cofre, indexada pelo recipientId); o domínio continua só com recipientId;
// - o split sai da subconta para a plataforma (walletId da SheServe), em
//   valor fixo (fixedValue), que é o que o domínio já manda: centavos absolutos;
// - webhooks (PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_REFUNDED...) têm
//   outro formato; parseWebhook converte para o mesmo enum e o domínio não muda;
// - a criação da subconta devolve apiKey e walletId: guardar no cofre, nunca
//   em provider_payment_accounts;
// - tokens de cartão do Pagar.me não servem no Asaas: numa migração, as
//   clientes recadastram o cartão (não abstraímos tokenização de propósito).
//
// Mapeamento previsto:
//   createRecipient            POST /v3/accounts (subconta) + guardar apiKey
//   getRecipientStatus         GET  /v3/myAccount/status (com a apiKey da subconta)
//   createSubscription         POST /v3/subscriptions (split: [{ walletId, fixedValue }])
//   updateSubscriptionAmount   PUT  /v3/subscriptions/{id}
//   cancelSubscription         DELETE /v3/subscriptions/{id}
//   createCharge               POST /v3/payments
//   refund                     POST /v3/payments/{id}/refund
//   parseWebhook               conferir o header asaas-access-token

const { PaymentGateway, NotImplementedGatewayError } = require("./PaymentGateway");

class AsaasGateway extends PaymentGateway {
  get nome() { return "asaas"; }

  capabilities() {
    return {
      emiteNfse: true, // o Asaas emite NFS-e, mas a emissão está fora do escopo
      temEscrow: false,
      temAntecipacao: true,
      titularDaCobranca: "recebedor",
      intervalosDeRepasse: [],
    };
  }

  async createRecipient() { throw new NotImplementedGatewayError(this.nome, "createRecipient"); }
  async getRecipientStatus() { throw new NotImplementedGatewayError(this.nome, "getRecipientStatus"); }
  async updateRecipientPayoutSchedule() { throw new NotImplementedGatewayError(this.nome, "updateRecipientPayoutSchedule"); }
  async createSubscription() { throw new NotImplementedGatewayError(this.nome, "createSubscription"); }
  async updateSubscriptionAmount() { throw new NotImplementedGatewayError(this.nome, "updateSubscriptionAmount"); }
  async cancelSubscription() { throw new NotImplementedGatewayError(this.nome, "cancelSubscription"); }
  async createCharge() { throw new NotImplementedGatewayError(this.nome, "createCharge"); }
  async refund() { throw new NotImplementedGatewayError(this.nome, "refund"); }
  parseWebhook() { throw new NotImplementedGatewayError(this.nome, "parseWebhook"); }
}

module.exports = { AsaasGateway };
