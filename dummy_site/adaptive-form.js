/*
 * Adaptive form embed. Drop it into any landing page:
 *
 *   <div id="adaptive-form"></div>
 *   <script src="adaptive-form.js"
 *           data-api="https://marketing-form.example.com"
 *           data-site-id="my-landing-page"
 *           data-schema="schema.json"></script>
 *
 * Optional attributes: data-target (CSS selector, default #adaptive-form),
 * data-submit-to (your endpoint that receives the lead as JSON), data-success-message.
 * A successful submit also dispatches an `adaptive-form:submit` DOM event with the values.
 *
 * It detects visitor signals, asks the bandit API which form variant to show,
 * renders it, and reports the outcome: reward 1 on submit, 0 if the visitor leaves.
 * `?api=` and `?site=` in the page URL override the attributes (handy for testing).
 */
(function () {
  "use strict";

  const script = document.currentScript;
  const attr = (name, fallback) => (script && script.dataset[name]) || fallback;
  const params = new URLSearchParams(location.search);
  const API = (params.get("api") || attr("api", "http://localhost:8000")).replace(/\/+$/, "");
  const SITE_ID = params.get("site") || attr("siteId", location.hostname || "default");
  const SCHEMA_URL = attr("schema", "");
  const TARGET = attr("target", "#adaptive-form");
  const SUCCESS = attr("successMessage", "Thanks! We'll be in touch shortly.");
  // Optional: your own endpoint that receives the lead as JSON (CRM, email service, etc.).
  const SUBMIT_TO = attr("submitTo", "");

  const FIELD_DEFS = {
    email: { label: "Email", type: "email", placeholder: "you@example.com", autocomplete: "email" },
    work_email: { label: "Work email", type: "email", placeholder: "you@company.com", autocomplete: "email" },
    name: { label: "Full name", type: "text", placeholder: "Jane Doe", autocomplete: "name" },
    team_name: { label: "Team name", type: "text", placeholder: "Growth team", autocomplete: "organization" },
    company_size: { label: "Company size", type: "select", options: ["1-10", "11-50", "51-200", "201-1000", "1000+"] },
    role: { label: "Role", type: "select", options: ["Marketing", "Sales", "Engineering", "Founder / Exec", "Other"] },
  };

  const STYLES = `
    .af-form h2 { margin: 0 0 16px; font-size: 22px; }
    .af-field { margin-bottom: 14px; }
    .af-field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .af-field input, .af-field select { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; background: #fff; }
    .af-submit { width: 100%; padding: 12px; border: 0; border-radius: 6px; background: #4f46e5; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .af-submit:disabled { opacity: .6; cursor: wait; }
    .af-error { color: #dc2626; font-size: 13px; }
    .af-theme-compact .af-submit { background: #16a34a; }
    .af-theme-enterprise .af-submit { background: #0f172a; }
    .af-theme-social .af-submit { background: #db2777; }`;

  const state = { variant: null, signals: [], outcomeSent: false, status: "loading", error: null };
  // Exposed so automated tests (e.g. Puppeteer) can read what the form decided.
  window.__adaptiveForm = state;

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function setStatus(status) {
    state.status = status;
    document.body.dataset.state = status;
  }

  function detectSignals() {
    const signals = ["page_view"];
    if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia("(max-width: 768px)").matches) {
      signals.push("mobile");
    }
    const key = `af_visited_${SITE_ID}`;
    try {
      if (localStorage.getItem(key)) signals.push("returning_visitor");
      localStorage.setItem(key, String(Date.now()));
    } catch { /* storage blocked */ }

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
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  async function decide(signals) {
    let r = await postJSON(`/sites/${SITE_ID}/decide`, { signals });
    if (r.status === 404 && SCHEMA_URL) {
      // Bandit state is in-memory, so register the site's schema if the API doesn't know it yet.
      const schema = await (await fetch(SCHEMA_URL)).json();
      await postJSON(`/sites/${SITE_ID}/schema`, schema);
      r = await postJSON(`/sites/${SITE_ID}/decide`, { signals });
    }
    if (!r.ok) throw new Error(r.data.error || `decide failed (${r.status})`);
    return r.data;
  }

  function renderField(name) {
    const def = FIELD_DEFS[name] || { label: name.replace(/_/g, " "), type: "text" };
    let input;
    if (def.type === "select") {
      input = el("select");
      input.add(new Option("Select…", ""));
      def.options.forEach((o) => input.add(new Option(o, o)));
    } else {
      input = el("input", { type: def.type, placeholder: def.placeholder || "", autocomplete: def.autocomplete || "on" });
    }
    Object.assign(input, { id: `af-${name}`, name, required: true });
    return el("div", { className: "af-field" }, [el("label", { htmlFor: input.id, textContent: def.label }), input]);
  }

  function validate(form) {
    for (const f of form.elements) {
      if (!f.name) continue;
      const v = f.value.trim();
      if (!v) return `Please fill in ${FIELD_DEFS[f.name]?.label || f.name}.`;
      if (f.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "Please enter a valid email address.";
    }
    return null;
  }

  function sendBounce() {
    if (!state.variant || state.outcomeSent) return;
    state.outcomeSent = true;
    const body = JSON.stringify({ variant: state.variant, signals: state.signals, reward: 0.0 });
    const url = `${API}/sites/${SITE_ID}/reward`;
    // text/plain keeps it a CORS "simple" request, which sendBeacon requires cross-origin.
    if (!navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) {
      fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  }

  function mount(root, variant) {
    const error = el("p", { className: "af-error", hidden: true, role: "alert" });
    const submit = el("button", { type: "submit", className: "af-submit", textContent: variant.button_text || "Submit" });
    const form = el("form", { className: `af-form af-theme-${variant.theme || "default"}`, noValidate: true }, [
      el("h2", { textContent: variant.headline || "Get in touch" }),
      ...(variant.fields || ["email"]).map(renderField),
      error,
      submit,
    ]);
    form.dataset.variant = state.variant;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = validate(form);
      error.hidden = !err;
      error.textContent = err || "";
      if (err || state.outcomeSent) return;
      submit.disabled = true;
      state.outcomeSent = true;
      const values = Object.fromEntries(new FormData(form));
      try {
        if (SUBMIT_TO) {
          const lead = await fetch(SUBMIT_TO, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...values, variant: state.variant, signals: state.signals }),
          });
          if (!lead.ok) throw new Error(`lead submission failed (${lead.status})`);
        }
        const r = await postJSON(
          `/sites/${SITE_ID}/reward`,
          { variant: state.variant, signals: state.signals, reward: 1.0 },
          { keepalive: true }
        );
        if (!r.ok) throw new Error(r.data.error || `reward failed (${r.status})`);
        root.dispatchEvent(
          new CustomEvent("adaptive-form:submit", { bubbles: true, detail: { values, variant: state.variant, signals: state.signals } })
        );
        root.replaceChildren(el("div", { className: "af-success" }, [el("h2", { textContent: SUCCESS })]));
        setStatus("converted");
      } catch (ex) {
        state.outcomeSent = false;
        state.error = String(ex);
        submit.disabled = false;
        error.hidden = false;
        error.textContent = "Something went wrong, please try again.";
      }
    });
    root.replaceChildren(form);
  }

  async function init() {
    const root = document.querySelector(TARGET);
    if (!root) return console.warn(`[adaptive-form] no element matches ${TARGET}`);
    document.head.append(el("style", { textContent: STYLES }));
    state.signals = detectSignals();
    try {
      const data = await decide(state.signals);
      state.variant = data.selected_variant;
      mount(root, data.fields || {});
      addEventListener("pagehide", sendBounce);
      setStatus("ready");
    } catch (ex) {
      state.error = String(ex);
      root.textContent = "Sorry, the form is unavailable right now.";
      setStatus("error");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
