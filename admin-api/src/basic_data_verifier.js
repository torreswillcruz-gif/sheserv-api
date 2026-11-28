// Conferência dos dados básicos da prestadora (selo "Dados básicos
// verificados"), escolhida por variável de ambiente:
//
//   BASIC_DATA_VERIFIER=manual           (padrão) o admin consulta o CPF na Serpro
//                                        e marca no painel o que conferiu
//   BASIC_DATA_VERIFIER=serpro_datavalid integração com a API Datavalid da Serpro
//                                        (exige contrato e credenciais; ainda não feita)
//
// Para ligar a Datavalid: implemente check() em SerproDatavalidVerifier (POST
// /validate/pf com CPF, nome e data de nascimento; credenciais em
// SERPRO_CONSUMER_KEY/SERPRO_CONSUMER_SECRET) e chame-o na aprovação para
// pré-preencher o checklist. O painel e o banco não mudam.

class ManualBasicDataVerifier {
  get source() { return "serpro_manual"; }
  get automatic() { return false; }
  async check() { return null; } // o admin confere e marca no painel
}

class SerproDatavalidVerifier {
  get source() { return "serpro_datavalid"; }
  get automatic() { return true; }
  async check() {
    throw new Error("Integração Datavalid ainda não implementada. Use BASIC_DATA_VERIFIER=manual.");
  }
}

function basicDataVerifier() {
  const name = (process.env.BASIC_DATA_VERIFIER || "manual").trim().toLowerCase();
  return name === "serpro_datavalid" ? new SerproDatavalidVerifier() : new ManualBasicDataVerifier();
}

const basicDataSource = () => basicDataVerifier().source;

module.exports = { basicDataVerifier, basicDataSource, ManualBasicDataVerifier, SerproDatavalidVerifier };
