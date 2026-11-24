# Add adaptive forms to your landing page with Juju

The service picks which form variant to show each visitor. It uses a contextual bandit (LinUCB)
and learns from whether visitors submit the form or leave. Its state lives in **your existing
PostgreSQL**. You deploy it with Juju next to your other workloads, then add one script tag to
your landing page. No code changes are needed.

```
 your landing page                   your Kubernetes cluster (Juju model)
 + adaptive-form.js ──── HTTP ────▶  ingress ─▶ marketing-form-dynamic-optimization ─▶ postgresql-k8s
   (1) which form?                    (nginx-ingress-   (this charm: Flask + LinUCB)     (bandit state)
   (2) submit → reward 1                integrator)
   (3) leave  → reward 0
```

## 1. Build the rock and the charm

You'll need [`rockcraft`](https://documentation.ubuntu.com/rockcraft/) and
[`charmcraft`](https://documentation.ubuntu.com/charmcraft/), plus a container registry your
cluster can pull from. The commands below use an in-cluster registry on `localhost:32000`.

```bash
rockcraft pack
rockcraft.skopeo --insecure-policy copy --dest-tls-verify=false \
  oci-archive:marketing-form-dynamic-optimization_0.7_amd64.rock \
  docker://localhost:32000/marketing-form-dynamic-optimization:0.7
(cd charm && charmcraft pack)
```

## 2. Deploy with Juju

```bash
juju add-model marketing-form-dynamic-optimization

juju deploy ./charm/marketing-form-dynamic-optimization_amd64.charm \
  --resource flask-app-image=localhost:32000/marketing-form-dynamic-optimization:0.7

# Your existing backend: deploy postgresql-k8s, or integrate with the one you already run
# (use `juju consume` / cross-model relations if it lives in another model).
juju deploy postgresql-k8s --channel 14/stable --trust
juju integrate marketing-form-dynamic-optimization postgresql-k8s

# Make it reachable.
juju deploy nginx-ingress-integrator --channel latest/stable --trust
juju config nginx-ingress-integrator service-hostname=marketing-form   # or your real hostname
juju integrate marketing-form-dynamic-optimization nginx-ingress-integrator

juju status --relations          # wait until everything is active
```

That's the whole integration:
- **Postgres:** the charm requests a database, receives the credentials, and passes them to the
  app as `POSTGRESQL_DB_CONNECT_STRING`. The app creates its `bandit_state` table and saves every
  update there. Learning survives restarts and upgrades, and all units share one state when you
  `juju scale-application`.
- **Ingress:** the charm publishes its address to the ingress, including after pod restarts.

Check it works:

```bash
curl -H 'Host: marketing-form' http://<ingress-ip>/   # {"status": "active", ...}
```

### Configuration (`juju config marketing-form-dynamic-optimization <key>=<value>`)

| Key | Default | Purpose |
|---|---|---|
| `allowed-origins` | `*` | The browser origin of your landing page, e.g. `https://www.example.com`. Only one origin is supported. |
| `exploration-alpha` | `0.5` | How much the bandit explores (0–1). Higher values try under-performing variants more often. |
| `default-site-schema` | empty | Optional fallback schema for sites that haven't registered their own. Leave it empty so each page registers its own. |
| `enable-llm-validation`, `openrouter-api-key`, `openrouter-model` | off | Optional LLM sanity check of each decision. When enabled, every page view calls OpenRouter, a third-party service. |

### Actions

```bash
juju run marketing-form-dynamic-optimization/0 reset-bandit-weights site-id=my-landing-page   # or omit site-id for all sites
juju run marketing-form-dynamic-optimization/0 test-openrouter
```

### Updating

To ship a new version, bump `version` in `rockcraft.yaml`, rebuild and push the rock, then run:

```bash
juju refresh marketing-form-dynamic-optimization \
  --path ./charm/marketing-form-dynamic-optimization_amd64.charm \
  --resource flask-app-image=localhost:32000/marketing-form-dynamic-optimization:<version>
```

## 3. Describe your form variants (`schema.json`)

```json
{
  "signals": ["page_view", "mobile", "returning_visitor", "enterprise_domain", "paid_ad_click"],
  "variants": {
    "short":    { "headline": "Get started in 30 seconds", "button_text": "Get access",
                  "fields": ["email"], "theme": "compact" },
    "detailed": { "headline": "Get a tailored walkthrough", "button_text": "Request a walkthrough",
                  "fields": ["name", "work_email", "company_size", "role"], "theme": "enterprise" }
  }
}
```

- **signals**: what the bandit may condition on. The embed detects these five automatically:

  | Signal | Detected from |
  |---|---|
  | `page_view` | always present |
  | `mobile` | user agent, or a viewport ≤ 768px |
  | `returning_visitor` | a previous visit, remembered in localStorage |
  | `paid_ad_click` | `utm_medium=cpc\|ppc\|paid\|paid_social`, `gclid` or `fbclid` |
  | `enterprise_domain` | `utm_campaign` containing `abm` or `enterprise`, or a LinkedIn referrer |

- **fields**: `email`, `work_email`, `name`, `team_name`, `company_size` and `role` get proper
  labels and input types. Any other name renders as a text input.
- **theme**: `compact`, `enterprise` or `social`. You can restyle everything through the `.af-*`
  CSS classes.

## 4. Add the form to your landing page

Copy [`dummy_site/adaptive-form.js`](dummy_site/adaptive-form.js) and your `schema.json` next to
your page. Then add:

```html
<div id="adaptive-form"></div>

<script src="/adaptive-form.js"
        data-api="https://marketing-form.example.com"
        data-site-id="my-landing-page"
        data-schema="/schema.json"
        data-submit-to="https://<your-backend>/leads"></script>
```

| Attribute | Required | Meaning |
|---|---|---|
| `data-api` | yes | URL of the ingress from step 2 |
| `data-site-id` | recommended | Any stable id for this page (default: the page's hostname). Each id learns separately. |
| `data-schema` | recommended | URL of `schema.json`. The site is registered with it automatically the first time. |
| `data-submit-to` | no | Your endpoint that receives the lead as JSON (`{...fields, variant, signals}`). If it fails, the visitor sees an error and no conversion is recorded. |
| `data-target` | no | CSS selector of the container (default `#adaptive-form`) |
| `data-success-message` | no | Text shown after a successful submit |

You can also listen for the `adaptive-form:submit` DOM event (`e.detail.values`,
`e.detail.variant`) to forward leads to your CRM or analytics.

[`dummy_site/index.html`](dummy_site/index.html) is a complete sample page.

## 5. Test it with simulated visitors

```bash
cd simulation && npm install     # Node 18+
node simulate.js --url https://www.example.com/landing --api https://marketing-form.example.com \
  --schema ../path/to/schema.json --visitors 200
```

Each visitor gets a fresh Chrome browser and a random traffic profile, then fills in and
submits the form or leaves the page. The report checks three things:
- signal detection;
- that the API received exactly one decision and one reward per visitor;
- how close the bandit gets to the best variant for each segment, against a hidden synthetic
  conversion model.

Each run uses its own `sim-<timestamp>` site id, so your real page's learning is not touched. If
you set `data-submit-to`, simulated leads will reach that endpoint, so point it at a test
endpoint while simulating.

## Security notes

- **The API has no authentication.** Anyone who can reach it can register or reset a site's
  schema, or send fake rewards. Expose it only through your ingress, and set `allowed-origins`
  to your page's origin. That stops other websites' browsers from calling it, but not scripts.
- **Never set `flask-debug=true` on a reachable deployment.** Flask's debugger lets anyone run
  code.
