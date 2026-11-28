// Escolha do gateway pela variável de ambiente PAYMENT_GATEWAY (padrão:
// mock). Só a variável decide: trocar de PSP com recebedores criados no outro
// quebraria as cobranças em curso, então o admin apenas mostra qual está ativo.
//
// Para ligar o Pagar.me: implementar PagarmeGateway (ver README de
// pagamentos) e acrescentar o case abaixo. Nada mais muda no domínio.

const { MockGateway } = require("./MockGateway");
const { AsaasGateway } = require("./AsaasGateway");

const SUPPORTED_GATEWAYS = ["mock", "asaas"];

let activeGateway = null;

const configuredGatewayName = () => (process.env.PAYMENT_GATEWAY || "mock").trim().toLowerCase();

function createGateway(name, dependencies) {
  switch (name) {
    case "mock":
      return new MockGateway(dependencies);
    case "asaas":
      return new AsaasGateway();
    default:
      throw new Error(`PAYMENT_GATEWAY desconhecido: "${name}". Use um de: ${SUPPORTED_GATEWAYS.join(", ")}.`);
  }
}

// dependencies: { query, loadBehavior } (ver MockGateway)
function getGateway(dependencies) {
  if (!activeGateway) activeGateway = createGateway(configuredGatewayName(), dependencies);
  return activeGateway;
}

// Testes trocam o gateway (ex.: mock com entrega de webhook direta)
function setGatewayForTests(gateway) {
  activeGateway = gateway;
}

const isDemoMode = () => configuredGatewayName() === "mock";

module.exports = { SUPPORTED_GATEWAYS, configuredGatewayName, createGateway, getGateway, setGatewayForTests, isDemoMode };
