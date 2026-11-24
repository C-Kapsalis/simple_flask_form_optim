from mimetypes import init
import os
import json
import logging
from contextlib import contextmanager
import numpy as np 
from flask import Flask, request, jsonify
from flask import render_template_string
from prometheus_flask_exporter import PrometheusMetrics
import requests
import psycopg2
from psycopg2.extras import Json

logger = logging.getLogger(__name__)

DB_URI = os.getenv("POSTGRESQL_DB_CONNECT_STRING") or os.getenv("DATABASE_URI")


def get_db(): 
    if DB_URI: 
        return psycopg2.connect(DB_URI)
    return None

def init_db():
    conn = get_db()
    if conn:
        with conn.cursor() as cur:
            # Serialise concurrent CREATEs from several workers/units starting at once.
            cur.execute("SELECT pg_advisory_xact_lock(7212001)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS bandit_state (
                    site_id VARCHAR(128) PRIMARY KEY,
                    weights_json JSONB,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
        conn.commit()
        conn.close()


@contextmanager
def db_transaction():
    """Yield a cursor inside a transaction that commits on success and rolls back on error."""
    conn = get_db()
    try:
        with conn:
            with conn.cursor() as cur:
                yield cur
    finally:
        conn.close()


def load_site(cur, site_id, for_update=False):
    query = "SELECT weights_json FROM bandit_state WHERE site_id = %s"
    cur.execute(query + (" FOR UPDATE" if for_update else ""), (site_id,))
    row = cur.fetchone()
    return row[0] if row else None


def save_site(cur, site_id, site):
    cur.execute(
        """
        INSERT INTO bandit_state (site_id, weights_json, updated_at)
        VALUES (%s, %s, CURRENT_TIMESTAMP)
        ON CONFLICT (site_id)
        DO UPDATE SET weights_json = EXCLUDED.weights_json, updated_at = CURRENT_TIMESTAMP
        """,
        (site_id, Json(site)),
    )
                                                   
app = Flask(__name__)
# reads FLASK_* variables automatically

# 12-factor config: loads FLASK_* env variables
app.config.from_prefixed_env()

# Prometheus metrics setup 
metrics = PrometheusMetrics(app)
metrics.info("app_info", "Application info", version='0.1.0')

signal_counter = metrics.counter(
    'adaptive_form_signal_total', 
    'Total template signals received per site',
    labels={'site_id': lambda: request.view_args.get('site_id', 'unknown')}
)

decision_counter = metrics.counter(
    'adaptive_form_decision_total', 
    'Total form variant decisions made per site',
    labels={'site_id': lambda: request.view_args.get('site_id', 'unknown')}
)

conversion_counter = metrics.counter(
    'adaptive_form_conversion_total', 
    'Total conversions registered per site',
    labels={'site_id': lambda: request.view_args.get('site_id', 'unknown')}
)

class DynamicLinUCB:
    """Contextual multi-armed bandint implementing Linear Upper Confidence Bound (LinUCB) algorithm."""
    def __init__(self, alpha=0.5):
        self.alpha = float(alpha)
        self.sites = {} 

    def register_site(self, site_id, signals, variants):
        d = len(signals)
        self.sites[site_id] = {
            "signals": signals,
            "variants": variants,
            "d": d,
            "A": {v: np.identity(d).tolist() for v in variants.keys()},
            "b": {v: np.zeros((d, 1)).tolist() for v in variants.keys()}
        }

    def decide(self, site_id, context_signals):
        # Fallback to default schema if site not registered
        if site_id not in self.sites:
            if "default" in self.sites:
                site = self.sites["default"]
            else:
                return None, "Site not registered and no default schema configured"
        else:
            site = self.sites[site_id]

        signals = site["signals"]
        d = site["d"]
        x = np.array([1.0 if s in context_signals else 0.0 for s in signals]).reshape((d, 1))

        best_score = -float("inf")
        best_variant = list(site["variants"].keys())

        for variant in site["variants"].keys():
            A = np.array(site["A"][variant])
            b = np.array(site["b"][variant])
            A_inv = np.linalg.inv(A)
            theta = np.dot(A_inv, b)

            expected_payoff = float(np.dot(theta.T, x).item())
            confidence_bound = self.alpha * np.sqrt(np.dot(np.dot(x.T, A_inv), x).item())
            score = expected_payoff + confidence_bound
            if score > best_score:
                best_score = score
                best_variant = variant

        return best_variant, site["variants"][best_variant]

    def update_reward(self, site_id, variant, context_signals, reward):
        target_site = site_id if site_id in self.sites else "default"
        if target_site not in self.sites or variant not in self.sites[target_site]['variants']:
            return False

        site = self.sites[target_site]
        d = site["d"]
        x = np.array([1.0 if s in context_signals else 0.0 for s in site['signals']]).reshape((d, 1))

        A = np.array(site['A'][variant])
        b = np.array(site['b'][variant])

        A += np.dot(x, x.T)
        b += float(reward) * x 

        site['A'][variant] = A.tolist()
        site['b'][variant] = b.tolist()

        return True 


def validate_form_with_openrouter(variant_name, fields, context_signals):
    """Optionally validate the bandit selection with an OpenRouter LLM."""
    api_key = app.config.get("OPENROUTER_API_KEY")
    model = app.config.get("OPENROUTER_MODEL", "meta-llama/llama-3-8b-instruct")

    if not api_key:
        return {"valid": True, "warning": "No OpenRouter API key provided; skipped validation"}

    prompt = (
        f"You are a UX optimization validator. The user context signals are: {context_signals}. "
        f"The bandit algorithm selected variant '{variant_name}' containing fields: {fields}. "
        f"Does this variant make sense given the user signals? Reply with JSON: {{\"approved\": true/false, \"reason\": \"...\"}}"
    )

    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=5
        )
        data = response.json()
        content = data["choices"][0]["message"]["content"]
        return {"valid": True, "llm_feedback": content}
    except Exception as err:
        return {"valid": True, "warning": f"LLM validation failed: {str(err)}"}


# Initialize bandit with exploration-alpha from Juju config.
# With PostgreSQL configured, the database is the source of truth and `bandit.sites` is unused.
bandit = DynamicLinUCB(alpha=app.config.get("EXPLORATION_ALPHA", 0.5))


def scoped_bandit(sites):
    """A bandit over request-local site state, so concurrent requests never share mutable state."""
    scoped = DynamicLinUCB(alpha=bandit.alpha)
    scoped.sites = sites
    return scoped


def seed_default_schema():
    """Register the 'default' fallback site from Juju config, keeping learned weights if unchanged."""
    raw = app.config.get("DEFAULT_SITE_SCHEMA")
    if not raw:
        return
    try:
        # from_prefixed_env() already JSON-decodes FLASK_DEFAULT_SITE_SCHEMA into a dict.
        parsed = raw if isinstance(raw, dict) else json.loads(raw)
        signals, variants = parsed["signals"], parsed["variants"]
    except Exception as err:
        logger.warning("Ignoring invalid DEFAULT_SITE_SCHEMA: %s", err)
        return

    if not DB_URI:
        bandit.register_site("default", signals, variants)
        return
    with db_transaction() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(7212002)")
        existing = load_site(cur, "default")
        if existing and existing["signals"] == signals and existing["variants"] == variants:
            return
        fresh = scoped_bandit({})
        fresh.register_site("default", signals, variants)
        save_site(cur, "default", fresh.sites["default"])


def reset_bandit_state(site_id=""):
    """Reset A/b matrices (keeping each site's schema) for one site or all. Returns sites reset."""
    if not DB_URI:
        targets = [site_id] if site_id else list(bandit.sites)
        for sid in targets:
            if sid in bandit.sites:
                s = bandit.sites[sid]
                bandit.register_site(sid, s["signals"], s["variants"])
        return [sid for sid in targets if sid in bandit.sites]

    reset = []
    with db_transaction() as cur:
        if site_id:
            cur.execute("SELECT site_id, weights_json FROM bandit_state WHERE site_id = %s FOR UPDATE", (site_id,))
        else:
            cur.execute("SELECT site_id, weights_json FROM bandit_state FOR UPDATE")
        for sid, site in cur.fetchall():
            fresh = scoped_bandit({})
            fresh.register_site(sid, site["signals"], site["variants"])
            save_site(cur, sid, fresh.sites[sid])
            reset.append(sid)
    return reset

@app.after_request
def add_cors_headers(response):
    allowed_origins = app.config.get("ALLOWED_ORIGINS", "*")
    response.headers["Access-Control-Allow-Origin"] = allowed_origins
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response

@app.route("/", methods=["GET"])
def health():
    return jsonify({
        "status": "active", 
        "service": "marketing-form-dynamic-optimization",
        "exploration_alpha": bandit.alpha
    }), 200 

@app.route("/sites/<site_id>/schema", methods=["POST"])
def register_schema(site_id):
    payload = request.get_json(force=True)
    signals = payload.get("signals", [])
    variants = payload.get("variants", {})

    if not signals or not variants:
        return jsonify({"error": "signals and variants are required"}), 400

    if DB_URI:
        scoped = scoped_bandit({})
        scoped.register_site(site_id, signals, variants)
        with db_transaction() as cur:
            save_site(cur, site_id, scoped.sites[site_id])
    else:
        bandit.register_site(site_id, signals, variants)
    return jsonify({"message": f"Site {site_id} registered successfully"}), 201

@app.route("/sites/<site_id>/decide", methods=["POST"])
@signal_counter
@decision_counter
def decide_form(site_id):
    payload = request.get_json(force=True)
    context_signals = payload.get("signals", [])

    if DB_URI:
        with db_transaction() as cur:
            sites = {sid: s for sid in (site_id, "default") if (s := load_site(cur, sid))}
        variant_name, fields = scoped_bandit(sites).decide(site_id, context_signals)
    else:
        variant_name, fields = bandit.decide(site_id, context_signals)
    if variant_name is None:
        return jsonify({"error": fields}), 404

    response_payload = {
        "site_id": site_id,
        "selected_variant": variant_name,
        "fields": fields
    }

    # Run OpenRouter validation if enabled in Juju config
    if app.config.get("ENABLE_LLM_VALIDATION", False):
        validation = validate_form_with_openrouter(variant_name, fields, context_signals)
        response_payload["validation"] = validation

    return jsonify(response_payload), 200

@app.route("/sites/<site_id>/reward", methods=["POST"])
@conversion_counter
def reward_form(site_id):
    payload = request.get_json(force=True)
    variant = payload.get("variant")
    context_signals = payload.get("signals", [])
    reward = payload.get("reward", 1.0)

    if DB_URI:
        with db_transaction() as cur:
            # Row lock makes read-modify-write safe across workers and Juju units.
            site = load_site(cur, site_id, for_update=True)
            target = site_id if site else "default"
            if not site:
                site = load_site(cur, "default", for_update=True)
            scoped = scoped_bandit({target: site} if site else {})
            success = scoped.update_reward(site_id, variant, context_signals, reward)
            if success:
                save_site(cur, target, scoped.sites[target])
    else:
        success = bandit.update_reward(site_id, variant, context_signals, reward)

    if not success:
        return jsonify({"error": "Could not update bandit reward"}), 400

    return jsonify({"message": "Reward registered", "site_id": site_id, "variant": variant}), 200




init_db()
seed_default_schema()

# --- Seed Demo Site Schema ---
DEMO_SITE_ID = "demo-site"
DEMO_SCHEMA = {
    "variants": {
        "variant_a_compact": {
            "headline": "Quick Signup: Start in 30 Seconds",
            "button_text": "Get Instant Access",
            "fields": ["email"],
            "theme": "compact"
        },
        "variant_b_detailed": {
            "headline": "Personalised Marketing Plan",
            "button_text": "Request Custom Analysis",
            "fields": ["name", "email", "company_size", "role"],
            "theme": "enterprise"
        },
        "variant_c_social_proof": {
            "headline": "Join 10,000+ High-Growth Teams",
            "button_text": "Start Free Trial",
            "fields": ["work_email", "team_name"],
            "theme": "social"
        }
    }
}

# --- Demo HTML Template ---
DEMO_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Adaptive Form Playground</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 850px; margin: 30px auto; padding: 20px; background: #0f172a; color: #f8fafc; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 20px; }
    h3 { margin-top: 0; color: #38bdf8; font-size: 16px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    
    /* Interactive Signal Chips */
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 15px; }
    .chip { padding: 6px 12px; border-radius: 20px; font-size: 12px; cursor: pointer; border: 1px solid #475569; background: #0f172a; color: #94a3b8; user-select: none; transition: 0.2s; }
    .chip.active { background: #0284c7; color: white; border-color: #38bdf8; font-weight: 600; }
    
    /* Dynamic Form Preview */
    .form-preview { background: #ffffff; color: #0f172a; border-radius: 8px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
    .form-preview h4 { margin-top: 0; color: #0f172a; font-size: 18px; }
    .field-group { margin-bottom: 12px; }
    .field-group label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 4px; }
    .field-group input { width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 5px; box-sizing: border-box; }
    .btn-submit { width: 100%; background: #16a34a; color: white; border: 0; padding: 10px; border-radius: 5px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .btn-submit:hover { background: #15803d; }
    
    /* Controls & Metrics */
    .btn-row { display: flex; gap: 10px; margin-top: 15px; }
    .btn-action { flex: 1; padding: 8px 12px; border: 0; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; }
    .btn-decide { background: #38bdf8; color: #0f172a; }
    .btn-bounce { background: #ef4444; color: white; }
    .stats-box { font-family: monospace; font-size: 12px; line-height: 1.6; color: #94a3b8; margin-top: 15px; }
    .stats-box b { color: #f8fafc; }
  </style>
</head>
<body>
  <h2>Adaptive Dynamic Form — Interactive Cockpit</h2>
  
  <div class="grid">
    <!-- Left Column: Context Simulator & Actions -->
    <div class="card">
      <h3>1. Select Contextual Signals</h3>
      <p style="font-size: 13px; color: #94a3b8;">Click to toggle visitor attributes. Notice how the bandit changes form fields in response:</p>
      
      <div class="chips" id="signals-container">
        <span class="chip active" onclick="toggleSignal(this, 'page_view')">page_view</span>
        <span class="chip" onclick="toggleSignal(this, 'mobile')">mobile</span>
        <span class="chip" onclick="toggleSignal(this, 'returning_visitor')">returning_visitor</span>
        <span class="chip" onclick="toggleSignal(this, 'enterprise_domain')">enterprise_domain</span>
        <span class="chip" onclick="toggleSignal(this, 'paid_ad_click')">paid_ad_click</span>
      </div>

      <div class="btn-row">
        <button class="btn-action btn-decide" onclick="requestDecision()">Evaluate Bandit (/decide)</button>
        <button class="btn-action btn-bounce" onclick="submitOutcome(0.0)">Log Bounce (Reward 0.0)</button>
      </div>

      <div class="stats-box">
        <h3>Bandit & PostgreSQL State</h3>
        <b>Site ID:</b> demo-site<br>
        <b>Active Variant:</b> <span id="metric-variant" style="color: #38bdf8;">-</span><br>
        <b>Decision Latency:</b> <span id="metric-latency">0 ms</span><br>
        <b>Total Impressions:</b> <span id="metric-impressions">0</span><br>
        <b>Total Conversions:</b> <span id="metric-conversions">0</span><br>
        <b>PostgreSQL Status:</b> <span style="color:#4ade80;">Synchronised</span>
      </div>
    </div>

    <!-- Right Column: Live Form Rendering -->
    <div class="card">
      <h3>2. Live Generated Form</h3>
      <div class="form-preview">
        <h4 id="form-headline">Loading schema...</h4>
        <div id="form-fields"></div>
        <button class="btn-submit" id="form-submit-btn" onclick="submitOutcome(1.0)">Submit & Convert (+1.0)</button>
      </div>
    </div>
  </div>

  <script>
    const siteId = "demo-site";
    let activeVariant = null;
    let impressions = 0;
    let conversions = 0;

    function getActiveSignals() {
      const activeChips = document.querySelectorAll(".chip.active");
      return Array.from(activeChips).map(c => c.innerText.trim());
    }

    function toggleSignal(el, signal) {
      el.classList.toggle("active");
      requestDecision(); // Automatically recalculate and morph the form
    }

    function requestDecision() {
      const signals = getActiveSignals();
      const t0 = performance.now();

      fetch(`/sites/${siteId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signals: signals })
      })
      .then(res => res.json())
      .then(data => {
        const latency = Math.round(performance.now() - t0);
        document.getElementById("metric-latency").innerText = latency + " ms";
        
        activeVariant = data.variant;
        document.getElementById("metric-variant").innerText = activeVariant;
        impressions++;
        document.getElementById("metric-impressions").innerText = impressions;

        renderForm(data.schema);
      })
      .catch(err => {
        document.getElementById("form-headline").innerText = "Error: " + err;
      });
    }

    function renderForm(schema) {
      document.getElementById("form-headline").innerText = schema.headline || "Sign Up";
      document.getElementById("form-submit-btn").innerText = (schema.button_text || "Submit") + " (+1.0 Reward)";
      
      const fieldsDiv = document.getElementById("form-fields");
      fieldsDiv.innerHTML = "";
      
      (schema.fields || ["email"]).forEach(field => {
        fieldsDiv.innerHTML += `
          <div class="field-group">
            <label>${field.replace("_", " ")}</label>
            <input name="${field}" placeholder="Enter ${field.replace("_", " ")}">
          </div>
        `;
      });
    }

    function submitOutcome(reward) {
      if (!activeVariant) return;
      const signals = getActiveSignals();

      fetch(`/sites/${siteId}/reward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: activeVariant, reward: reward, signals: signals })
      })
      .then(res => res.json())
      .then(() => {
        if (reward > 0) {
          conversions++;
          document.getElementById("metric-conversions").innerText = conversions;
        }
        // Immediately query the bandit again to show the updated selection
        requestDecision();
      });
    }

    // Initial load
    requestDecision();
  </script>
</body>
</html>

"""

@app.route("/demo")
def demo_page():
    return render_template_string(DEMO_HTML)





if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)