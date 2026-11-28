// Dados fiscais: coletar agora, emitir depois.
//
// A emissão é um estado DERIVADO, nunca um checkbox livre:
// - informal (CPF): não vê a opção de emitir; status 'desativada';
// - MEI/ME/salão que não quer emitir: 'desativada';
// - quer emitir mas falta dado: 'pendente', com a lista do que falta;
// - cadastro completo: 'ativa';
// - 'erro' fica para o emissor futuro (nota rejeitada).
// Erro ou falta de dado fiscal nunca bloqueia cobrança nem repasse.

const { isValidCnpj, isValidCpf } = require("../documents");

const onlyDigits = (value) => String(value ?? "").replace(/\D/g, "");
const isValidCep = (value) => /^\d{8}$/.test(onlyDigits(value));

const REGIMES = ["informal", "mei", "me", "salao"];

const FIELD_LABELS = {
  regime: "Regime (informal, MEI, ME ou salão)",
  cpf: "CPF",
  cnpj: "CNPJ",
  legal_name: "Razão social",
  municipal_registration: "Inscrição municipal",
  city_code: "Município",
  service_code: "Item de serviço (LC 116)",
  aliquota_iss_bps: "Alíquota de ISS",
};

// profile: linha de provider_fiscal_profiles (ou null) + hasCpf
function deriveFiscalStatus(profile) {
  if (!profile?.regime) {
    return { statusConfig: "pendente", missingFields: ["regime"], emissionOptionVisible: false, emiteNfse: false };
  }
  if (profile.regime === "informal") {
    return {
      statusConfig: "desativada",
      missingFields: profile.hasCpf ? [] : ["cpf"],
      emissionOptionVisible: false,
      emiteNfse: false,
    };
  }
  const missing = [];
  if (!profile.cnpj) missing.push("cnpj");
  if (!profile.legal_name) missing.push("legal_name");
  if (!profile.municipal_registration) missing.push("municipal_registration");
  if (!profile.city_code) missing.push("city_code");
  if (!profile.service_code) missing.push("service_code");
  // MEI recolhe o ISS fixo no DAS: a alíquota não se aplica
  if (profile.regime !== "mei" && profile.aliquota_iss_bps == null) missing.push("aliquota_iss_bps");
  if (!profile.emite_nfse) {
    return { statusConfig: "desativada", missingFields: missing, emissionOptionVisible: true, emiteNfse: false };
  }
  return {
    statusConfig: missing.length ? "pendente" : "ativa",
    missingFields: missing,
    emissionOptionVisible: true,
    emiteNfse: true,
  };
}

// O que falta na cliente para a nota (e para o checkout)
function customerMissingFields(customer) {
  const missing = [];
  if (!customer?.name) missing.push("name");
  if (!customer?.cpf_encrypted) missing.push("cpf");
  if (!customer?.email) missing.push("email");
  if (!customer?.address) missing.push("address");
  else {
    if (!customer.address.street) missing.push("street");
    if (!customer.address.number) missing.push("number");
    if (!customer.address.neighborhood) missing.push("neighborhood");
    if (!customer.address.city) missing.push("city");
    if (!customer.address.state) missing.push("state");
    if (!isValidCep(customer.address.postal_code)) missing.push("postal_code");
  }
  return missing;
}

// Cliente com o endereço de cobrança (ou o endereço mais recente com CEP)
async function loadCustomerFiscalData(client, customerId) {
  const { rows } = await client.query(
    `SELECT u.id, u.name, u.email, u.cpf_encrypted,
       to_jsonb(a.*) AS address
     FROM users u
     LEFT JOIN LATERAL (
       SELECT street, number, complement, neighborhood, city, state, postal_code
       FROM addresses
       WHERE user_id = u.id AND deleted_at IS NULL
       ORDER BY (id = u.billing_address_id) IS TRUE DESC, (postal_code IS NOT NULL) DESC, id
       LIMIT 1
     ) a ON true
     WHERE u.id = $1`,
    [customerId]
  );
  const row = rows[0] ?? null;
  if (row && row.address && Object.values(row.address).every((value) => value == null)) row.address = null;
  return row;
}

module.exports = {
  REGIMES,
  FIELD_LABELS,
  onlyDigits,
  isValidCep,
  isValidCpf,
  isValidCnpj,
  deriveFiscalStatus,
  customerMissingFields,
  loadCustomerFiscalData,
};
