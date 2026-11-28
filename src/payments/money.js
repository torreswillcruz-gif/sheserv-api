// Motor de cálculo do dinheiro do módulo de pagamentos.
//
// Regras:
// - todo valor é centavo inteiro (Number.isSafeInteger); nenhum float entra
//   ou sai daqui;
// - percentuais em pontos-base inteiros (400 = 4,00%);
// - a divisão é feita em BigInt e arredondada pelo modo da configuração:
//     half_up   meio centavo sobe (padrão): 4,5 → 5
//     half_even meio centavo vai para o par:  4,5 → 4; 5,5 → 6
//     floor     sempre para baixo
//     ceil      sempre para cima
//
// O arquivo não tem dependências: a admin-api usa uma cópia idêntica
// (admin-api/src/payments_math.js; um teste garante que as duas não divergem).

const ROUNDING_MODES = ["half_up", "half_even", "floor", "ceil"];
const BASIS_POINTS = 10000n;

class MoneyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function assertCents(value, name = "valor") {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new MoneyError("invalid_cents", `${name} precisa ser um inteiro de centavos >= 0 (recebido: ${value}).`);
  return value;
}

function assertBasisPoints(value, name = "percentual") {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000)
    throw new MoneyError("invalid_bps", `${name} precisa ser inteiro entre 0 e 10000 pontos-base.`);
  return value;
}

// numerador / denominador (inteiros >= 0, denominador > 0) com arredondamento
function divideRounded(numerator, denominator, mode) {
  if (!ROUNDING_MODES.includes(mode)) throw new MoneyError("invalid_rounding", `Modo de arredondamento inválido: ${mode}.`);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (mode === "floor") return quotient;
  if (mode === "ceil") return quotient + 1n;
  const twice = remainder * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  // exatamente meio centavo
  if (mode === "half_up") return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n; // half_even
}

// bps% de amountCents, arredondado
function percentOf(amountCents, basisPoints, mode) {
  assertCents(amountCents, "amountCents");
  assertBasisPoints(basisPoints, "basisPoints");
  return Number(divideRounded(BigInt(amountCents) * BigInt(basisPoints), BASIS_POINTS, mode));
}

// taxa = parte_fixa + arredonda(preco_prestadora * parte_percentual)
function computeFee(priceCents, settings) {
  assertCents(priceCents, "priceCents");
  return assertCents(settings.fee_fixed_cents, "fee_fixed_cents")
    + percentOf(priceCents, settings.fee_percent_bps, settings.rounding_mode);
}

// Quanto a cliente paga e quanto a prestadora recebe por um preço.
// fee_payer 'cliente': a taxa vai embutida no preço exibido (total = preço +
// taxa) e a prestadora recebe o preço inteiro. 'prestadora': a cliente paga o
// preço e a taxa sai da parte da prestadora.
function priceBreakdown(priceCents, settings) {
  const feeCents = computeFee(priceCents, settings);
  if (settings.fee_payer === "prestadora") {
    if (feeCents > priceCents)
      throw new MoneyError("fee_exceeds_price", "A taxa é maior que o preço: a prestadora receberia menos que zero.");
    return { priceCents, feeCents, totalCents: priceCents, providerAmountCents: priceCents - feeCents, feePayer: "prestadora" };
  }
  if (settings.fee_payer !== "cliente") throw new MoneyError("invalid_fee_payer", `fee_payer inválido: ${settings.fee_payer}.`);
  return { priceCents, feeCents, totalCents: priceCents + feeCents, providerAmountCents: priceCents, feePayer: "cliente" };
}

// Split em centavos absolutos. O desconto (ativação/camada) sai da parte da
// prestadora e vai para a plataforma; nunca passa do que ela tem a receber.
function buildSplit({ providerAmountCents, feeCents, deductionCents = 0 }) {
  assertCents(providerAmountCents, "providerAmountCents");
  assertCents(feeCents, "feeCents");
  assertCents(deductionCents, "deductionCents");
  if (deductionCents > providerAmountCents)
    throw new MoneyError("deduction_exceeds_share", "O desconto é maior que a parte da prestadora.");
  return {
    prestadora: providerAmountCents - deductionCents,
    plataforma: feeCents + deductionCents,
    total: providerAmountCents + feeCents,
  };
}

// Estorno de `refundCents` revertendo o split proporcionalmente. A parte da
// prestadora arredonda para baixo; o centavo que sobra sai da plataforma.
// Nunca reverte mais do que resta de cada lado.
function refundAllocation({ refundCents, totalCents, providerSplitCents, providerReversedCents = 0, platformReversedCents = 0 }) {
  assertCents(refundCents, "refundCents");
  assertCents(totalCents, "totalCents");
  assertCents(providerSplitCents, "providerSplitCents");
  const platformSplitCents = totalCents - providerSplitCents;
  const alreadyRefunded = providerReversedCents + platformReversedCents;
  if (refundCents === 0 || refundCents + alreadyRefunded > totalCents)
    throw new MoneyError("invalid_refund", "Valor de estorno inválido para o que resta da cobrança.");
  if (refundCents + alreadyRefunded === totalCents) {
    // estorno do restante: devolve exatamente o que falta de cada lado
    return {
      providerCents: providerSplitCents - providerReversedCents,
      platformCents: platformSplitCents - platformReversedCents,
    };
  }
  let providerCents = Number((BigInt(refundCents) * BigInt(providerSplitCents)) / BigInt(totalCents));
  providerCents = Math.min(providerCents, providerSplitCents - providerReversedCents);
  let platformCents = refundCents - providerCents;
  if (platformCents > platformSplitCents - platformReversedCents) {
    platformCents = platformSplitCents - platformReversedCents;
    providerCents = refundCents - platformCents;
  }
  return { providerCents, platformCents };
}

// Distribui descontos pendentes (na ordem recebida) sobre a parte da
// prestadora numa cobrança. Cada desconto: { id, remainingCents, capCents }
// (capCents = quanto ainda cabe na janela de repasse; null = sem teto).
function allocateDeductions(availableCents, deductions) {
  assertCents(availableCents, "availableCents");
  let left = availableCents;
  const allocations = [];
  for (const deduction of deductions) {
    if (left === 0) break;
    const limit = deduction.capCents == null ? deduction.remainingCents : Math.min(deduction.remainingCents, deduction.capCents);
    const amountCents = Math.min(left, Math.max(0, limit));
    if (amountCents > 0) {
      allocations.push({ id: deduction.id, amountCents });
      left -= amountCents;
    }
  }
  return allocations;
}

// Parcela da ativação por janela de repasse (arredonda para cima, para
// quitar em no máximo N repasses)
function installmentCap(amountCents, installments) {
  assertCents(amountCents, "amountCents");
  if (!Number.isSafeInteger(installments) || installments < 1) throw new MoneyError("invalid_installments", "Parcelas inválidas.");
  return Number(divideRounded(BigInt(amountCents), BigInt(installments), "ceil"));
}

// Custo estimado do gateway sobre o total cobrado (para a margem)
function gatewayCost(totalCents, method, settings) {
  const fixed = method === "pix" ? settings.gateway_cost_pix_fixed_cents : settings.gateway_cost_card_fixed_cents;
  const bps = method === "pix" ? settings.gateway_cost_pix_bps : settings.gateway_cost_card_bps;
  return fixed + percentOf(totalCents, bps, "ceil");
}

// O que a cliente pagaria avulso pelas sessões, pelo preço cadastrado de cada
// serviço (cada sessão avulsa é uma cobrança, com a própria taxa).
function avulsoCustomerTotal(items, settings) {
  return items.reduce((sum, item) => {
    assertCents(item.unitPriceCents, "unitPriceCents");
    return sum + priceBreakdown(item.unitPriceCents, settings).totalCents * item.sessions;
  }, 0);
}

// Impacto de um preço de plano: cliente, prestadora, gateway (cartão: a
// assinatura é só no cartão), margem e diferença para o avulso.
function planImpact(priceCents, settings, avulsoItems) {
  const breakdown = priceBreakdown(priceCents, settings);
  const cost = gatewayCost(breakdown.totalCents, "cartao", settings);
  const avulsoCents = avulsoItems ? avulsoCustomerTotal(avulsoItems, settings) : null;
  return {
    priceCents,
    customerPaysCents: breakdown.totalCents,
    providerReceivesCents: breakdown.providerAmountCents,
    feeCents: breakdown.feeCents,
    gatewayCostCents: cost,
    marginCents: breakdown.feeCents - cost,
    avulsoCents,
    savingsCents: avulsoCents == null ? null : avulsoCents - breakdown.totalCents,
  };
}

module.exports = {
  ROUNDING_MODES,
  MoneyError,
  assertCents,
  divideRounded,
  percentOf,
  computeFee,
  priceBreakdown,
  buildSplit,
  refundAllocation,
  allocateDeductions,
  installmentCap,
  gatewayCost,
  avulsoCustomerTotal,
  planImpact,
};
