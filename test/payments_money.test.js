const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");
const money = require("../src/payments/money");

const DEFAULTS = {
  fee_fixed_cents: 99,
  fee_percent_bps: 400,
  fee_payer: "cliente",
  rounding_mode: "half_up",
  gateway_cost_card_fixed_cents: 0,
  gateway_cost_card_bps: 399,
  gateway_cost_pix_fixed_cents: 0,
  gateway_cost_pix_bps: 119,
};
const withSettings = (changes) => ({ ...DEFAULTS, ...changes });

describe("taxa da SheServe", () => {
  test("caso de referência: 3000 → taxa 219 → cliente paga 3219 → prestadora recebe 3000", () => {
    assert.equal(money.computeFee(3000, DEFAULTS), 219);
    assert.deepEqual(money.priceBreakdown(3000, DEFAULTS), {
      priceCents: 3000, feeCents: 219, totalCents: 3219, providerAmountCents: 3000, feePayer: "cliente",
    });
  });

  test("a parte percentual arredonda meio centavo para cima por padrão", () => {
    // 2999 × 4% = 119,96 → 120
    assert.equal(money.computeFee(2999, DEFAULTS), 99 + 120);
    // 1238 × 4% = 49,52 → 50
    assert.equal(money.computeFee(1238, DEFAULTS), 99 + 50);
    // 1237 × 4% = 49,48 → 49
    assert.equal(money.computeFee(1237, DEFAULTS), 99 + 49);
  });

  test("modos de arredondamento no empate exato (4,5% de 100 = 4,5 centavos)", () => {
    const fee = (mode) => money.computeFee(100, withSettings({ fee_fixed_cents: 0, fee_percent_bps: 450, rounding_mode: mode }));
    assert.equal(fee("half_up"), 5);
    assert.equal(fee("half_even"), 4);
    assert.equal(fee("floor"), 4);
    assert.equal(fee("ceil"), 5);
    // 4,5% de 300 = 13,5: half_even vai para o par (14)
    assert.equal(money.computeFee(300, withSettings({ fee_fixed_cents: 0, fee_percent_bps: 450, rounding_mode: "half_even" })), 14);
  });

  test("fora do empate, half_up e half_even concordam", () => {
    for (const price of [1, 7, 99, 1234, 99999, 1000000]) {
      const up = money.computeFee(price, withSettings({ rounding_mode: "half_up" }));
      const even = money.computeFee(price, withSettings({ rounding_mode: "half_even" }));
      assert.equal(up, even, `preço ${price}`);
    }
  });

  test("taxa paga pela prestadora sai da parte dela e a cliente paga o preço", () => {
    assert.deepEqual(money.priceBreakdown(3000, withSettings({ fee_payer: "prestadora" })), {
      priceCents: 3000, feeCents: 219, totalCents: 3000, providerAmountCents: 2781, feePayer: "prestadora",
    });
  });

  test("taxa maior que o preço com a prestadora pagando é recusada", () => {
    assert.throws(() => money.priceBreakdown(50, withSettings({ fee_payer: "prestadora" })), { code: "fee_exceeds_price" });
  });

  test("nenhum float entra no cálculo", () => {
    assert.throws(() => money.computeFee(30.5, DEFAULTS), { code: "invalid_cents" });
    assert.throws(() => money.computeFee(-1, DEFAULTS), { code: "invalid_cents" });
    assert.throws(() => money.computeFee(3000, withSettings({ fee_percent_bps: 4.5 })), { code: "invalid_bps" });
    assert.throws(() => money.computeFee(3000, withSettings({ rounding_mode: "round" })), { code: "invalid_rounding" });
  });

  test("valores grandes não perdem precisão", () => {
    assert.equal(money.percentOf(Number.MAX_SAFE_INTEGER, 400, "floor"), Number((BigInt(Number.MAX_SAFE_INTEGER) * 400n) / 10000n));
  });
});

describe("split e descontos", () => {
  test("split em centavos absolutos soma o total", () => {
    assert.deepEqual(money.buildSplit({ providerAmountCents: 3000, feeCents: 219 }), { prestadora: 3000, plataforma: 219, total: 3219 });
  });

  test("desconto de repasse sai da parte da prestadora para a plataforma", () => {
    assert.deepEqual(
      money.buildSplit({ providerAmountCents: 3000, feeCents: 219, deductionCents: 500 }),
      { prestadora: 2500, plataforma: 719, total: 3219 }
    );
    assert.throws(() => money.buildSplit({ providerAmountCents: 3000, feeCents: 219, deductionCents: 3001 }), { code: "deduction_exceeds_share" });
  });

  test("descontos respeitam o saldo, o teto da janela e o que a prestadora tem a receber", () => {
    assert.deepEqual(
      money.allocateDeductions(3000, [
        { id: "ativacao", remainingCents: 5000, capCents: 1250 },
        { id: "camada", remainingCents: 2990, capCents: null },
      ]),
      [{ id: "ativacao", amountCents: 1250 }, { id: "camada", amountCents: 1750 }]
    );
    assert.deepEqual(money.allocateDeductions(0, [{ id: "x", remainingCents: 10, capCents: null }]), []);
    assert.deepEqual(money.allocateDeductions(100, [{ id: "x", remainingCents: 10, capCents: 0 }]), []);
  });

  test("parcela da ativação arredonda para cima (quita em no máximo N repasses)", () => {
    assert.equal(money.installmentCap(1000, 3), 334);
    assert.equal(money.installmentCap(900, 3), 300);
  });
});

describe("estorno revertendo o split", () => {
  test("estorno total devolve tudo, inclusive a taxa da SheServe", () => {
    assert.deepEqual(money.refundAllocation({ refundCents: 3219, totalCents: 3219, providerSplitCents: 3000 }), { providerCents: 3000, platformCents: 219 });
  });

  test("estorno parcial é proporcional e o centavo do arredondamento sai da plataforma", () => {
    // 1000 × 3000 / 3219 = 931,96 → prestadora 931, plataforma 69
    assert.deepEqual(money.refundAllocation({ refundCents: 1000, totalCents: 3219, providerSplitCents: 3000 }), { providerCents: 931, platformCents: 69 });
  });

  test("estorno do restante fecha exatamente os dois lados", () => {
    assert.deepEqual(
      money.refundAllocation({ refundCents: 2219, totalCents: 3219, providerSplitCents: 3000, providerReversedCents: 931, platformReversedCents: 69 }),
      { providerCents: 2069, platformCents: 150 }
    );
  });

  test("não estorna mais do que resta", () => {
    assert.throws(() => money.refundAllocation({ refundCents: 3220, totalCents: 3219, providerSplitCents: 3000 }), { code: "invalid_refund" });
    assert.throws(() => money.refundAllocation({ refundCents: 0, totalCents: 3219, providerSplitCents: 3000 }), { code: "invalid_refund" });
  });
});

describe("impacto e avulso", () => {
  test("avulso usa o preço cadastrado e cada sessão paga a própria taxa", () => {
    // 4 × (2000 + 99 + 80) = 8716
    assert.equal(money.avulsoCustomerTotal([{ unitPriceCents: 2000, sessions: 4 }], DEFAULTS), 8716);
  });

  test("impacto do plano: cliente, prestadora, gateway, margem e economia", () => {
    const impact = money.planImpact(8000, DEFAULTS, [{ unitPriceCents: 2000, sessions: 4 }]);
    assert.deepEqual(impact, {
      priceCents: 8000,
      customerPaysCents: 8419, // 8000 + 99 + 320
      providerReceivesCents: 8000,
      feeCents: 419,
      gatewayCostCents: 336, // 8419 × 3,99% = 335,9 → 336
      marginCents: 83,
      avulsoCents: 8716,
      savingsCents: 297,
    });
  });
});

describe("cópia na admin-api", () => {
  test("admin-api/src/payments_math.js é idêntico a src/payments/money.js", () => {
    const original = fs.readFileSync(path.join(__dirname, "../src/payments/money.js"), "utf8");
    const copy = fs.readFileSync(path.join(__dirname, "../admin-api/src/payments_math.js"), "utf8");
    assert.equal(copy, original, "Copie src/payments/money.js para admin-api/src/payments_math.js");
  });
});
