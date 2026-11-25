const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

// Serviço oculto pelo painel admin: fora da busca e sem agendamento novo.
const SERVICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const customer = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", roles: ["cliente"] };

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

test("a busca do catálogo ignora serviços ocultos pelo admin", async () => {
  resetDatabase([]);
  await server.call("GET", "/api/v1/providers?query=manicure&categoryId=beleza&serviceLocation=at_provider");
  const [query] = queriesMatching(/FROM provider_profiles provider_profile/);
  for (const alias of ["listed_service", "matching_service", "category_service", "location_service", "venue_service"]) {
    assert.match(query.sql, new RegExp(`${alias}\.active AND NOT ${alias}\.hidden_by_admin`), alias);
  }
});

test("serviço oculto não mostra horários livres", async () => {
  resetDatabase([]);
  const date = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const response = await server.call("GET", `/api/v1/services/${SERVICE_ID}/slots?date=${date}`, customer);
  assert.equal(response.status, 404);
  const [query] = queriesMatching(/FROM services service/);
  assert.match(query.sql, /service\.active AND NOT service\.hidden_by_admin/);
});

test("a prestadora vê se o serviço foi ocultado e o motivo", async () => {
  resetDatabase([]);
  await server.call("GET", "/api/v1/provider/me/services", { userId: customer.userId, roles: ["prestadora"] });
  const [query] = queriesMatching(/FROM services WHERE provider_id=\$1 AND active ORDER BY title/);
  assert.match(query.sql, /hidden_by_admin AS "hiddenByAdmin"/);
  assert.match(query.sql, /hidden_reason AS "hiddenReason"/);
});
