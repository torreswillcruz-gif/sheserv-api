const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");
const { isValidCnpj, isValidCpf } = require("../src/routes/business");
const { decryptText } = require("../src/security");

const PROVIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVOICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const QUOTE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };
const customer = { userId: PROVIDER_ID, roles: ["cliente"] };
const enabled = (...features) => ({
  pattern: /AS enabled FROM plan_catalog/,
  rows: (params) => [{ enabled: features.includes(params[1]) }],
});

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

describe("documents", () => {
  test("CNPJ: numeric and the new alphanumeric format", () => {
    assert.equal(isValidCnpj("11.222.333/0001-81"), true);
    assert.equal(isValidCnpj("11.222.333/0001-82"), false);
    assert.equal(isValidCnpj("12.ABC.345/01DE-35"), true);
    assert.equal(isValidCnpj("00.000.000/0000-00"), false);
  });

  test("CPF", () => {
    assert.equal(isValidCpf("529.982.247-25"), true);
    assert.equal(isValidCpf("529.982.247-24"), false);
    assert.equal(isValidCpf("111.111.111-11"), false);
  });
});

describe("branding", () => {
  test("saves the brand, cleaning @ and phone formatting", async () => {
    resetDatabase([
      enabled("branding"),
      { pattern: /^INSERT INTO provider_branding/, rows: (params) => [{ brandName: params[1] }] },
    ]);
    const response = await server.call("PUT", "/api/v1/me/branding", { ...provider, body: {
      brandName: "Studio Ana Unhas", tagline: "Unhas com carinho", instagram: "@studio.ana",
      whatsapp: "(11) 99999-1234", website: "https://studioana.com.br",
    } });
    assert.equal(response.status, 200);
    assert.deepEqual(
      queriesMatching(/^INSERT INTO provider_branding/)[0].params,
      [PROVIDER_ID, "Studio Ana Unhas", "Unhas com carinho", "studio.ana", "11999991234", "https://studioana.com.br"],
    );
  });

  test("empty brand comes back with nulls", async () => {
    resetDatabase([enabled("branding")]);
    const response = await server.call("GET", "/api/v1/me/branding", provider);
    assert.equal(response.body.brandName, null);
  });

  test("needs the branding feature (Pro and up) and a provider", async () => {
    resetDatabase([enabled("finance")]);
    assert.equal((await server.call("GET", "/api/v1/me/branding", provider)).status, 403);
    resetDatabase([enabled("branding")]);
    assert.equal((await server.call("GET", "/api/v1/me/branding", customer)).status, 403);
  });

  test("the catalog shows the brand only while the plan has it, and searches by it", async () => {
    resetDatabase([]);
    await server.call("GET", "/api/v1/providers?query=studio");
    const [query] = queriesMatching(/FROM provider_profiles provider_profile/);
    assert.match(query.sql, /provider_brand\.brand_name AS "brandName"/);
    assert.match(query.sql, /->>'branding'/);
    // a exceção do admin para a prestadora vale por cima do plano
    assert.match(query.sql, /brand_plan\.features \|\| COALESCE\( \(SELECT overrides FROM provider_feature_overrides/);
    assert.match(query.sql, /OR provider_brand\.brand_name ILIKE/);
  });
});

describe("fiscal profile and invoices", () => {
  const fiscal = {
    cnpj: "11.222.333/0001-81", legalName: "Ana Souza 12345678900", taxRegime: "mei",
    cityCode: "3550308", serviceCode: "06.01.01", issRate: 2,
  };

  test("saves the fiscal profile with the CNPJ without punctuation", async () => {
    resetDatabase([
      enabled("invoices"),
      { pattern: /^INSERT INTO provider_fiscal_profiles/, rows: [{ cnpj: "11222333000181" }] },
    ]);
    const response = await server.call("PUT", "/api/v1/me/fiscal", { ...provider, body: fiscal });
    assert.equal(response.status, 200);
    assert.deepEqual(
      queriesMatching(/^INSERT INTO provider_fiscal_profiles/)[0].params.slice(1, 4),
      ["11222333000181", "Ana Souza 12345678900", "mei"],
    );
  });

  test("refuses an invalid CNPJ or city code", async () => {
    resetDatabase([enabled("invoices")]);
    const badCnpj = await server.call("PUT", "/api/v1/me/fiscal", { ...provider, body: { ...fiscal, cnpj: "11222333000182" } });
    assert.equal(badCnpj.status, 422);
    const badCity = await server.call("PUT", "/api/v1/me/fiscal", { ...provider, body: { ...fiscal, cityCode: "355" } });
    assert.equal(badCity.status, 422);
  });

  const invoice = {
    customerName: "Maria Lima", customerDocument: "529.982.247-25", customerEmail: "maria@example.com",
    description: "Manicure e pedicure", amount: 120, serviceDate: "2026-11-20",
  };

  test("an invoice needs the fiscal profile first", async () => {
    resetDatabase([enabled("invoices")]);
    const response = await server.call("POST", "/api/v1/me/invoices", { ...provider, body: invoice });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "fiscal_profile_required");
  });

  test("creates a draft with the customer document encrypted and masked back", async () => {
    resetDatabase([
      enabled("invoices"),
      { pattern: /^SELECT 1 FROM provider_fiscal_profiles/, rows: [{ "?column?": 1 }] },
      { pattern: /^INSERT INTO service_invoices/, rows: (params) => [{
        id: INVOICE_ID, customerName: params[2], customerDocumentEncrypted: params[3], status: "draft",
      }] },
    ]);
    const response = await server.call("POST", "/api/v1/me/invoices", { ...provider, body: invoice });
    assert.equal(response.status, 201);
    assert.equal(response.body.status, "draft");
    assert.equal(response.body.customerDocument, "***.982.247-**");
    assert.equal(response.body.customerDocumentEncrypted, undefined);
    const stored = queriesMatching(/^INSERT INTO service_invoices/)[0].params[3];
    assert.notEqual(stored, "52998224725");
    assert.equal(decryptText(stored), "52998224725");
  });

  test("an invoice from an order needs a completed order of this provider", async () => {
    resetDatabase([
      enabled("invoices"),
      { pattern: /^SELECT 1 FROM provider_fiscal_profiles/, rows: [{ "?column?": 1 }] },
    ]);
    const response = await server.call("POST", "/api/v1/me/invoices", { ...provider, body: { ...invoice, orderId: ORDER_ID } });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "order_not_completed");
  });

  test("refuses an invalid customer document", async () => {
    resetDatabase([enabled("invoices")]);
    const response = await server.call("POST", "/api/v1/me/invoices", { ...provider, body: { ...invoice, customerDocument: "123" } });
    assert.equal(response.status, 422);
  });

  test("only drafts can be deleted", async () => {
    resetDatabase([enabled("invoices"), { pattern: /^SELECT status FROM service_invoices/, rows: [{ status: "issued" }] }]);
    const issued = await server.call("DELETE", `/api/v1/me/invoices/${INVOICE_ID}`, provider);
    assert.equal(issued.status, 409);
    assert.equal(queriesMatching(/^DELETE FROM service_invoices/).length, 0);

    resetDatabase([enabled("invoices"), { pattern: /^SELECT status FROM service_invoices/, rows: [{ status: "draft" }] }]);
    assert.equal((await server.call("DELETE", `/api/v1/me/invoices/${INVOICE_ID}`, provider)).status, 204);
  });
});

describe("custom quotes", () => {
  const quote = {
    customerName: "Joana", customerContact: "(11) 98888-0000",
    items: [{ description: "Escova", quantity: 1, unitPrice: 80 }, { description: "Hidratação", quantity: 2, unitPrice: 50 }],
    discount: 20, validUntil: "2026-12-10", notes: "Pagamento no Pix",
  };

  test("creates the next number for the provider, locking the numbering", async () => {
    resetDatabase([
      enabled("custom_quotes"),
      { pattern: /coalesce\(max\(number\),0\)\+1/, rows: [{ next: 7 }] },
      { pattern: /^INSERT INTO custom_quotes/, rows: (params) => [{ id: QUOTE_ID, number: params[1] }] },
    ]);
    const response = await server.call("POST", "/api/v1/me/custom-quotes", { ...provider, body: quote });
    assert.equal(response.status, 201);
    assert.equal(response.body.number, 7);
    assert.equal(queriesMatching(/pg_advisory_xact_lock/).length, 1);
    const insert = queriesMatching(/^INSERT INTO custom_quotes/)[0];
    assert.equal(JSON.parse(insert.params[4]).length, 2);
    assert.equal(insert.params[8], "draft");
  });

  test("a discount larger than the total is refused", async () => {
    resetDatabase([enabled("custom_quotes")]);
    const response = await server.call("POST", "/api/v1/me/custom-quotes", { ...provider, body: { ...quote, discount: 500 } });
    assert.equal(response.status, 422);
  });

  test("updates the status and answers 404 for another provider's quote", async () => {
    resetDatabase([enabled("custom_quotes"), { pattern: /^UPDATE custom_quotes/, rows: [{ id: QUOTE_ID, status: "sent" }] }]);
    const sent = await server.call("PUT", `/api/v1/me/custom-quotes/${QUOTE_ID}`, { ...provider, body: { ...quote, status: "sent" } });
    assert.equal(sent.body.status, "sent");
    resetDatabase([enabled("custom_quotes")]);
    assert.equal((await server.call("DELETE", `/api/v1/me/custom-quotes/${QUOTE_ID}`, provider)).status, 404);
  });

  test("needs the custom_quotes feature", async () => {
    resetDatabase([enabled("finance")]);
    assert.equal((await server.call("GET", "/api/v1/me/custom-quotes", provider)).status, 403);
  });
});
