(function () {
  "use strict";

  const cfg = window.ADAPTIVE_FORM_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const API = (params.get("api") || cfg.apiBase || "http://localhost:8000").replace(/\/+$/, "");
  const SITE_ID = params.get("site") || cfg.siteId || "nimbus-landing";

  const FIELD_DEFS = {
    email: { label: "Email", type: "email", placeholder: "you@example.com", autocomplete: "email" },
    work_email: { label: "Work email", type: "email", placeholder: "you@company.com", autocomplete: "email" },
    name: { label: "Full name", type: "text", placeholder: "Jane Doe", autocomplete: "name" },
    team_name: { label: "Team name", type: "text", placeholder: "Growth team", autocomplete: "organization" },
    company_size: { label: "Company size", type: "select", options: ["1-10", "11-50", "51-200", "201-1000", "1000+"] },
    role: { label: "Role", type: "select", options: ["Marketing", "Sales", "Engineering", "Founder / Exec", "Other"] },
  };

  const $ = (id) => document.getElementById(id);
  const state = { variant: null, signals: [], outcomeSent: false, status: "loading", error: null };
  // Exposed so automated tests (Puppeteer) can read what the page decided.
  window.__adaptiveForm = state;

  function setStatus(status) {
    state.status = status;
    document.body.dataset.state = status;
  }

  function detectSignals() {
    const signals = ["page_view"];
    const ua = navigator.userAgent || "";
    if (/Mobi|Android|iPhone|iPad/i.test(ua) || window.matchMedia("(max-width: 768px)").matches) {
      signals.push("mobile");
    }
    if (localStorage.getItem("nimbus_visited")) signals.push("returning_visitor");
    localStorage.setItem("nimbus_visited", String(Date.now()));

    const campaign = (params.get("utm_campaign") || "").toLowerCase();
    if (campaign.includes("abm") || campaign.includes("enterprise") || /linkedin\.com/i.test(document.referrer)) {
      signals.push("enterprise_domain");
    }
    const medium = (params.get("utm_medium") || "").toLowerCase();
    if (["cpc", "ppc", "paid", "paid_social"].includes(medium) || params.has("gclid") || params.has("fbclid")) {
      signals.push("paid_ad_click");
    }
    return signals;
  }

  async function postJSON(path, body, opts = {}) {
    const res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function decide(signals) {
    let r = await postJSON(`/sites/${SITE_ID}/decide`, { signals });
    if (r.status === 404) {
      // Bandit state is in-memory, so register the site's schema if the API doesn't know it yet.
      const schema = await (await fetch("schema.json")).json();
      await postJSON(`/sites/${SITE_ID}/schema`, schema);
      r = await postJSON(`/sites/${SITE_ID}/decide`, { signals });
    }
    if (!r.ok) throw new Error(r.data.error || `decide failed (${r.status})`);
    return r.data;
  }

  function renderField(name) {
    const def = FIELD_DEFS[name] || { label: name.replace(/_/g, " "), type: "text" };
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `f-${name}`;
    label.textContent = def.label;
    let input;
    if (def.type === "select") {
      input = document.createElement("select");
      input.add(new Option("Select…", ""));
      def.options.forEach((o) => input.add(new Option(o, o)));
    } else {
      input = document.createElement("input");
      input.type = def.type;
      if (def.placeholder) input.placeholder = def.placeholder;
      if (def.autocomplete) input.autocomplete = def.autocomplete;
    }
    input.id = `f-${name}`;
    input.name = name;
    input.required = true;
    wrap.append(label, input);
    return wrap;
  }

  function renderForm(variant) {
    const form = $("lead-form");
    form.className = `theme-${variant.theme || "default"}`;
    form.dataset.variant = state.variant;
    $("form-headline").textContent = variant.headline || "Sign up";
    $("form-submit").textContent = variant.button_text || "Submit";
    const fields = $("form-fields");
    fields.replaceChildren(...(variant.fields || ["email"]).map(renderField));
    $("form-loading").hidden = true;
    form.hidden = false;
  }

  function validate(form) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = el.value.trim();
      if (!v) return `Please fill in ${FIELD_DEFS[el.name]?.label || el.name}.`;
      if (el.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "Please enter a valid email address.";
    }
    return null;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const err = validate(form);
    $("form-error").hidden = !err;
    $("form-error").textContent = err || "";
    if (err || state.outcomeSent) return;

    $("form-submit").disabled = true;
    state.outcomeSent = true;
    try {
      const r = await postJSON(
        `/sites/${SITE_ID}/reward`,
        { variant: state.variant, signals: state.signals, reward: 1.0 },
        { keepalive: true }
      );
      if (!r.ok) throw new Error(r.data.error || `reward failed (${r.status})`);
      form.hidden = true;
      $("form-success").hidden = false;
      setStatus("converted");
    } catch (ex) {
      state.outcomeSent = false;
      state.error = String(ex);
      $("form-submit").disabled = false;
      $("form-error").hidden = false;
      $("form-error").textContent = "Something went wrong, please try again.";
    }
  }

  // Visitor left without converting -> reward 0. text/plain keeps it a CORS "simple" request.
  function sendBounce() {
    if (!state.variant || state.outcomeSent) return;
    state.outcomeSent = true;
    const body = JSON.stringify({ variant: state.variant, signals: state.signals, reward: 0.0 });
    const url = `${API}/sites/${SITE_ID}/reward`;
    if (!navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) {
      fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  }

  async function init() {
    state.signals = detectSignals();
    try {
      const data = await decide(state.signals);
      state.variant = data.selected_variant;
      renderForm(data.fields || {});
      $("lead-form").addEventListener("submit", onSubmit);
      window.addEventListener("pagehide", sendBounce);
      setStatus("ready");
    } catch (ex) {
      state.error = String(ex);
      $("form-loading").textContent = "Sorry, the form is unavailable right now.";
      setStatus("error");
    }
  }

  init();
})();
