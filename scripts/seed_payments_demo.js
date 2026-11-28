// Seed de demonstração do módulo de pagamentos.
//
//   npm run seed:demo            cria os dados (falha se já existirem)
//   npm run seed:demo -- --reset apaga só os dados de demonstração e recria
//
// Cria 3 prestadoras (uma Free no limite de assinantes, uma Standard, uma
// Pro), 10 clientes, assinaturas ativas, em retentativa e canceladas, e 3
// meses de cobranças (assinatura e avulso), com repasses, dados de nota e o
// override de Alfenas (taxa de 3,5%) para comparar com Guaxupé.
// Tudo calculado pelo próprio motor do módulo: os números batem com a API.
// Senha de todas as contas: demo1234. E-mails em @demo.sheserve.app.
//
// Só roda com PAYMENT_GATEWAY=mock (padrão). Precisa de DATABASE_URL e
// DATA_ENCRYPTION_KEY (a mesma da API, para os documentos cifrados abrirem).

const crypto = require("crypto");
const argon2 = require("argon2");

if ((process.env.PAYMENT_GATEWAY || "mock") !== "mock") {
  console.error("O seed de demonstração só roda com PAYMENT_GATEWAY=mock.");
  process.exit(1);
}
for (const name of ["DATABASE_URL", "DATA_ENCRYPTION_KEY"]) {
  if (!process.env[name]) {
    console.error(`Defina ${name}.`);
    process.exit(1);
  }
}

const db = require("../src/db");
const { encryptText } = require("../src/security");
const { priceBreakdown, buildSplit } = require("../src/payments/money");
const { cyclePeriod, brasiliaDateKey, DAY_MS } = require("../src/payments/dates");
const { loadEffectiveSettings, snapshotOf, settingsVersion } = require("../src/payments/settings");
const { recordPaidCharge } = require("../src/payments/ledger");
const { cpfHash } = require("../src/payments/accounts");

const DOMAIN = "demo.sheserve.app";
const PASSWORD = "demo1234";
const GUAXUPE = "3128709";
const ALFENAS = "3101607";
const NOW = new Date();
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY_MS);
const uuid = () => crypto.randomUUID();
const mockId = (prefix) => `${prefix}_mock_seed_${crypto.randomBytes(6).toString("hex")}`;

// CPF válido a partir de 9 dígitos
function cpfFrom(base) {
  const digits = String(base).padStart(9, "0").split("").map(Number);
  for (const length of [9, 10]) {
    const sum = digits.reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
    const rest = (sum * 10) % 11;
    digits.push(rest === 10 ? 0 : rest);
  }
  return digits.join("");
}

const PROVIDERS = [
  {
    key: "ana", name: "Ana Beatriz Souza", tier: "free", city: GUAXUPE, cityName: "Guaxupé",
    bio: "Escova, manicure e cuidados com os cabelos no meu studio no centro.",
    fiscal: { regime: "informal", serviceCode: "6.01", nbs: "126021000" },
    services: [
      { key: "escova", title: "Escova modeladora", price: "40.00", minutes: 60, category: "beauty" },
      { key: "manicure", title: "Manicure e pedicure", price: "30.00", minutes: 60, category: "beauty" },
    ],
    plans: [
      { key: "escova4", name: "Escova toda semana", priceCents: 15000, items: [["escova", 4]], reservedSlot: "Sábados às 9h" },
      { key: "maos2", name: "Mãos sempre feitas", priceCents: 5500, items: [["manicure", 2]] },
    ],
  },
  {
    key: "carla", name: "Carla Mendes", tier: "standard", city: ALFENAS, cityName: "Alfenas",
    bio: "Esteticista. Limpeza de pele e design de sobrancelhas.",
    fiscal: { regime: "mei", cnpj: "11444777000161", legal_name: "Carla Mendes Estetica MEI", municipal_registration: "12345", emite_nfse: true, serviceCode: "6.02", nbs: "126022000" },
    services: [
      { key: "pele", title: "Limpeza de pele", price: "90.00", minutes: 90, category: "beauty" },
      { key: "sobrancelha", title: "Design de sobrancelhas", price: "35.00", minutes: 40, category: "beauty" },
    ],
    plans: [
      { key: "pele", name: "Pele em dia", priceCents: 11000, items: [["pele", 1], ["sobrancelha", 1]] },
    ],
  },
  {
    key: "juliana", name: "Juliana Rocha", tier: "pro", city: GUAXUPE, cityName: "Guaxupé",
    bio: "Massoterapeuta. Massagem relaxante e drenagem linfática no meu espaço.",
    fiscal: { regime: "me", cnpj: "45723174000110", legal_name: "Juliana Rocha Bem-Estar ME", emite_nfse: true, serviceCode: "6.02", nbs: "126023000" },
    services: [
      { key: "massagem", title: "Massagem relaxante", price: "80.00", minutes: 60, category: "beauty" },
      { key: "drenagem", title: "Drenagem linfática", price: "100.00", minutes: 60, category: "beauty" },
    ],
    plans: [
      { key: "relax", name: "Relax mensal", priceCents: 15000, items: [["massagem", 2]] },
      { key: "drenagem", name: "Drenagem 4x", priceCents: 36000, items: [["drenagem", 4]] },
    ],
  },
];

const CUSTOMERS = [
  "Mariana Lopes", "Fernanda Alves", "Patrícia Gomes", "Renata Dias", "Camila Freitas",
  "Luciana Prado", "Bianca Moraes", "Tatiane Ribeiro", "Aline Castro", "Débora Nunes",
].map((name, index) => ({ key: `c${index}`, name }));

// [cliente, prestadora, plano, início (dias atrás), situação]
const SUBSCRIPTIONS = [
  ["c0", "ana", "escova4", 83, "ativa", { used: 1 }],
  ["c1", "ana", "escova4", 52, "ativa", {}],
  ["c2", "ana", "maos2", 64, "ativa", {}],
  ["c3", "ana", "maos2", 21, "ativa", {}],
  ["c4", "ana", "escova4", 94, "em_retentativa", {}], // 5ª vaga do Free (no limite)
  ["c5", "carla", "pele", 88, "ativa", { used: 1 }],
  ["c6", "carla", "pele", 40, "ativa", {}],
  ["c7", "carla", "pele", 90, "cancelada", { canceledDaysAgo: 30 }],
  ["c0", "juliana", "relax", 75, "ativa", {}],
  ["c8", "juliana", "drenagem", 60, "ativa", { cancelAtPeriodEnd: true }],
  ["c9", "juliana", "relax", 85, "cancelada", { canceledDaysAgo: 22 }],
  ["c5", "juliana", "drenagem", 30, "ativa", {}],
];

// Avulsos pagos no app: [cliente, prestadora, serviço, dias atrás, situação]
const AVULSOS = [
  ["c9", "juliana", "massagem", 80, "completed"],
  ["c9", "juliana", "massagem", 52, "completed"],
  ["c9", "juliana", "massagem", 24, "completed"],
  ["c1", "juliana", "drenagem", 45, "completed"],
  ["c7", "carla", "pele", 15, "completed"],
  ["c6", "carla", "sobrancelha", 70, "completed"],
  ["c3", "ana", "escova", 33, "completed"],
  ["c3", "ana", "escova", 12, "completed"],
  ["c2", "ana", "escova", -3, "accepted"], // marcado para daqui a 3 dias
];

async function resetDemo(client) {
  const { rows } = await client.query("SELECT id FROM users WHERE email LIKE $1", [`%@${DOMAIN}`]);
  const ids = rows.map((row) => row.id);
  if (!ids.length) return 0;
  const orderIds = `(SELECT id FROM orders WHERE customer_id = ANY($1) OR provider_id = ANY($1))`;
  const chargeIds = `(SELECT id FROM charges WHERE customer_id = ANY($1) OR provider_id = ANY($1))`;
  const subIds = `(SELECT id FROM subscriptions WHERE customer_id = ANY($1) OR provider_id = ANY($1))`;
  const statements = [
    "DELETE FROM mock_scheduled_webhooks WHERE payload->>'seed' = 'true'",
    "DELETE FROM mock_gateway_objects WHERE state->>'seed' = 'true'",
    `DELETE FROM invoice_data WHERE charge_id IN ${chargeIds}`,
    `DELETE FROM refunds WHERE charge_id IN ${chargeIds}`,
    `DELETE FROM payables WHERE charge_id IN ${chargeIds}`,
    `DELETE FROM charge_deductions WHERE charge_id IN ${chargeIds} OR subscription_id IN ${subIds}`,
    `DELETE FROM entitlement_usages WHERE order_id IN ${orderIds}`,
    `DELETE FROM charges WHERE id IN ${chargeIds}`,
    `DELETE FROM entitlements WHERE subscription_id IN ${subIds}`,
    `DELETE FROM subscriptions WHERE id IN ${subIds}`,
    "DELETE FROM subscription_plans WHERE provider_id = ANY($1)",
    `DELETE FROM order_events WHERE order_id IN ${orderIds}`,
    `DELETE FROM check_ins WHERE order_id IN ${orderIds}`,
    `DELETE FROM messages WHERE order_id IN ${orderIds}`,
    `DELETE FROM reviews WHERE order_id IN ${orderIds}`,
    `DELETE FROM payments WHERE order_id IN ${orderIds}`,
    `DELETE FROM payouts WHERE order_id IN ${orderIds}`,
    `DELETE FROM financial_entries WHERE provider_id = ANY($1)`,
    `DELETE FROM orders WHERE id IN ${orderIds}`,
    "DELETE FROM services WHERE provider_id = ANY($1)",
    "UPDATE users SET billing_address_id = NULL WHERE id = ANY($1)",
    "DELETE FROM users WHERE id = ANY($1)",
  ];
  for (const sql of statements) await client.query(sql, sql.includes("$1") ? [ids] : []);
  return ids.length;
}

async function insertUser(client, { name, email, phone, roles, cpf }) {
  const id = uuid();
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await client.query(
    "INSERT INTO users (id,name,email,phone,password_hash,roles,cpf_encrypted,cpf_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id, name, email, phone, passwordHash, roles, cpf ? encryptText(cpf) : null, cpf ? cpfHash(cpf) : null, daysAgo(120)]
  );
  await client.query("INSERT INTO verifications (user_id,type,result,created_at) VALUES ($1,'cpf_selfie','approved',$2)", [id, daysAgo(119)]);
  return id;
}

async function saveMock(client, gatewayId, kind, state, idempotencyKey = null) {
  await client.query(
    "INSERT INTO mock_gateway_objects (gateway_id,kind,idempotency_key,state) VALUES ($1,$2,$3,$4)",
    [gatewayId, kind, idempotencyKey, { ...state, seed: true }]
  );
}

// Cobrança paga (ou recusada) com split, repasse e dados da nota
async function insertCharge(client, { origin, sub, orderId, customerId, provider, breakdown, settings, paidAt, status, attempt = 1, cycle, method }) {
  const gatewayChargeId = mockId("ch");
  const split = buildSplit({ providerAmountCents: breakdown.providerAmountCents, feeCents: breakdown.feeCents });
  const { rows } = await client.query(
    `INSERT INTO charges (origin,subscription_id,subscription_cycle,order_id,customer_id,provider_id,charge_owner,total_cents,fee_cents,
       provider_amount_cents,fee_payer,status,attempt,payment_method,idempotency_key,request_fingerprint,gateway,gateway_charge_id,
       settings_snapshot,settings_version,paid_at,failed_at,failure_code,failure_message,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'plataforma',$7,$8,$9,$10,$11,$12,$13,$14,$14,'mock',$15,$16,$17,$18,$19,$20,$21,$22,$22)
     RETURNING *`,
    [origin, sub?.id ?? null, sub ? cycle : null, orderId ?? null, customerId, provider.id, breakdown.totalCents, breakdown.feeCents,
     breakdown.providerAmountCents, breakdown.feePayer, status, attempt, method, `seed:${gatewayChargeId}`, gatewayChargeId,
     snapshotOf(settings), settingsVersion(settings), status === "paga" ? paidAt : null, status === "falhou" ? paidAt : null,
     status === "falhou" ? "insufficient_funds" : null, status === "falhou" ? "Saldo ou limite insuficiente." : null, paidAt]
  );
  const charge = rows[0];
  await client.query(
    `INSERT INTO charge_splits (charge_id,party,gateway_recipient_id,amount_cents) VALUES ($1,'prestadora',$2,$3),($1,'plataforma',NULL,$4)`,
    [charge.id, provider.recipientId, split.prestadora, split.plataforma]
  );
  await saveMock(client, gatewayChargeId, "charge", {
    status: status === "paga" ? "paga" : "falhou", valorTotal: breakdown.totalCents, metodo: method, estornado: 0,
    split: { titular: "plataforma", itens: [{ recipientId: provider.recipientId, parte: "prestadora", valor: split.prestadora }, { recipientId: null, parte: "plataforma", valor: split.plataforma }] },
    referencia: sub ? { tipo: "assinatura", id: sub.id } : { tipo: "cobranca", id: charge.id },
    ...(sub ? { assinatura: { subscriptionId: sub.gatewayId, ciclo: cycle, tentativa: attempt } } : {}),
  }, `seed:${gatewayChargeId}`);
  if (status === "paga") await recordPaidCharge(client, charge, paidAt);
  return charge;
}

async function main() {
  const reset = process.argv.includes("--reset");
  const client = await db.connectionPool.connect();
  client.afterCommit = () => {};
  try {
    await db.runMigrations();
    await client.query("BEGIN");
    const existing = await client.query("SELECT COUNT(*)::int AS total FROM users WHERE email LIKE $1", [`%@${DOMAIN}`]);
    if (existing.rows[0].total && !reset) throw new Error("Os dados de demonstração já existem. Use --reset para recriar.");
    if (reset) console.log(`Removidas ${await resetDemo(client)} contas de demonstração anteriores.`);

    // Override de Alfenas: taxa de 3,5% (comparar adesão e evasão com Guaxupé)
    await client.query(
      `INSERT INTO payment_settings (scope_key, fee_percent_bps, version) VALUES ($1, 350, 1)
       ON CONFLICT (scope_key) DO NOTHING`,
      [ALFENAS]
    );
    await client.query("INSERT INTO categories (id,name,icon) VALUES ('beauty','Beleza','beauty') ON CONFLICT (id) DO NOTHING");

    // Clientes: CPF e endereço completo com CEP
    const customers = {};
    for (const [index, customer] of CUSTOMERS.entries()) {
      const city = index % 3 === 1 ? { name: "Alfenas", cep: "37130000" } : { name: "Guaxupé", cep: "37800000" };
      const id = await insertUser(client, {
        name: customer.name, email: `${customer.key}@${DOMAIN}`, phone: `+553599100${String(index).padStart(4, "0")}`,
        roles: ["cliente"], cpf: cpfFrom(310000000 + index * 7919),
      });
      const { rows } = await client.query(
        `INSERT INTO addresses (user_id,label,street,number,neighborhood,city,state,postal_code)
         VALUES ($1,'Casa',$2,$3,'Centro',$4,'MG',$5) RETURNING id`,
        [id, `Rua das Flores`, String(100 + index * 12), city.name, city.cep]
      );
      await client.query("UPDATE users SET billing_address_id=$2 WHERE id=$1", [id, rows[0].id]);
      customers[customer.key] = { ...customer, id };
    }

    // Prestadoras: aprovadas, com espaço, serviços, recebedor aprovado e perfil fiscal
    const providers = {};
    for (const [index, provider] of PROVIDERS.entries()) {
      const cpf = cpfFrom(520000000 + index * 104729);
      const id = await insertUser(client, {
        name: provider.name, email: `${provider.key}@${DOMAIN}`, phone: `+553599200${String(index).padStart(4, "0")}`,
        roles: ["prestadora"], cpf,
      });
      await client.query(
        "INSERT INTO provider_profiles (user_id,bio,activation_status,verified,available,latitude,longitude,city_code) VALUES ($1,$2,'active',true,true,$3,$4,$5)",
        [id, provider.bio, -21.3 - index * 0.01, -46.7 - index * 0.01, provider.city]
      );
      await client.query(
        `INSERT INTO provider_venues (provider_id,street,number,neighborhood,city,state,postal_code,latitude,longitude)
         VALUES ($1,'Avenida Principal',$2,'Centro',$3,'MG',$4,$5,$6)`,
        [id, String(200 + index), provider.cityName, provider.city === ALFENAS ? "37130000" : "37800000", -21.3 - index * 0.01, -46.7 - index * 0.01]
      );
      const services = {};
      for (const service of provider.services) {
        const { rows } = await client.query(
          `INSERT INTO services (provider_id,category_id,title,base_price,duration_minutes,service_location,price_type,availability)
           VALUES ($1,$2,$3,$4,$5,'at_provider','fixed',$6) RETURNING id`,
          [id, service.category, service.title, service.price, service.minutes,
           JSON.stringify([1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })))]
        );
        services[service.key] = { ...service, id: rows[0].id };
      }
      const recipientId = mockId("rp");
      await client.query(
        `INSERT INTO provider_payment_accounts (provider_id,gateway,gateway_recipient_id,status,holder_name,holder_document_type,
           holder_document_encrypted,bank_code,branch,account_type,account_encrypted,account_last4,plans_activated_at,created_at,
           kyc_status,kyc_verified_at)
         VALUES ($1,'mock',$2,'aprovada',$3,'cpf',$4,'260','0001','corrente',$5,$6,$7,$7,'aprovada',$7)`,
        [id, recipientId, provider.name, encryptText(cpf), encryptText(`1234${index}5`), `4${index}5`.padStart(4, "0").slice(-4), daysAgo(100)]
      );
      await saveMock(client, recipientId, "recipient", {
        status: "aprovada", nome: provider.name, decisao: "aprovada", kyc: { status: "aprovada" },
      }, `seed:${recipientId}`);
      // termo de elegibilidade aceito e dados básicos conferidos (selo 1)
      await client.query(
        `INSERT INTO term_acceptances (user_id,term_key,version)
         SELECT $1, term_key, MAX(version) FROM legal_terms WHERE term_key='prestadora_elegibilidade' GROUP BY term_key`,
        [id]
      );
      await client.query(
        "UPDATE provider_profiles SET basic_data_verified_at=$2, basic_data_check=$3 WHERE user_id=$1",
        [id, daysAgo(100), { source: "serpro_manual", cpfRegular: true, nameMatches: true, note: "seed de demonstração" }]
      );
      await client.query(
        `INSERT INTO provider_plans (provider_id,plan_name,monthly_approval_limit,tier_changed_at,tier_billed_until)
         VALUES ($1,$2,(SELECT monthly_approval_limit FROM plan_catalog WHERE plan_code=$2),$3,$4)`,
        [id, provider.tier, daysAgo(100), provider.tier === "free" ? null : new Date(NOW.getTime() + 8 * DAY_MS)]
      );
      // Perfil fiscal: informal (CPF), MEI completo (emissão ativa), ME com dado faltando (pendente)
      const fiscal = provider.fiscal;
      const missing = fiscal.regime === "me" ? ["municipal_registration"] : [];
      const statusConfig = fiscal.regime === "informal" ? "desativada" : missing.length ? "pendente" : "ativa";
      await client.query(
        `INSERT INTO provider_fiscal_profiles (provider_id,regime,document_type,cpf_encrypted,cnpj,legal_name,municipal_registration,
           city_code,service_code,aliquota_iss_bps,iss_retido,emite_nfse,status_config,missing_fields,tax_regime,nbs_code,c_class_trib)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$14,$9,false,$10,$11,$12,$13,$15,'000001')`,
        [id, fiscal.regime, fiscal.cnpj ? "cnpj" : "cpf", encryptText(cpf), fiscal.cnpj ?? null, fiscal.legal_name ?? null,
         fiscal.municipal_registration ?? null, provider.city, fiscal.regime === "mei" ? null : 200, Boolean(fiscal.emite_nfse),
         statusConfig, missing, fiscal.regime === "mei" ? "mei" : fiscal.regime === "me" ? "simples_nacional" : null,
         fiscal.serviceCode, fiscal.nbs]
      );
      // Mensalidade da camada como desconto de repasse (Standard/Pro)
      const settings = await loadEffectiveSettings(client, provider.city);
      if (provider.tier !== "free") {
        const price = provider.tier === "pro" ? settings.pro_price_cents : settings.standard_price_cents;
        await client.query(
          `INSERT INTO provider_deductions (provider_id,kind,description,amount_cents,settings_snapshot,reference,created_at)
           VALUES ($1,'camada',$2,$3,$4,$5,$6)`,
          [id, `Mensalidade ${provider.tier === "pro" ? "Pro" : "Standard"} (mês atual)`, price, snapshotOf(settings),
           `camada:${provider.tier}:seed`, daysAgo(22)]
        );
      }
      const plans = {};
      for (const plan of provider.plans) {
        const { rows } = await client.query(
          `INSERT INTO subscription_plans (provider_id,name,price_cents,reserved_slot,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [id, plan.name, plan.priceCents, plan.reservedSlot ?? null, daysAgo(100)]
        );
        for (const [serviceKey, sessions] of plan.items) {
          await client.query("INSERT INTO subscription_plan_items (plan_id,service_id,sessions_per_cycle) VALUES ($1,$2,$3)", [rows[0].id, services[serviceKey].id, sessions]);
        }
        plans[plan.key] = { ...plan, id: rows[0].id };
      }
      providers[provider.key] = { ...provider, id, recipientId, services, plans, settings };
    }

    // Assinaturas com o histórico de cobranças de cada ciclo
    const options = { intervalUnit: "month", intervalCount: 1 };
    let subscriptionCount = 0;
    let chargeCount = 0;
    for (const [customerKey, providerKey, planKey, startDaysAgo, finalStatus, extra] of SUBSCRIPTIONS) {
      const provider = providers[providerKey];
      const customer = customers[customerKey];
      const plan = provider.plans[planKey];
      const settings = provider.settings;
      const breakdown = priceBreakdown(plan.priceCents, settings);
      const startedAt = daysAgo(startDaysAgo);
      const anchorDay = Number(brasiliaDateKey(startedAt).slice(8, 10));
      const periodOptions = { ...options, anchorDay };
      // ciclos que já começaram até hoje
      let cycles = 0;
      while (cyclePeriod(startedAt, cycles, periodOptions).start <= NOW) cycles++;
      const canceledAt = extra.canceledDaysAgo ? daysAgo(extra.canceledDaysAgo) : null;
      if (canceledAt) {
        cycles = 0;
        while (cyclePeriod(startedAt, cycles, periodOptions).start <= canceledAt) cycles++;
      }
      const current = cyclePeriod(startedAt, cycles - 1, periodOptions);
      const sub = { id: uuid(), gatewayId: mockId("sub") };
      await client.query(
        `INSERT INTO subscriptions (id,customer_id,provider_id,plan_id,status,provider_amount_cents,fee_cents,total_cents,fee_payer,
           settings_snapshot,settings_version,current_split,billing_anchor_day,interval_unit,interval_count,started_at,current_cycle,
           current_period_start,current_period_end,cancel_at_period_end,cancel_requested_at,canceled_at,retry_attempt,next_retry_at,
           card_last4,card_brand,gateway,gateway_subscription_id,idempotency_key,request_fingerprint,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'month',1,$14,$15,$16,$17,$18,$19,$20,0,$21,'4242','visa','mock',$22,$23,$23,$14)`,
        [sub.id, customer.id, provider.id, plan.id, finalStatus, breakdown.providerAmountCents, breakdown.feeCents, breakdown.totalCents,
         breakdown.feePayer, snapshotOf(settings), settingsVersion(settings),
         buildSplit({ providerAmountCents: breakdown.providerAmountCents, feeCents: breakdown.feeCents }), anchorDay, startedAt, cycles,
         current.start, finalStatus === "cancelada" ? canceledAt : current.end, Boolean(extra.cancelAtPeriodEnd),
         extra.cancelAtPeriodEnd ? daysAgo(3) : canceledAt ? daysAgo(extra.canceledDaysAgo + 10) : null, canceledAt,
         finalStatus === "em_retentativa" ? new Date(NOW.getTime() + DAY_MS) : null, sub.gatewayId, `seed:${sub.id}`]
      );
      await client.query(
        "INSERT INTO subscription_events (subscription_id,from_status,to_status,event,created_at) VALUES ($1,NULL,'pendente','created',$2),($1,'pendente','ativa','PAYMENT_CONFIRMED',$2)",
        [sub.id, startedAt]
      );
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const period = cyclePeriod(startedAt, cycle - 1, periodOptions);
        const isLast = cycle === cycles;
        const failed = isLast && finalStatus === "em_retentativa" && cycle > 1;
        await insertCharge(client, {
          origin: "assinatura", sub, customerId: customer.id, provider, breakdown, settings, cycle, method: "cartao",
          paidAt: new Date(period.start.getTime() + 60000), status: failed ? "falhou" : "paga",
        });
        chargeCount++;
        if (failed) {
          await client.query(
            "INSERT INTO subscription_events (subscription_id,from_status,to_status,event,reason,created_at) VALUES ($1,'ativa','em_retentativa','PAYMENT_FAILED','Saldo ou limite insuficiente.',$2)",
            [sub.id, period.start]
          );
        }
      }
      if (finalStatus === "cancelada") {
        await client.query(
          "INSERT INTO subscription_events (subscription_id,from_status,to_status,event,created_at) VALUES ($1,'ativa','cancelada','PERIOD_ENDED_WITH_CANCEL',$2)",
          [sub.id, canceledAt]
        );
      }
      // Direitos do ciclo atual (congelados em retentativa; nenhum para cancelada)
      if (finalStatus !== "cancelada") {
        for (const [serviceKey, sessions] of plan.items) {
          await client.query(
            `INSERT INTO entitlements (subscription_id,customer_id,provider_id,service_id,cycle,period_start,period_end,sessions_granted,sessions_used)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)`,
            [sub.id, customer.id, provider.id, provider.services[serviceKey].id, cycles, current.start, current.end, sessions]
          );
        }
      }
      // Sessão já agendada (debitada no agendamento)
      if (extra.used) {
        const [serviceKey] = plan.items[0];
        const service = provider.services[serviceKey];
        const scheduledAt = new Date(Math.min(current.end.getTime() - DAY_MS, NOW.getTime() + 2 * DAY_MS));
        scheduledAt.setUTCHours(13, 0, 0, 0);
        const { rows: orders } = await client.query(
          `INSERT INTO orders (customer_id,provider_id,service_id,service_location,scheduled_at,duration_minutes,status,total_amount,commission,checkin_code,created_at)
           VALUES ($1,$2,$3,'at_provider',$4,$5,'accepted',$6,0,'4321',$7) RETURNING id`,
          [customer.id, provider.id, service.id, scheduledAt, service.minutes, service.price, daysAgo(1)]
        );
        const { rows: entitlement } = await client.query(
          "UPDATE entitlements SET sessions_used=sessions_used+1 WHERE subscription_id=$1 AND service_id=$2 AND cycle=$3 RETURNING id",
          [sub.id, service.id, cycles]
        );
        await client.query("INSERT INTO entitlement_usages (entitlement_id,order_id,debited_at) VALUES ($1,$2,$3)", [entitlement[0].id, orders[0].id, daysAgo(1)]);
      }
      // Assinatura no mock, com a próxima cobrança agendada no aniversário
      const gatewayActive = ["ativa", "em_retentativa"].includes(finalStatus) && !extra.cancelAtPeriodEnd;
      await saveMock(client, sub.gatewayId, "subscription", {
        status: gatewayActive ? "ativa" : "cancelada", recipientId: provider.recipientId, valorTotal: breakdown.totalCents,
        split: { titular: "plataforma", itens: [{ recipientId: provider.recipientId, parte: "prestadora", valor: breakdown.providerAmountCents }, { recipientId: null, parte: "plataforma", valor: breakdown.feeCents }] },
        periodicidade: { unidade: "month", quantidade: 1 }, inicio: startedAt.toISOString(), diaAncora: anchorDay, token: "tok_mock_seed",
        politica: { tentativas: settings.retry_max_attempts, intervaloDias: settings.retry_interval_days },
        referencia: { tipo: "assinatura", id: sub.id }, cicloAtual: cycles,
      }, `seed:${sub.gatewayId}`);
      if (gatewayActive) {
        const nextJob = finalStatus === "em_retentativa"
          ? { action: "bill_subscription", subscriptionId: sub.gatewayId, cycle: cycles, attempt: 2, seed: true }
          : { action: "bill_subscription", subscriptionId: sub.gatewayId, cycle: cycles + 1, attempt: 1, seed: true };
        await client.query(
          "INSERT INTO mock_scheduled_webhooks (fire_at,payload) VALUES ($1,$2)",
          [finalStatus === "em_retentativa" ? new Date(NOW.getTime() + DAY_MS) : current.end, nextJob]
        );
      }
      subscriptionCount++;
    }

    // Avulsos pagos no app (alimentam o extrato e a sugestão de plano)
    for (const [customerKey, providerKey, serviceKey, when, status] of AVULSOS) {
      const provider = providers[providerKey];
      const customer = customers[customerKey];
      const service = provider.services[serviceKey];
      const scheduledAt = daysAgo(when);
      scheduledAt.setUTCHours(14, 0, 0, 0);
      const createdAt = when > 0 ? daysAgo(when + 2) : daysAgo(1);
      const { rows: orders } = await client.query(
        `INSERT INTO orders (customer_id,provider_id,service_id,service_location,scheduled_at,duration_minutes,status,total_amount,commission,checkin_code,created_at)
         VALUES ($1,$2,$3,'at_provider',$4,$5,$6,$7,0,'1234',$8) RETURNING id`,
        [customer.id, provider.id, service.id, scheduledAt, service.minutes, status, service.price, createdAt]
      );
      const priceCents = Number(service.price.replace(".", ""));
      const breakdown = priceBreakdown(priceCents, provider.settings);
      await insertCharge(client, {
        origin: "avulso", orderId: orders[0].id, customerId: customer.id, provider, breakdown, settings: provider.settings,
        method: "pix", paidAt: new Date(createdAt.getTime() + 120000), status: "paga",
      });
      chargeCount++;
      if (status === "completed") {
        await client.query(
          `INSERT INTO financial_entries (provider_id,entry_type,amount,category,description,service_id,customer_id,source_order_id,occurred_at)
           VALUES ($1,'receivable',$2,'Serviço concluído',$3,$4,$5,$6,$7)`,
          [provider.id, service.price, `Atendimento ${service.title}`, service.id, customer.id, orders[0].id, scheduledAt]
        );
      }
    }

    // Repasses que já venceram saíram; status de nota variado para a tela
    await client.query(
      "UPDATE payables SET status='pago', paid_at=expected_payout_date::timestamptz + interval '12 hours' WHERE status='previsto' AND expected_payout_date <= $1::date",
      [brasiliaDateKey(NOW)]
    );
    await client.query(
      `UPDATE invoice_data SET status='emitida', status_changed_at=now()
       WHERE provider_id=$1 AND competencia < date_trunc('month', now())::date`,
      [providers.carla.id]
    );
    await client.query(
      `UPDATE invoice_data SET status='dispensada', status_changed_at=now() WHERE provider_id=$1 AND competencia < date_trunc('month', now())::date`,
      [providers.ana.id]
    );

    await client.query("COMMIT");
    console.log(`Seed criado: ${PROVIDERS.length} prestadoras, ${CUSTOMERS.length} clientes, ${subscriptionCount} assinaturas, ${chargeCount} cobranças.`);
    console.log(`Contas (senha ${PASSWORD}):`);
    for (const provider of PROVIDERS) console.log(`  prestadora ${provider.tier.padEnd(8)} ${provider.key}@${DOMAIN}  (${provider.name}, ${provider.cityName})`);
    console.log(`  clientes: c0@${DOMAIN} ... c9@${DOMAIN}  (c0 assina Ana e Juliana; c4 está em retentativa)`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Seed falhou:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.connectionPool.end();
  }
}

main();
