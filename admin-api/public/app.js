// Painel administrativo SheServe: prestadoras, verificações, planos e categorias.
// Fala só com a própria admin-api (mesma origem). Todo dado vindo da API é
// inserido com textContent, nunca como HTML.
(() => {
  "use strict";

  const SESSION_KEY = "sheserve-admin-session";
  const PAGE_SIZE = 50;

  const PROVIDER_STATUS = { pending: "Pendente", active: "Aprovada", rejected: "Recusada" };
  const VERIFICATION_STATUS = { pending: "Pendente", approved: "Aprovada", rejected: "Recusada" };
  const VERIFICATION_TYPES = {
    cpf_selfie: "CPF e selfie",
    gender_eligibility: "Elegibilidade",
    background_check: "Antecedentes",
    proof_of_address: "Comprovante de endereço",
    references: "Referências",
  };
  const PLAN_FEATURES = [
    ["finance", "Financeiro"],
    ["inventory", "Inventário"],
    ["clients", "Clientes"],
    ["statistics", "Estatísticas"],
    ["promotions", "Promoções"],
    ["team", "Equipe"],
    ["branding", "Perfil da marca"],
    ["invoices", "Notas fiscais"],
    ["custom_quotes", "Orçamento livre"],
  ];
  const LOCATION_LABELS = { at_customer: "vai até a cliente", at_provider: "recebe no espaço" };
  const ERROR_MESSAGES = {
    invalid_credentials: "E-mail ou senha inválidos.",
    forbidden: "Esta conta não tem acesso de administrador.",
    rate_limited: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
    upstream_unavailable: "O serviço de login não respondeu. Tente novamente em instantes.",
    not_configured: "O painel não está configurado (MARKETPLACE_API_URL).",
    validation_error: "Confira os dados informados.",
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const elements = {
    loginView: $("#login-view"),
    loginForm: $("#login-form"),
    loginEmail: $("#login-email"),
    loginPassword: $("#login-password"),
    loginError: $("#login-error"),
    loginSubmit: $("#login-submit"),
    appView: $("#app-view"),
    adminName: $("#admin-name"),
    logoutButton: $("#logout-button"),
    sectionLinks: $$(".section-link"),
    toast: $("#toast"),
  };
  let toastTimer;

  // ---------- Sessão ----------

  function readStoredSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null;
    } catch {
      return null;
    }
  }

  let session = readStoredSession();

  function saveSession(next) {
    session = next;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch {
      // Sem armazenamento: a sessão vale até recarregar a página.
    }
  }

  function clearSession() {
    session = null;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignorado */
    }
  }

  // ---------- HTTP ----------

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function request(method, path, body, accessToken) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    let response;
    try {
      response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, "network", "Sem conexão com o servidor.");
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload?.error?.code ?? "error";
      throw new ApiError(response.status, code, ERROR_MESSAGES[code] ?? payload?.error?.message ?? "A solicitação falhou.");
    }
    return payload;
  }

  // Chamada autenticada; renova o token uma vez se ele expirou (dura 15 min).
  async function api(method, path, body) {
    if (!session) throw new ApiError(401, "unauthorized", "Faça login.");
    try {
      return await request(method, path, body, session.accessToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      try {
        saveSession(await request("POST", "/api/v1/admin/session/refresh", { refreshToken: session.refreshToken }));
      } catch {
        showLogin("Sua sessão expirou. Entre novamente.");
        throw error;
      }
      return request(method, path, body, session.accessToken);
    }
  }

  // ---------- Utilidades de interface ----------

  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4000);
  }

  const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" });
  const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const formatDate = (value) => (value ? dateFormatter.format(new Date(value)) : "—");

  function formatPhone(phone) {
    const match = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(phone ?? "");
    return match ? `+55 (${match[1]}) ${match[2]}-${match[3]}` : phone ?? "—";
  }

  function cloneTemplate(id) {
    return document.getElementById(id).content.firstElementChild.cloneNode(true);
  }

  function setBadge(badge, text, variant) {
    badge.textContent = text;
    badge.className = `badge ${variant}`;
  }

  // Ações de aprovar/recusar com motivo obrigatório na recusa.
  // `send(change)` faz a chamada; o cartão sai da lista quando dá certo.
  function wireDecision(card, { canApprove, canReject, send, onDone }) {
    const approveButton = $(".action-approve", card);
    const rejectButton = $(".action-reject", card);
    const rejectForm = $(".reject-form", card);
    const reasonInput = $(".reject-reason", card);

    const resetButtons = () => {
      approveButton.hidden = !canApprove;
      rejectButton.hidden = !canReject;
    };
    resetButtons();

    async function submit(change, buttons) {
      buttons.forEach((button) => { button.disabled = true; });
      try {
        await send(change);
        card.remove();
        onDone(change);
      } catch (error) {
        if (error.status !== 401) showToast(error.message, true);
        buttons.forEach((button) => { button.disabled = false; });
      }
    }

    approveButton.addEventListener("click", () => submit({ approve: true }, [approveButton, rejectButton]));
    rejectButton.addEventListener("click", () => {
      rejectForm.hidden = false;
      approveButton.hidden = true;
      rejectButton.hidden = true;
      reasonInput.focus();
    });
    $(".action-cancel", card).addEventListener("click", () => {
      rejectForm.hidden = true;
      resetButtons();
    });
    rejectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const reason = reasonInput.value.trim();
      if (!reason) {
        reasonInput.focus();
        showToast("Informe o motivo da recusa.", true);
        return;
      }
      submit({ approve: false, reason }, $$("button", rejectForm));
    });
  }

  // ---------- Lista paginada com abas (prestadoras e verificações) ----------

  function createListSection({ panel, initialFilter, path, renderItem, emptyMessages }) {
    const state = { filter: initialFilter, offset: 0, loading: false };
    const list = $(".item-list", panel);
    const status = $(".list-status", panel);
    const loadMore = $(".load-more", panel);
    const refreshButton = $(".refresh-button", panel);
    const tabs = $$(".tab", panel);

    function renderEmpty() {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = emptyMessages[state.filter];
      list.replaceChildren(empty);
      status.textContent = "";
    }

    function itemRemoved() {
      if (!list.querySelector(".card")) renderEmpty();
    }

    async function load({ reset }) {
      if (state.loading) return;
      state.loading = true;
      if (reset) {
        state.offset = 0;
        list.replaceChildren();
      }
      loadMore.hidden = true;
      status.textContent = "Carregando...";
      refreshButton.disabled = true;
      try {
        const page = await api("GET", path(state.filter, state.offset, PAGE_SIZE));
        const items = page?.items ?? [];
        if (reset && items.length === 0) {
          renderEmpty();
          return;
        }
        list.append(...items.map((item) => renderItem(item, state.filter, itemRemoved)));
        state.offset += items.length;
        loadMore.hidden = items.length < PAGE_SIZE;
        status.textContent = "";
      } catch (error) {
        if (error.status !== 401) status.textContent = `Não foi possível carregar: ${error.message}`;
      } finally {
        state.loading = false;
        refreshButton.disabled = false;
      }
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        if (state.loading || tab.dataset.filter === state.filter) return;
        state.filter = tab.dataset.filter;
        tabs.forEach((other) => other.setAttribute("aria-pressed", String(other === tab)));
        load({ reset: true });
      });
    });
    refreshButton.addEventListener("click", () => load({ reset: true }));
    loadMore.addEventListener("click", () => load({ reset: false }));

    return { load: () => load({ reset: true }) };
  }

  // ---------- Prestadoras ----------

  function serviceDescription(service) {
    const price = service.priceType === "evaluation"
      ? "sob avaliação"
      : `${service.priceType === "from" ? "a partir de " : ""}${currencyFormatter.format(service.basePrice)}`;
    return [service.category, price, LOCATION_LABELS[service.serviceLocation] ?? service.serviceLocation]
      .filter(Boolean)
      .join(" · ");
  }

  function renderProvider(provider, _filter, onRemoved) {
    const card = cloneTemplate("provider-card-template");
    $(".card-name", card).textContent = provider.name;
    $(".card-meta", card).textContent = `Cadastro em ${formatDate(provider.createdAt)}`;
    setBadge($(".plan-badge", card), `Plano ${provider.planName ?? "Grátis"}`, "neutral");
    setBadge($(".status-badge", card), PROVIDER_STATUS[provider.activationStatus] ?? provider.activationStatus, provider.activationStatus);
    $(".card-email", card).textContent = provider.email;
    $(".card-phone", card).textContent = formatPhone(provider.phone);
    $(".card-identity", card).textContent = provider.identityVerified ? "Sim" : "Não";

    const bio = $(".card-bio", card);
    bio.textContent = provider.bio?.trim() || "Sem descrição.";
    bio.classList.toggle("empty", !provider.bio?.trim());

    const services = provider.services ?? [];
    $(".card-services-title", card).textContent = services.length === 1 ? "1 serviço" : `${services.length} serviços`;
    const serviceList = $(".card-services", card);
    if (services.length === 0) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = "Nenhum serviço cadastrado ainda.";
      serviceList.append(item);
    }
    for (const service of services) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = service.title;
      const detail = document.createElement("span");
      detail.className = "service-detail";
      detail.textContent = serviceDescription(service);
      item.append(title, detail);
      serviceList.append(item);
    }

    if (provider.activationStatus !== "pending") {
      $(".action-approve", card).textContent = "Reativar e aprovar";
      $(".action-reject", card).textContent = "Recusar e remover das buscas";
    }
    wireDecision(card, {
      canApprove: provider.activationStatus !== "active",
      canReject: provider.activationStatus !== "rejected",
      send: (change) => api("PATCH", `/api/v1/admin/providers/${encodeURIComponent(provider.id)}/approval`,
        change.approve ? { status: "active" } : { status: "rejected", reason: change.reason }),
      onDone: (change) => {
        showToast(change.approve
          ? `${provider.name} foi aprovada e verificada; já aparece nas buscas.`
          : `${provider.name} foi recusada. Ela será notificada no app.`);
        onRemoved();
      },
    });
    return card;
  }

  // ---------- Verificações ----------

  function roleLabel(roles = []) {
    const isProvider = roles.includes("prestadora");
    const isCustomer = roles.includes("cliente");
    if (isProvider && isCustomer) return "Cliente e prestadora";
    return isProvider ? "Prestadora" : "Cliente";
  }

  function renderVerification(verification, filter, onRemoved) {
    const card = cloneTemplate("verification-card-template");
    $(".card-name", card).textContent = verification.name;
    $(".card-meta", card).textContent = verification.reviewedAt
      ? `Solicitada em ${formatDate(verification.createdAt)} · revisada em ${formatDate(verification.reviewedAt)}`
      : `Solicitada em ${formatDate(verification.createdAt)}`;
    setBadge($(".role-badge", card), roleLabel(verification.roles), "neutral");
    setBadge($(".status-badge", card), VERIFICATION_STATUS[verification.result] ?? verification.result, verification.result);
    $(".card-email", card).textContent = verification.email;
    $(".card-phone", card).textContent = formatPhone(verification.phone);
    $(".card-type", card).textContent = VERIFICATION_TYPES[verification.type] ?? verification.type;

    if (verification.reviewNote) {
      const note = $(".review-note", card);
      note.textContent = verification.result === "rejected"
        ? `Motivo: ${verification.reviewNote}`
        : verification.reviewNote;
      note.hidden = false;
    }

    // Só pedidos pendentes recebem decisão
    wireDecision(card, {
      canApprove: filter === "pending",
      canReject: filter === "pending",
      send: (change) => api("PATCH", `/api/v1/admin/verifications/${encodeURIComponent(verification.id)}`,
        change.approve ? { result: "approved" } : { result: "rejected", reason: change.reason }),
      onDone: (change) => {
        showToast(change.approve
          ? `Identidade de ${verification.name} confirmada.`
          : `Verificação de ${verification.name} recusada. A pessoa será notificada.`);
        onRemoved();
      },
    });
    return card;
  }

  // ---------- Planos ----------

  function renderPlan(plan) {
    const form = cloneTemplate("plan-card-template");
    $(".plan-title", form).textContent = plan.displayName;
    setBadge($(".plan-code", form), plan.planCode, "neutral");
    $(".plan-name", form).value = plan.displayName;
    $(".plan-description", form).value = plan.description ?? "";
    $(".plan-limit", form).value = plan.monthlyApprovalLimit ?? "";
    $(".plan-active", form).checked = plan.active;

    const features = plan.features ?? {};
    const featureSet = $(".plan-features", form);
    for (const [key, label] of PLAN_FEATURES) {
      const option = document.createElement("label");
      option.className = "check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.feature = key;
      checkbox.checked = features[key] === true;
      option.append(checkbox, document.createTextNode(label));
      featureSet.append(option);
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const displayName = $(".plan-name", form).value.trim();
      const limitText = $(".plan-limit", form).value.trim();
      const limit = limitText === "" ? null : Number(limitText);
      if (displayName.length < 2) {
        showToast("O nome do plano precisa de pelo menos 2 caracteres.", true);
        return;
      }
      if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 100000)) {
        showToast("O limite mensal deve ser um número inteiro entre 0 e 100000.", true);
        return;
      }
      // Mantém outras chaves de "features" que o painel não edita
      const nextFeatures = { ...features };
      $$("input[data-feature]", form).forEach((checkbox) => {
        nextFeatures[checkbox.dataset.feature] = checkbox.checked;
      });
      const description = $(".plan-description", form).value.trim();
      const submitButton = $("button[type=submit]", form);
      submitButton.disabled = true;
      try {
        const saved = await api("PUT", `/api/v1/admin/plans/${encodeURIComponent(plan.planCode)}`, {
          displayName,
          description: description || null,
          monthlyApprovalLimit: limit,
          features: nextFeatures,
          active: $(".plan-active", form).checked,
        });
        Object.assign(plan, saved);
        $(".plan-title", form).textContent = saved.displayName;
        showToast(`Plano ${saved.displayName} salvo.`);
      } catch (error) {
        if (error.status !== 401) showToast(error.message, true);
      } finally {
        submitButton.disabled = false;
      }
    });
    return form;
  }

  function createPlansSection(panel) {
    const list = $(".item-list", panel);
    const status = $(".list-status", panel);
    const refreshButton = $(".refresh-button", panel);

    async function load() {
      status.textContent = "Carregando...";
      refreshButton.disabled = true;
      try {
        const plans = await api("GET", "/api/v1/admin/plans");
        list.replaceChildren(...(plans ?? []).map(renderPlan));
        status.textContent = "";
      } catch (error) {
        if (error.status !== 401) status.textContent = `Não foi possível carregar: ${error.message}`;
      } finally {
        refreshButton.disabled = false;
      }
    }
    refreshButton.addEventListener("click", load);
    return { load };
  }

  // ---------- Categorias ----------

  // Rótulos das chaves de ícone (a lista válida vem da API).
  const CATEGORY_ICON_LABELS = {
    general: "Geral",
    cleaning: "Limpeza",
    beauty: "Beleza",
    fashion: "Moda e costura",
    cooking: "Cozinha",
    learning: "Aulas",
    repairs: "Reparos",
    care: "Cuidados",
    pets: "Pets",
    health: "Saúde e bem-estar",
    events: "Eventos",
    transport: "Transporte",
  };
  const CATEGORY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  // "Limpeza pós-obra" -> "limpeza-pos-obra"
  function slugify(text) {
    return text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([optionValue, label]) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = label;
      return option;
    }));
    select.value = value;
  }

  function categoryErrorMessage(error) {
    if (error.code === "category_exists") return "Já existe uma categoria com esse identificador.";
    if (error.code === "category_in_use") return "A categoria está em uso. Desative-a em vez de excluir.";
    return error.message;
  }

  function createCategoriesSection(panel) {
    const list = $(".item-list", panel);
    const status = $(".list-status", panel);
    const newSlot = $(".new-category", panel);
    const refreshButton = $(".refresh-button", panel);
    let categories = [];
    let icons = Object.keys(CATEGORY_ICON_LABELS);

    const nameOf = (id) => categories.find((category) => category.id === id)?.name ?? id;

    // `null` monta o formulário de criação.
    function renderCategory(category) {
      const form = cloneTemplate("category-form-template");
      const isNew = category === null;
      const nameInput = $(".category-name", form);
      const idInput = $(".category-id", form);
      const deleteButton = $(".category-delete", form);
      // Só categorias principais podem receber subcategorias (dois níveis)
      const roots = categories.filter((item) => item.parentId === null && item.id !== category?.id);

      $(".category-title", form).textContent = isNew ? "Nova categoria" : category.name;
      nameInput.value = category?.name ?? "";
      idInput.value = category?.id ?? "";
      idInput.disabled = !isNew;
      fillSelect(
        $(".category-icon", form),
        icons.map((key) => [key, CATEGORY_ICON_LABELS[key] ?? key]),
        category?.icon ?? "general",
      );
      fillSelect(
        $(".category-parent", form),
        [["", "— nenhuma —"], ...roots.map((root) => [root.id, root.name])],
        category?.parentId ?? "",
      );
      $(".category-order", form).value = category?.sortOrder ?? 0;
      $(".category-active", form).checked = category?.active ?? true;

      if (isNew) {
        setBadge($(".category-status", form), "Nova", "neutral");
        $(".category-meta", form).textContent = "Preencha o nome; o identificador é sugerido a partir dele.";
        // Sugere o identificador enquanto ele não for editado à mão
        let idEdited = false;
        idInput.addEventListener("input", () => { idEdited = true; });
        nameInput.addEventListener("input", () => {
          if (!idEdited) idInput.value = slugify(nameInput.value);
        });
      } else {
        setBadge(
          $(".category-status", form),
          category.active ? "Ativa" : "Inativa",
          category.active ? "active" : "rejected",
        );
        $(".category-meta", form).textContent = category.parentId
          ? `Subcategoria de ${nameOf(category.parentId)} · ${category.id}`
          : `Categoria principal · ${category.id}`;
        const inUse = category.serviceCount > 0 || category.childCount > 0;
        $(".category-usage", form).textContent = [
          `${category.activeServiceCount} serviço(s) ativo(s)`,
          category.childCount > 0 ? `${category.childCount} subcategoria(s)` : null,
          inUse ? "em uso: para tirar do app, desative em vez de excluir" : null,
        ].filter(Boolean).join(" · ");
        deleteButton.hidden = inUse;
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        const id = idInput.value.trim();
        if (name.length < 2) {
          showToast("O nome precisa de pelo menos 2 caracteres.", true);
          return;
        }
        if (isNew && !CATEGORY_ID_PATTERN.test(id)) {
          showToast("Identificador inválido: use letras minúsculas, números e hífens.", true);
          return;
        }
        const order = Number($(".category-order", form).value || 0);
        if (!Number.isInteger(order) || order < 0 || order > 9999) {
          showToast("A ordem deve ser um número inteiro entre 0 e 9999.", true);
          return;
        }
        const body = {
          name,
          icon: $(".category-icon", form).value,
          parentId: $(".category-parent", form).value || null,
          sortOrder: order,
          active: $(".category-active", form).checked,
        };
        const saveButton = $(".category-save", form);
        saveButton.disabled = true;
        try {
          if (isNew) {
            await api("POST", "/api/v1/admin/categories", { id, ...body });
            showToast(`Categoria ${name} criada.`);
          } else {
            await api("PUT", `/api/v1/admin/categories/${encodeURIComponent(category.id)}`, body);
            showToast(`Categoria ${name} salva.`);
          }
          await load();
        } catch (error) {
          if (error.status !== 401) showToast(categoryErrorMessage(error), true);
        } finally {
          saveButton.disabled = false;
        }
      });

      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Excluir a categoria ${category.name}? Isso não pode ser desfeito.`)) return;
        deleteButton.disabled = true;
        try {
          await api("DELETE", `/api/v1/admin/categories/${encodeURIComponent(category.id)}`);
          showToast(`Categoria ${category.name} excluída.`);
          await load();
        } catch (error) {
          if (error.status !== 401) showToast(categoryErrorMessage(error), true);
          deleteButton.disabled = false;
        }
      });
      return form;
    }

    async function load() {
      status.textContent = "Carregando...";
      refreshButton.disabled = true;
      try {
        const result = await api("GET", "/api/v1/admin/categories");
        categories = result?.items ?? [];
        if (Array.isArray(result?.icons) && result.icons.length) icons = result.icons;
        // Principais na ordem definida, cada uma seguida das suas subcategorias
        const ordered = categories
          .filter((category) => category.parentId === null)
          .flatMap((root) => [root, ...categories.filter((category) => category.parentId === root.id)]);
        const orphans = categories.filter((category) => !ordered.includes(category));
        newSlot.replaceChildren(renderCategory(null));
        list.replaceChildren(...[...ordered, ...orphans].map(renderCategory));
        status.textContent = categories.length ? "" : "Nenhuma categoria cadastrada ainda.";
      } catch (error) {
        if (error.status !== 401) status.textContent = `Não foi possível carregar: ${error.message}`;
      } finally {
        refreshButton.disabled = false;
      }
    }
    refreshButton.addEventListener("click", load);
    return { load };
  }

  // ---------- Seções ----------

  const panels = Object.fromEntries($$("[data-section-panel]").map((panel) => [panel.dataset.sectionPanel, panel]));
  const sections = {
    providers: createListSection({
      panel: panels.providers,
      initialFilter: "pending",
      path: (filter, offset, limit) =>
        `/api/v1/admin/providers?${new URLSearchParams({ status: filter, limit, offset })}`,
      renderItem: renderProvider,
      emptyMessages: {
        pending: "Nenhuma prestadora aguardando aprovação.",
        active: "Nenhuma prestadora aprovada ainda.",
        rejected: "Nenhuma prestadora recusada.",
      },
    }),
    verifications: createListSection({
      panel: panels.verifications,
      initialFilter: "pending",
      path: (filter, offset, limit) =>
        `/api/v1/admin/verifications?${new URLSearchParams({ result: filter, limit, offset })}`,
      renderItem: renderVerification,
      emptyMessages: {
        pending: "Nenhuma verificação aguardando revisão.",
        approved: "Nenhuma verificação aprovada ainda.",
        rejected: "Nenhuma verificação recusada.",
      },
    }),
    plans: createPlansSection(panels.plans),
    categories: createCategoriesSection(panels.categories),
  };
  const loaded = new Set();

  function openSection(name) {
    elements.sectionLinks.forEach((link) => {
      if (link.dataset.section === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    Object.entries(panels).forEach(([key, panel]) => { panel.hidden = key !== name; });
    if (!loaded.has(name)) {
      loaded.add(name);
      sections[name].load();
    }
  }

  elements.sectionLinks.forEach((link) => link.addEventListener("click", () => openSection(link.dataset.section)));

  // ---------- Login e logout ----------

  function showLogin(message) {
    clearSession();
    loaded.clear();
    elements.appView.hidden = true;
    elements.loginView.hidden = false;
    elements.loginError.hidden = !message;
    elements.loginError.textContent = message ?? "";
    elements.loginPassword.value = "";
    elements.loginEmail.focus();
  }

  function showApp() {
    elements.loginView.hidden = true;
    elements.appView.hidden = false;
    elements.adminName.textContent = session.user?.name ?? session.user?.email ?? "";
    openSection("providers");
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = elements.loginEmail.value.trim();
    const password = elements.loginPassword.value;
    if (!email || !password) {
      elements.loginError.textContent = "Informe e-mail e senha.";
      elements.loginError.hidden = false;
      return;
    }
    elements.loginSubmit.disabled = true;
    elements.loginSubmit.textContent = "Entrando...";
    elements.loginError.hidden = true;
    try {
      saveSession(await request("POST", "/api/v1/admin/session", { email, password }));
      elements.loginPassword.value = "";
      showApp();
    } catch (error) {
      elements.loginError.textContent = error.message;
      elements.loginError.hidden = false;
    } finally {
      elements.loginSubmit.disabled = false;
      elements.loginSubmit.textContent = "Entrar";
    }
  });

  elements.logoutButton.addEventListener("click", async () => {
    const refreshToken = session?.refreshToken;
    if (refreshToken) await request("POST", "/api/v1/admin/session/logout", { refreshToken }).catch(() => {});
    showLogin();
  });

  if (session?.accessToken) showApp();
  else showLogin();
})();
