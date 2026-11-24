# Marketing form dynamic optimization

A Flask service (rock + Juju charm) that picks which lead-form variant to show each landing-page
visitor. It uses a LinUCB contextual bandit and stores what it learns in PostgreSQL.

- **[INSTALL.md](INSTALL.md)**: deploy it with Juju, integrate it with `postgresql-k8s` and an
  ingress, and add the form to any landing page with one script tag.
- **[demo/](demo)**: presenter guide plus `start.sh` / `stop.sh`. Everything runs from the
  `charm-dev` Multipass VM and stays private to this laptop.
- **[dummy_site/](dummy_site)**: a sample landing page with the embed (`adaptive-form.js`) and
  `schema.json`.
- **[simulation/](simulation)**: Puppeteer visitors that exercise a page and API end to end
  (`node simulate.js --help`).

## Updating the deployment in `charm-dev`

The repo is mounted in the VM at `~/marketing-form-dynamic-optimization`. Bump `version` in
`rockcraft.yaml`, then run in the VM:

```bash
cd ~/marketing-form-dynamic-optimization
rockcraft pack
rockcraft.skopeo --insecure-policy copy --dest-tls-verify=false \
  oci-archive:marketing-form-dynamic-optimization_<version>_amd64.rock \
  docker://localhost:32000/marketing-form-dynamic-optimization:<version>
(cd charm && charmcraft pack)
juju refresh marketing-form-dynamic-optimization \
  --path ./charm/marketing-form-dynamic-optimization_amd64.charm \
  --resource flask-app-image=localhost:32000/marketing-form-dynamic-optimization:<version>
```

You no longer need to stream `app.py` into the pod or run `pebble start flask` by hand. Since
0.7 the charm (built on `paas_charm.flask.Charm`) manages the Flask service, passes `juju config`
and the PostgreSQL connection to it, and keeps the ingress up to date.

`rockcraft pack` copies the whole project directory. Don't create a Python virtualenv inside
it: the packing fails on the venv's symlinks.

## Running the API locally (without Juju)

```bash
python3 -m venv ~/.venvs/adaptive-form && ~/.venvs/adaptive-form/bin/pip install -r requirements.txt
~/.venvs/adaptive-form/bin/python app.py      # http://localhost:8000; state stays in memory unless
                                              # POSTGRESQL_DB_CONNECT_STRING is set
```
