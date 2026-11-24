# 1. Re-stream your app.py to the pod (in case K8s restarted the container) 
sudo k8s kubectl exec -i -n marketing-form-dynamic-optimization marketing-form-dynamic-optimization-0 -c flask-app -- python3 -c "import sys; open('/flask/app/app.py', 'w').write(sys.stdin.read())" < ~/marketing-form-dynamic-optimization/app.py 

# 2. Start Flask 
sudo k8s kubectl exec -n marketing-form-dynamic-optimization marketing-form-dynamic-optimization-0 -c flask-app -- /charm/bin/pebble start flask 

# 3. Re-open the port-forward tunnel 
sudo k8s kubectl port-forward -n marketing-form-dynamic-optimization svc/marketing-form-dynamic-optimization 8080:8000 --address 0.0.0.0

## Dummy website + Puppeteer user simulation

`dummy_site/` is a static landing page ("Nimbus Analytics") with a real lead form rendered from
the bandit's decision. `simulation/` drives real Chrome sessions with Puppeteer to imitate visitors.

**How the site works**
- It detects visitor signals the way a real site would: `mobile` comes from the UA or viewport,
  `returning_visitor` from localStorage, `paid_ad_click` from `utm_medium=cpc|ppc|paid`, `gclid` or
  `fbclid`, and `enterprise_domain` from `utm_campaign` containing `abm` or `enterprise`, or a
  LinkedIn referrer.
- It calls `/sites/<id>/decide`. If the site isn't registered yet, it registers
  `dummy_site/schema.json` first.
- A valid submit sends reward `1.0`. Leaving the page without converting sends reward `0.0`
  through `navigator.sendBeacon`.
- Configure the API in `dummy_site/config.js`, or per visit with `?api=<url>&site=<site_id>`.

**Run locally**
```bash
# 1. API (or use the k8s port-forward on :8080 and pass --api http://localhost:8080)
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py                                # http://localhost:8000

# 2. Site
python3 -m http.server 5173 -d dummy_site              # http://localhost:5173

# 3. Simulated visitors (Node 18+)
cd simulation && npm install
node simulate.js --visitors 300 --fast                 # --headful to watch, --help for options
```

Each visitor:
1. Gets a fresh browser context and a random traffic profile (device, UTM params, referrer,
   prior visit).
2. Scrolls, reads, and then either fills in and submits the form or leaves the page (sometimes
   after typing part of a field).
3. Converts according to a hidden ground-truth model (`TRUTH` in `simulate.js`), so the report
   can show whether the bandit learns the best variant for each context.

**Report contents**
- Expected conversion rate of the bandit, compared with a random policy and an oracle.
- Cumulative regret and a learning curve.
- The bandit's picks for each segment.
- Signal-detection checks.
- A server-side check that the API's Prometheus counters (`/metrics`) received exactly one
  decision and one reward per visitor.

Raw per-visitor results are written to `simulation/results/`. Each run uses a new
`sim-<timestamp>` site id, so runs start from a clean bandit state. The process exits non-zero if
any check fails.

**Free hosting on Vercel:** `dummy_site/` is plain static files, so `npx vercel deploy dummy_site`
works without any config. Real browsers on the Vercel (HTTPS) page need an HTTPS, publicly
reachable API. Expose the API with a free tunnel (for example `cloudflared tunnel --url
http://localhost:8000`) and set `apiBase` in `config.js`. Then run
`node simulate.js --url https://<your-app>.vercel.app/ --api https://<tunnel-url>`.
