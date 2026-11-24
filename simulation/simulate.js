#!/usr/bin/env node
// Drives real Chrome sessions against the dummy site to imitate visitors.
// Each visitor gets a fresh browser context, arrives with a realistic traffic
// profile (device, UTM params, referrer, prior visit). It either fills in and
// submits the adaptive form or leaves the page, and the page reports the
// outcome to the bandit API. Conversions follow a hidden "ground truth" model,
// so we can measure whether the bandit learns the best variant per context.
import puppeteer, { KnownDevices } from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI ----------
function parseArgs(argv) {
  const opts = {
    url: "http://localhost:5173/",
    api: "http://localhost:8000",
    siteId: `sim-${Date.now()}`,
    visitors: 200,
    concurrency: 4,
    seed: 42,
    headful: false,
    fast: false,
    out: path.join(HERE, "results"),
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].replace(/^--/, "").split("=");
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (k) {
      case "url": opts.url = next(); break;
      case "api": opts.api = next().replace(/\/+$/, ""); break;
      case "site-id": opts.siteId = next(); break;
      case "visitors": opts.visitors = parseInt(next(), 10); break;
      case "concurrency": opts.concurrency = parseInt(next(), 10); break;
      case "seed": opts.seed = parseInt(next(), 10); break;
      case "headful": opts.headful = true; break;
      case "fast": opts.fast = true; break;
      case "out": opts.out = next(); break;
      case "help":
        console.log(`Usage: node simulate.js [options]
  --url <url>          Dummy site URL (default ${opts.url})
  --api <url>          Bandit API base URL (default ${opts.api})
  --site-id <id>       Bandit site id; a fresh one per run by default
  --visitors <n>       Number of simulated visitors (default ${opts.visitors})
  --concurrency <n>    Parallel browser contexts (default ${opts.concurrency})
  --seed <n>           RNG seed for reproducible traffic (default ${opts.seed})
  --headful            Show the browser windows
  --fast               Skip human-like think/typing delays
  --out <dir>          Where to write JSON/CSV results`);
        process.exit(0);
      default:
        throw new Error(`Unknown option --${k} (see --help)`);
    }
  }
  return opts;
}

// ---------- Seeded RNG ----------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Traffic & ground truth ----------
const TRAFFIC = { mobile: 0.4, returning_visitor: 0.3, enterprise_domain: 0.2, paid_ad_click: 0.35 };

// Hidden conversion model the bandit must discover: p = base + sum(signal effects), clamped.
const TRUTH = {
  variant_a_compact: { base: 0.22, mobile: 0.2, paid_ad_click: 0.1, enterprise_domain: -0.15, returning_visitor: 0.0 },
  variant_b_detailed: { base: 0.06, mobile: -0.04, paid_ad_click: -0.02, enterprise_domain: 0.4, returning_visitor: 0.08 },
  variant_c_social_proof: { base: 0.15, mobile: 0.0, paid_ad_click: 0.05, enterprise_domain: 0.05, returning_visitor: 0.2 },
};
const VARIANTS = Object.keys(TRUTH);

function convProb(variant, signals) {
  const t = TRUTH[variant];
  if (!t) return 0;
  let p = t.base;
  for (const s of signals) p += t[s] || 0;
  return Math.min(0.95, Math.max(0.01, p));
}

function optimalVariant(signals) {
  return VARIANTS.reduce((best, v) => (convProb(v, signals) > convProb(best, signals) ? v : best));
}

function makeProfile(rng, i) {
  const p = { id: i, mobile: false, returning_visitor: false, enterprise_domain: false, paid_ad_click: false };
  for (const k of Object.keys(TRAFFIC)) p[k] = rng() < TRAFFIC[k];
  p.expectedSignals = ["page_view", ...Object.keys(TRAFFIC).filter((k) => p[k])];
  p.rand = rng; // per-visitor behaviour draws come from the shared seeded stream
  return p;
}

function buildUrl(base, profile, opts) {
  const u = new URL(base);
  u.searchParams.set("api", opts.api);
  u.searchParams.set("site", opts.siteId);
  if (profile.paid_ad_click) {
    u.searchParams.set("utm_source", profile.enterprise_domain ? "linkedin" : "google");
    u.searchParams.set("utm_medium", "cpc");
  }
  if (profile.enterprise_domain) u.searchParams.set("utm_campaign", "abm-q4-enterprise");
  return u.toString();
}

// ---------- Fake form data ----------
const FIRST = ["Alex", "Sam", "Maria", "Chen", "Priya", "Jonas", "Lena", "Omar", "Sofia", "Kenji"];
const LAST = ["Smith", "Garcia", "Müller", "Nakamura", "Okafor", "Rossi", "Novak", "Silva"];
const CORP = ["acme.com", "globex.io", "initech.com", "umbrella.co", "hooli.com"];
const FREE = ["gmail.com", "outlook.com", "yahoo.com", "proton.me"];
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function fakeValue(rng, field, profile) {
  const first = pick(rng, FIRST);
  const last = pick(rng, LAST);
  const domain = profile.enterprise_domain || field === "work_email" ? pick(rng, CORP) : pick(rng, FREE);
  switch (field) {
    case "email":
    case "work_email":
      return `${first}.${last}${Math.floor(rng() * 100)}@${domain}`.toLowerCase().replace("ü", "u");
    case "name": return `${first} ${last}`;
    case "team_name": return `${pick(rng, ["Growth", "Demand Gen", "Brand", "Performance"])} team`;
    default: return `${first} test`;
  }
}

// ---------- Visitor behaviour ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runVisitor(browser, profile, opts) {
  const rng = profile.rand;
  const think = (min, max) => (opts.fast ? Promise.resolve() : sleep(min + rng() * (max - min)));
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const rec = {
    id: profile.id,
    expected_signals: profile.expectedSignals.join("|"),
    detected_signals: "",
    variant: "",
    optimal_variant: optimalVariant(profile.expectedSignals),
    p_chosen: 0,
    p_optimal: convProb(optimalVariant(profile.expectedSignals), profile.expectedSignals),
    p_random: VARIANTS.reduce((s, v) => s + convProb(v, profile.expectedSignals), 0) / VARIANTS.length,
    intended_convert: false,
    converted: false,
    reward_acked: false,
    decide_ms: null,
    error: "",
  };

  const decideStart = new Map();
  page.on("request", (req) => {
    if (req.url().includes("/decide") && req.method() === "POST") decideStart.set(req, Date.now());
  });
  page.on("response", (res) => {
    const req = res.request();
    if (decideStart.has(req)) rec.decide_ms = Date.now() - decideStart.get(req);
  });

  try {
    if (profile.mobile) await page.emulate(KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1366, height: 860 });
    if (profile.returning_visitor) {
      await page.evaluateOnNewDocument(() => localStorage.setItem("nimbus_visited", String(Date.now() - 86400000)));
    }

    await page.goto(buildUrl(opts.url, profile, opts), {
      waitUntil: "domcontentloaded",
      referer: profile.enterprise_domain && !profile.paid_ad_click ? "https://www.linkedin.com/" : undefined,
      timeout: 20000,
    });
    await page.waitForFunction(() => ["ready", "error"].includes(document.body.dataset.state), { timeout: 15000 });
    const st = await page.evaluate(() => ({ ...window.__adaptiveForm }));
    if (st.status === "error") throw new Error(`page error: ${st.error}`);

    rec.variant = st.variant;
    rec.detected_signals = st.signals.join("|");
    rec.p_chosen = convProb(st.variant, st.signals);

    // Look around like a person: scroll, read, come back to the form.
    await think(300, 1200);
    await page.mouse.wheel({ deltaY: 300 + rng() * 600 });
    await think(200, 900);
    await page.evaluate(() => document.getElementById("signup").scrollIntoView({ block: "center" }));
    await think(200, 800);

    rec.intended_convert = rng() < convProb(st.variant, st.signals);
    const fields = await page.$$eval("#form-fields [name]", (els) => els.map((e) => ({ name: e.name, tag: e.tagName })));

    if (rec.intended_convert) {
      for (const f of fields) {
        const sel = `#form-fields [name="${f.name}"]`;
        if (f.tag === "SELECT") {
          const options = await page.$$eval(`${sel} option`, (os) => os.map((o) => o.value).filter(Boolean));
          await page.select(sel, pick(rng, options));
        } else {
          await page.click(sel);
          await page.type(sel, fakeValue(rng, f.name, profile), { delay: opts.fast ? 0 : 20 + rng() * 60 });
        }
        await think(150, 600);
      }
      await page.click("#form-submit");
      await page.waitForFunction(() => document.body.dataset.state === "converted", { timeout: 10000 });
      rec.converted = true;
      rec.reward_acked = true; // the page only shows success after the API accepted the reward
    } else {
      // Some visitors start typing, then abandon.
      if (fields.length && rng() < 0.3 && fields[0].tag !== "SELECT") {
        const sel = `#form-fields [name="${fields[0].name}"]`;
        await page.click(sel);
        await page.type(sel, fakeValue(rng, fields[0].name, profile).slice(0, 5), { delay: opts.fast ? 0 : 40 });
        await think(300, 1000);
      }
      // Leaving the page fires `pagehide` -> sendBeacon(reward 0). Puppeteer can't see the
      // beacon's response after unload, so delivery is verified server-side via /metrics.
      await page.goto("about:blank");
      await sleep(250);
    }
  } catch (err) {
    rec.error = String(err.message || err).split("\n")[0];
  } finally {
    await ctx.close().catch(() => {});
  }
  return rec;
}

// ---------- Reporting ----------
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Reads the app's Prometheus counters for this site: decisions served and rewards received.
async function serverCounters(opts) {
  try {
    const text = await (await fetch(`${opts.api}/metrics`)).text();
    const get = (name) => {
      const m = text.match(new RegExp(`^${name}\\{site_id="${opts.siteId}"\\} ([0-9.e+]+)$`, "m"));
      return m ? Number(m[1]) : 0;
    };
    return { decisions: get("adaptive_form_decision_total"), rewards: get("adaptive_form_conversion_total") };
  } catch {
    return null;
  }
}

function report(records, opts, server) {
  const ok = records.filter((r) => !r.error);
  const errors = records.filter((r) => r.error);
  const mismatched = ok.filter((r) => r.detected_signals !== r.expected_signals);
  const serverOk = !server || (server.decisions === ok.length && server.rewards === ok.length);

  console.log("\n================ SIMULATION REPORT ================");
  console.log(`Site id: ${opts.siteId}   Visitors: ${records.length}   Errors: ${errors.length}`);
  console.log(`Signal detection mismatches: ${mismatched.length}`);
  console.log(
    server
      ? `Server-side (Prometheus): ${server.decisions} decisions, ${server.rewards} rewards for ${ok.length} visitors -> ${serverOk ? "OK" : "MISMATCH"}`
      : "Server-side check skipped (/metrics unreachable)"
  );
  console.log(`Median /decide latency (browser): ${[...ok.map((r) => r.decide_ms)].sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? "-"} ms`);

  const conv = ok.filter((r) => r.converted).length;
  console.log(`\nObserved conversion rate: ${pct(conv / Math.max(1, ok.length))} (${conv}/${ok.length})`);
  console.log("Expected conversion rate by policy (same visitors):");
  console.log(`  bandit  ${pct(mean(ok.map((r) => r.p_chosen)))}`);
  console.log(`  random  ${pct(mean(ok.map((r) => r.p_random)))}`);
  console.log(`  oracle  ${pct(mean(ok.map((r) => r.p_optimal)))}`);
  console.log(`Cumulative expected regret: ${ok.reduce((s, r) => s + r.p_optimal - r.p_chosen, 0).toFixed(2)} conversions`);

  console.log("\nPer variant:");
  console.table(
    Object.fromEntries(
      VARIANTS.map((v) => {
        const rs = ok.filter((r) => r.variant === v);
        const c = rs.filter((r) => r.converted).length;
        return [v, { shown: rs.length, converted: c, rate: pct(c / Math.max(1, rs.length)) }];
      })
    )
  );

  const buckets = 5;
  const size = Math.ceil(ok.length / buckets);
  console.log("Learning curve (share of visitors shown their optimal variant):");
  console.table(
    Array.from({ length: buckets }, (_, b) => {
      const rs = ok.slice(b * size, (b + 1) * size);
      return rs.length
        ? {
            visitors: `${b * size + 1}-${b * size + rs.length}`,
            optimal_choice: pct(rs.filter((r) => r.variant === r.optimal_variant).length / rs.length),
            avg_regret: (mean(rs.map((r) => r.p_optimal - r.p_chosen))).toFixed(3),
          }
        : null;
    }).filter(Boolean)
  );

  const second = ok.slice(Math.floor(ok.length / 2));
  const segs = {};
  for (const r of second) {
    const k = r.expected_signals.replace("page_view|", "").replace("page_view", "(none)") || "(none)";
    segs[k] ??= { visitors: 0, optimal: r.optimal_variant, ...Object.fromEntries(VARIANTS.map((v) => [v, 0])) };
    segs[k].visitors++;
    segs[k][r.variant]++;
  }
  console.log("Per segment, second half of traffic (what the bandit picks vs the optimal variant):");
  console.table(Object.fromEntries(Object.entries(segs).sort((a, b) => b[1].visitors - a[1].visitors)));

  if (errors.length) {
    console.log("Sample errors:");
    for (const e of errors.slice(0, 5)) console.log(`  #${e.id}: ${e.error}`);
  }
  if (mismatched.length) {
    console.log("Sample signal mismatches:");
    for (const m of mismatched.slice(0, 5)) console.log(`  #${m.id}: expected ${m.expected_signals}, got ${m.detected_signals}`);
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const base = path.join(opts.out, opts.siteId);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ options: opts, truth: TRUTH, traffic: TRAFFIC, records }, null, 2));
  const cols = Object.keys(records[0] || {});
  fs.writeFileSync(`${base}.csv`, [cols.join(","), ...records.map((r) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n"));
  console.log(`\nRaw results: ${base}.json / .csv`);

  return errors.length === 0 && mismatched.length === 0 && serverOk;
}

// ---------- Main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  for (const [name, url] of [["API", `${opts.api}/`], ["site", opts.url]]) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error(`Cannot reach ${name} at ${url}: ${e.message}`);
      process.exit(2);
    }
  }

  // Register up front: concurrent first visitors would otherwise each (re-)register and reset the bandit.
  const schemaRes = await fetch(`${opts.api}/sites/${opts.siteId}/schema`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: fs.readFileSync(path.join(HERE, "..", "dummy_site", "schema.json")),
  });
  if (!schemaRes.ok) throw new Error(`Schema registration failed: HTTP ${schemaRes.status}`);

  const rng = mulberry32(opts.seed);
  const profiles = Array.from({ length: opts.visitors }, (_, i) => makeProfile(rng, i + 1));
  const browser = await puppeteer.launch({ headless: !opts.headful, args: ["--no-sandbox"] });
  const records = new Array(profiles.length);
  let next = 0;
  let done = 0;

  console.log(`Simulating ${opts.visitors} visitors against ${opts.url} (API ${opts.api}, site ${opts.siteId})`);
  const worker = async () => {
    while (next < profiles.length) {
      const idx = next++;
      records[idx] = await runVisitor(browser, profiles[idx], opts);
      done++;
      const r = records[idx];
      if (done % 10 === 0 || r.error) {
        process.stdout.write(
          `  [${done}/${profiles.length}] #${r.id} ${r.variant || "-"} ${r.converted ? "CONVERTED" : "left"}${r.error ? " ERROR: " + r.error : ""}\n`
        );
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  } finally {
    await browser.close();
  }
  await sleep(500); // let trailing beacons land
  process.exit(report(records, opts, await serverCounters(opts)) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
