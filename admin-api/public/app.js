// Painel de aprovação de prestadoras (SheServe Admin).
// Fala só com a própria admin-api (mesma origem). Todo dado vindo da API é
// inserido com textContent, nunca como HTML.
(() => {
  "use strict";

  const SESSION_KEY = "sheserve-admin-session";
  const PAGE_SIZE = 50;

  const STATUS_LABELS = { pending: "Pendente", active: "Aprovada", rejected: "Recusada" };
  const EMPTY_MESSAGES = {
    pending: "Nenhuma prestadora aguardando aprovação.",
    active: "Nenhuma prestadora aprovada ainda.",
    rejected: "Nenhuma prestadora recusada.",
  };
  const LOCATION_LABELS = { at_customer: "vai até a cliente", at_provider: "recebe no espaço" };
  const PRICE_TYPE_LABELS = { fixed: "", from: "a partir de ", evaluation: "sob avaliação" };
  const ERROR_MESSAGES = {
    invalid_credentials: "E-mail ou senha inválidos.",
    forbidden: "Esta conta não tem acesso de administrador.",
    rate_limited: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
    upstream_unavailable: "O serviço de login não respondeu. Tente novamente em instantes.",
    not_configured: "O painel não está configurado (MARKETPLACE_API_URL).",
  };

  const elements = {
    loginView: document.getElementById("login-view"),
    loginForm: document.getElementById("login-form"),
    loginEmail: document.getElementById("login-email"),
    loginPassword: document.getElementById("login-password"),
    loginError: document.getElementById("login-error"),
    loginSubmit: document.getElementById("login-submit"),
    appView: document.getElementById("app-view"),
    adminName: document.getElementById("admin-name"),
    logoutButton: document.getElementById("logout-button"),
    refreshButton: document.getElementById("refresh-button"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    listStatus: document.getElementById("list-status"),
    list: document.getElementById("provider-list"),
    loadMore: document.getElementById("load-more"),
    toast: document.getElementById("toast"),
    cardTemplate: document.getElementById("provider-card-template"),
  };

  const state = { status: "pending", offset: 0, loading: false };
  let toastTimer;

  // ---------- Sessão ----------

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Sem armazenamento (ex.: janela privada restrita): a sessão vale até recarregar.
    }
    memorySession = session;
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignorado */
    }
    memorySession = null;
  }

  let memorySession = readSession();

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
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
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
    if (!memorySession) throw new ApiError(401, "unauthorized", "Faça login.");
    try {
      return await request(method, path, body, memorySession.accessToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      try {
        saveSession(await request("POST", "/api/v1/admin/session/refresh", {
          refreshToken: memorySession.refreshToken,
        }));
      } catch {
        showLogin("Sua sessão expirou. Entre novamente.");
        throw error;
      }
      return request(method, path, body, memorySession.accessToken);
    }
  }

  // ---------- Telas ----------

  function showLogin(message) {
    clearSession();
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
    elements.adminName.textContent = memorySession.user?.name ?? memorySession.user?.email ?? "";
    loadProviders({ reset: true });
  }

  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => {
      elements.toast.hidden = true;
    }, 4000);
  }

  // ---------- Lista ----------

  const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" });
  const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

  function formatPhone(phone) {
    const match = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(phone ?? "");
    return match ? `+55 (${match[1]}) ${match[2]}-${match[3]}` : phone ?? "—";
  }

  function serviceDescription(service) {
    const parts = [service.category];
    if (service.priceType === "evaluation") parts.push("sob avaliação");
    else parts.push(`${PRICE_TYPE_LABELS[service.priceType] ?? ""}${currencyFormatter.format(service.basePrice)}`);
    parts.push(LOCATION_LABELS[service.serviceLocation] ?? service.serviceLocation);
    return parts.filter(Boolean).join(" · ");
  }

  function renderProvider(provider) {
    const card = elements.cardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.providerId = provider.id;
    card.querySelector(".card-name").textContent = provider.name;
    card.querySelector(".card-meta").textContent = `Cadastro em ${dateFormatter.format(new Date(provider.createdAt))}`;

    const badge = card.querySelector(".badge");
    badge.textContent = STATUS_LABELS[provider.activationStatus] ?? provider.activationStatus;
    badge.classList.add(provider.activationStatus);

    card.querySelector(".card-email").textContent = provider.email;
    card.querySelector(".card-phone").textContent = formatPhone(provider.phone);
    card.querySelector(".card-identity").textContent = provider.identityVerified ? "Verificada" : "Não verificada";

    const bio = card.querySelector(".card-bio");
    bio.textContent = provider.bio?.trim() || "Sem descrição.";
    bio.classList.toggle("empty", !provider.bio?.trim());

    const services = provider.services ?? [];
    card.querySelector(".card-services-title").textContent =
      services.length === 1 ? "1 serviço" : `${services.length} serviços`;
    const serviceList = card.querySelector(".card-services");
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

    wireActions(card, provider);
    return card;
  }

  function wireActions(card, provider) {
    const approveButton = card.querySelector(".action-approve");
    const rejectButton = card.querySelector(".action-reject");
    const rejectForm = card.querySelector(".reject-form");
    const reasonInput = card.querySelector(".reject-reason");

    // Só mostra a ação que muda o status atual
    approveButton.hidden = provider.activationStatus === "active";
    rejectButton.hidden = provider.activationStatus === "rejected";
    if (provider.activationStatus !== "pending") {
      approveButton.textContent = "Reativar e aprovar";
      rejectButton.textContent = "Recusar e remover das buscas";
    }

    approveButton.addEventListener("click", () =>
      changeApproval(card, provider, { status: "active" }, [approveButton, rejectButton]));

    rejectButton.addEventListener("click", () => {
      rejectForm.hidden = false;
      rejectButton.hidden = true;
      approveButton.hidden = true;
      reasonInput.focus();
    });

    card.querySelector(".action-cancel").addEventListener("click", () => {
      rejectForm.hidden = true;
      wireVisibilityReset();
    });

    rejectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const reason = reasonInput.value.trim();
      if (!reason) {
        reasonInput.focus();
        showToast("Informe o motivo da recusa.", true);
        return;
      }
      changeApproval(card, provider, { status: "rejected", reason },
        Array.from(rejectForm.querySelectorAll("button")));
    });

    function wireVisibilityReset() {
      approveButton.hidden = provider.activationStatus === "active";
      rejectButton.hidden = provider.activationStatus === "rejected";
    }
  }

  async function changeApproval(card, provider, change, buttons) {
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await api("PATCH", `/api/v1/admin/providers/${encodeURIComponent(provider.id)}/approval`, change);
      card.remove();
      showToast(change.status === "active"
        ? `${provider.name} foi aprovada e já aparece nas buscas.`
        : `${provider.name} foi recusada. Ela será notificada no app.`);
      if (!elements.list.querySelector(".card")) renderEmpty();
    } catch (error) {
      if (error.status !== 401) showToast(error.message, true);
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function renderEmpty() {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = EMPTY_MESSAGES[state.status];
    elements.list.replaceChildren(empty);
    elements.listStatus.textContent = "";
  }

  async function loadProviders({ reset }) {
    if (state.loading) return;
    state.loading = true;
    if (reset) {
      state.offset = 0;
      elements.list.replaceChildren();
    }
    elements.loadMore.hidden = true;
    elements.listStatus.textContent = "Carregando...";
    elements.refreshButton.disabled = true;

    try {
      const query = new URLSearchParams({ status: state.status, limit: String(PAGE_SIZE), offset: String(state.offset) });
      const page = await api("GET", `/api/v1/admin/providers?${query}`);
      const items = page?.items ?? [];
      if (reset && items.length === 0) {
        renderEmpty();
        return;
      }
      elements.list.append(...items.map(renderProvider));
      state.offset += items.length;
      elements.loadMore.hidden = items.length < PAGE_SIZE;
      elements.listStatus.textContent = "";
    } catch (error) {
      if (error.status !== 401) elements.listStatus.textContent = `Não foi possível carregar: ${error.message}`;
    } finally {
      state.loading = false;
      elements.refreshButton.disabled = false;
    }
  }

  // ---------- Eventos ----------

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
    const refreshToken = memorySession?.refreshToken;
    if (refreshToken) {
      await request("POST", "/api/v1/admin/session/logout", { refreshToken }).catch(() => {});
    }
    showLogin();
  });

  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (state.loading || tab.dataset.status === state.status) return;
      state.status = tab.dataset.status;
      elements.tabs.forEach((other) => other.setAttribute("aria-pressed", String(other === tab)));
      loadProviders({ reset: true });
    });
  });

  elements.refreshButton.addEventListener("click", () => loadProviders({ reset: true }));
  elements.loadMore.addEventListener("click", () => loadProviders({ reset: false }));

  // ---------- Início ----------

  if (memorySession?.accessToken) showApp();
  else showLogin();
})();
