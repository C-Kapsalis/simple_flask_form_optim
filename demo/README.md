# Presenting the demo

Everything runs from the `charm-dev` Multipass VM, and only while you present. The API is reached
through the Juju-managed ingress on the VM's private address (`10.97.0.48`), which only this
laptop can reach. The sample landing page is served on `127.0.0.1`. Nothing is reachable from
your LAN or the internet.

## Before the audience arrives

```bash
demo/start.sh            # starts the VM, waits for Juju, checks the ingress, serves the page
```

`start.sh` asks for your sudo password once. It needs it to add `10.97.0.48 marketing-form` to
`/etc/hosts`, so the browser can use the ingress hostname. `demo/stop.sh` removes that entry
again.

Open http://localhost:5173 and keep a terminal open in the VM (`multipass shell charm-dev`).

## Suggested flow (about 10 minutes)

1. **The problem.** Open the landing page and point at the form. Different visitors convert on
   different forms. Mobile visitors from ads want a single email field; enterprise visitors
   expect a detailed form.

2. **What's deployed.** In the VM, run:
   ```bash
   juju status --relations
   ```
   Three charms: the form optimiser, `postgresql-k8s` and `nginx-ingress-integrator`. The whole
   integration is the two `juju integrate` lines in [INSTALL.md](../INSTALL.md#2-deploy-with-juju).

3. **Configuration is just `juju config`.** In the VM, run:
   ```bash
   juju config marketing-form-dynamic-optimization exploration-alpha=0.5
   curl -s http://marketing-form/ ; echo    # from the laptop: "exploration_alpha": 0.5
   ```

4. **Integrating it into a page is one script tag.** Show the bottom of
   [`dummy_site/index.html`](../dummy_site/index.html).

5. **Real visitors, simulated.** On the laptop, run:
   ```bash
   cd simulation && node simulate.js --url http://localhost:5173/ --api http://marketing-form \
     --visitors 40 --headful            # watch Chrome windows fill in or abandon the form
   node simulate.js --url http://localhost:5173/ --api http://marketing-form --visitors 300 --fast
   ```
   The report shows the bandit learning which form to show to each segment.

6. **Learning survives restarts because it's in Postgres.** First, train a site from the laptop:
   ```bash
   node simulate.js --url http://localhost:5173/ --api http://marketing-form --site-id live-demo --visitors 150 --fast
   ```
   Then kill the pod in the VM, and wait for Juju to finish restarting the app:
   ```bash
   sudo k8s kubectl delete pod -n marketing-form-dynamic-optimization marketing-form-dynamic-optimization-0
   juju wait-for unit marketing-form-dynamic-optimization/0 \
     --query='workload-status=="active" && agent-status=="idle"'
   ```
   Back on the laptop, compare the trained site with a brand-new one on the same traffic:
   ```bash
   node simulate.js ... --site-id live-demo --keep-state --visitors 60 --seed 7 --fast   # picks up where it left off
   node simulate.js ... --site-id fresh-site           --visitors 60 --seed 7 --fast   # starts from scratch
   ```
   (`...` stands for the `--url`/`--api` arguments above.) In a test run, the trained site chose
   the best form for 67% of its first 12 visitors, against 50% for the fresh one.

7. **Day-2 operations.** In the VM, run:
   ```bash
   juju run marketing-form-dynamic-optimization/0 reset-bandit-weights site-id=nimbus-landing
   ```

## Afterwards

```bash
demo/stop.sh             # stops the page server, removes the /etc/hosts entry, stops the VM
demo/stop.sh --keep-vm   # same, but leaves the VM running
```
