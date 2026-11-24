#!/usr/bin/env python3
# Copyright 2026 Ubuntu
# See LICENSE file for licensing details.

"""Flask Charm entrypoint."""

import logging
import re
import typing
import json 

import ops
import paas_charm.flask

logger = logging.getLogger(__name__)


class MarketingFormDynamicOptimizationCharm(paas_charm.flask.Charm):
    # paas_charm wires the `postgresql` and `ingress` integrations and passes config to the
    # workload as FLASK_* environment variables (and POSTGRESQL_DB_CONNECT_STRING).
    def __init__(self, framework: ops.Framework) -> None:
        super().__init__(framework)

        # observe config changes and status collection
        # self.framework.observe(self.on.config_changed, self._on_config_changed) # handled automatically as part of the flask extension implementation
        self.framework.observe(self.on.collect_unit_status, self._on_collect_unit_status)
        self.framework.observe(self.on.collect_app_status, self._on_collect_app_status)

        # action observers
        self.framework.observe(self.on.test_openrouter_action, self._on_test_openrouter_action)
        self.framework.observe(self.on.reset_bandit_weights_action, self._on_reset_bandit_weights_action)


    def _on_start(self, event: ops.StartEvent) -> None:
        # Probe the local Flask health endpoint or inspect container files
        container = self.unit.get_container("flask-app")
        if container.can_connect():
            # set version displayed in `juju status` under the 'Version' column
            self.unit.set_workload_version("0.1.0-linucb")

    def _on_collect_unit_status(self, event: ops.CollectStatusEvent) -> None:
        """Dynamically evaluate status based on current configuration."""
        # 1. Validate OpenRouter configuration
        llm_enabled = self.config.get("enable-llm-validation")
        api_key = self.config.get("openrouter-api-key")

        if llm_enabled and not api_key:
            event.add_status(ops.BlockedStatus("Missing required config: 'openrouter-api-key'"))
            return 

        alpha = self.config.get("exploration-alpha", 0.5)
        if not (0.0 <= float(alpha) <= 1.0):
            event.add_status(ops.BlockedStatus(f"Invalid exploration-alpha: {alpha} (must be between 0.0 and 1.0)"))
            return 

        # 2. Validate exploration-alpha range
        alpha = self.config.get("exploration-alpha", 0.5)
        try: 
            val = float(alpha)
            if not (0.0 <= val <= 1.0):
                event.add_status(ops.BlockedStatus(f"Invalid exploration-alpha: {alpha} (must be between 0.0 and 1.0)"))
                return 
        except (ValueError, TypeError):
            event.add_status(ops.BlockedStatus(f"exploration-alpha must be a valid float: {alpha}"))
            return 

        # 3. Validate default-site-schema JSON syntax
        raw_schema = self.config.get("default-site-schema", "")
        if raw_schema: 
            try:
                parsed = json.loads(raw_schema)
                if not isinstance(parsed, dict) or "signals" not in parsed or "variants" not in parsed:
                    event.add_status(ops.BlockedStatus("default-site-schema must be a JSON object with 'signals' and 'variants' keys"))
                    return 
            except json.JSONDecodeError:
                event.add_status(ops.BlockedStatus("default-site-schema contains invalid JSON"))
                return 

        # Only relabel "active"; keep paas_charm's waiting/blocked statuses (e.g. missing integrations).
        if isinstance(self.unit.status, ops.ActiveStatus):
            event.add_status(ops.ActiveStatus("Bandit service operational"))



    def _on_collect_app_status(self, event: ops.CollectStatusEvent) -> None:
        """Evaluate and report application-level status."""
        # 1. Validate OpenRouter configuration
        llm_enabled = self.config.get("enable-llm-validation")
        api_key = self.config.get("openrouter-api-key")
        if llm_enabled and not api_key:
            event.add_status(ops.BlockedStatus("Missing required config: 'openrouter-api-key'"))
            return

        # 2. Validate exploration-alpha range
        alpha = self.config.get("exploration-alpha", 0.5)
        try:
            val = float(alpha)
            if not (0.0 <= val <= 1.0):
                event.add_status(ops.BlockedStatus(f"Invalid exploration-alpha: {alpha} (must be between 0.0 and 1.0)"))
                return
        except (ValueError, TypeError):
            event.add_status(ops.BlockedStatus(f"exploration-alpha must be a valid float: {alpha}"))
            return

        # 3. Validate default-site-schema JSON syntax
        raw_schema = self.config.get("default-site-schema")
        if raw_schema:
            try:
                parsed = json.loads(raw_schema)
                if not isinstance(parsed, dict) or "signals" not in parsed or "variants" not in parsed:
                    event.add_status(ops.BlockedStatus("default-site-schema must be a JSON object with 'signals' and 'variants' keys"))
                    return
            except json.JSONDecodeError:
                event.add_status(ops.BlockedStatus("default-site-schema contains invalid JSON"))
                return

        if isinstance(self.app.status, ops.ActiveStatus):
            event.add_status(ops.ActiveStatus("Bandit service operational"))



    def _on_test_openrouter_action(self, event: ops.ActionEvent) -> None: 
        """Action handler that checks whether OpenRouter credentials work."""
        api_key = self.config.get("openrouter-api-key")
        model = self.config.get("openrouter-model", "meta-llama/llama-3-8b-instruct")

        if not api_key:
            event.fail("openrouter-api-key is not configured on this unit")
            return 

        # container communication: the charm talks to the workload container over localhost since they are hosted on the same pod
        container = self.unit.get_container("flask-app")
        if not container.can_connect():
            event.fail("Workload container is not reachable")
            return 

        # Execute a verification command directly inside the workload container
        try:
            process = container.exec(
                ["python3", "-c", f"""
                import requests
                res = requests.post(
                    'https://openrouter.ai/api/v1/chat/completions',
                    headers={{"Authorization": f"Bearer {api_key}"}},
                    json={{'model': '{model}', 'messages': [{{'role': 'user', 'content': 'ping'}}]}},
                    timeout=5
                )
                print(res.status_code)        
"""],
            timeout=10,
            )
            stdout, _ = process.wait_output()
            status_code = stdout.strip()

            if status_code == '200':
                event.set_results({"result": "success", "status-code": 200, "message": "OpenRouter credentials verified"})
            else:
                event.fail(f"OpenRouter returned status code: {status_code}")


        except Exception as e: 
            event.fail(f"Execution error: {str(e)}")
            


    def _on_reset_bandit_weights_action(self, event: ops.ActionEvent) -> None:
        """Reset the LinUCB matrices for one site (or all), keeping each site's schema."""
        site_id = event.params.get("site-id", "")
        container = self.unit.get_container("flask-app")
        if not container.can_connect():
            event.fail("Workload container is not reachable")
            return
        flask_service = container.get_plan().services.get("flask")
        if flask_service is None:
            event.fail("Flask service is not configured yet")
            return
        # Run inside the workload with the same environment (DB connection string, config) as Flask.
        script = "import json, sys, app; print(json.dumps(app.reset_bandit_state(sys.argv[1])))"
        try:
            process = container.exec(
                ["/bin/python3", "-c", script, site_id],
                working_dir="/flask/app",
                environment=dict(flask_service.environment),
                user="_daemon_",
                timeout=60,
            )
            stdout, _ = process.wait_output()
            reset_sites = json.loads(stdout.strip().splitlines()[-1])
        except Exception as e:
            event.fail(f"Reset failed: {e}")
            return
        if site_id and not reset_sites:
            event.fail(f"Unknown site-id: {site_id}")
            return
        event.set_results({"reset-sites": ",".join(reset_sites) or "(none)", "count": len(reset_sites)})


if __name__ == "__main__":
    ops.main(MarketingFormDynamicOptimizationCharm)
