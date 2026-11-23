#!/usr/bin/env python3
# Copyright 2026 Ubuntu
# See LICENSE file for licensing details.

"""Flask Charm entrypoint."""

import logging
import re
import typing
import json 

import ops

logger = logging.getLogger(__name__)

from charms.data_platform_libs.v0.data_interfaces import DatabaseRequires

class MarketingFormDynamicOptimizationCharm(ops.CharmBase):
    def __init__(self, framework: ops.Framework) -> None:
        super().__init__(framework)

        # Bind to PostgreSQL relation
        self.database = DatabaseRequires(
            self, 
            relation_name="postgresql",
            database_name="marketing_form_bandit"
        )

        # observe config changes and status collection
        # self.framework.observe(self.on.config_changed, self._on_config_changed) # handled automatically as part of the flask extension implementation
        self.framework.observe(self.on.collect_unit_status, self._on_collect_unit_status)
        self.framework.observe(self.on.collect_app_status, self._on_collect_app_status)

        # action observers
        self.framework.observe(self.on.test_openrouter_action, self._on_test_openrouter_action)


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
            


if __name__ == "__main__":
    ops.main(MarketingFormDynamicOptimizationCharm)
