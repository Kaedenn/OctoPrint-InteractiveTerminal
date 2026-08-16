# coding=utf-8
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kaedenn A. D. N.

"""
This plugin adds autocompletion and G-code documentation to the terminal.
"""

from __future__ import annotations

import threading
from typing import Any, Optional

import flask
import octoprint.plugin
from octoprint.events import Events


class InteractiveTerminalPlugin(
    octoprint.plugin.SettingsPlugin,
    octoprint.plugin.AssetPlugin,
    octoprint.plugin.SimpleApiPlugin,
    octoprint.plugin.EventHandlerPlugin,
):
    """
    Adds G-code-aware interactive assistance to OctoPrint's stock terminal.

    Static command documentation is served directly from this plugin's
    ``static/`` tree.  The Python side owns only dynamic printer state such as
    the detected firmware/dialect and the M115 capability report.
    """

    def __init__(self) -> None:
        super().__init__()

        self._state_lock = threading.RLock()
        self._firmware_name: Optional[str] = None
        self._firmware_data: dict[str, Any] = {}
        self._capabilities: dict[str, bool] = {}
        self._dialect: Optional[str] = None

    def is_api_protected(self) -> bool:
        return True

    # ------------------------------------------------------------------
    # Internal state helpers

    def _detect_dialect(
        self,
        firmware_name: Optional[str],
        firmware_data: dict[str, Any]
    ) -> Optional[str]:
        """Map firmware identity reported by M115 to our command dialect key."""
        candidates = [
            firmware_name or "",
            str(firmware_data.get("FIRMWARE_NAME", "")),
        ]
        identity = " ".join(candidates).casefold()

        if "marlin" in identity:
            return "marlin"

        # Future dialects belong here, e.g. RepRapFirmware, Repetier, etc.

        self._logger.info("Your firmware %s is unsupported", identity)
        return None

    def _state_snapshot(self) -> dict[str, Any]:
        """Return a detached, JSON-safe snapshot of dynamic printer state."""
        with self._state_lock:
            return {
                "firmware_name": self._firmware_name,
                "firmware_data": dict(self._firmware_data),
                "capabilities": dict(self._capabilities),
                "dialect": self._dialect,
            }

    def _push_state(self) -> None:
        """Push current dynamic state to connected OctoPrint web clients."""
        self._plugin_manager.send_plugin_message(
            self._identifier,
            {
                "type": "printer_state",
                "state": self._state_snapshot(),
            },
        )

    def _clear_printer_state(self) -> None:
        with self._state_lock:
            self._firmware_name = None
            self._firmware_data = {}
            self._capabilities = {}
            self._dialect = None

    # ------------------------------------------------------------------
    # Firmware protocol hooks

    def on_firmware_info(
        self,
        comm_instance,
        firmware_name,
        firmware_data,
        *args,
        **kwargs,
    ) -> None:
        """Receive OctoPrint's parsed M115 firmware identity report."""
        data = dict(firmware_data or {})
        dialect = self._detect_dialect(firmware_name, data)

        with self._state_lock:
            self._firmware_name = firmware_name
            self._firmware_data = data
            self._dialect = dialect

        self._push_state()

    def on_firmware_capability_report(
        self,
        comm_instance,
        firmware_capabilities,
        *args,
        **kwargs,
    ) -> None:
        """Receive the completed parsed M115 Cap: report from OctoPrint."""
        with self._state_lock:
            self._capabilities = dict(firmware_capabilities or {})

        self._push_state()

    # ------------------------------------------------------------------
    # SimpleApiPlugin mixin

    def on_api_get(self, request):
        """Provide the frontend with an initial dynamic-state snapshot."""
        return flask.jsonify(self._state_snapshot())

    # ------------------------------------------------------------------
    # SettingsPlugin mixin

    def get_settings_defaults(self) -> dict[str, object]:
        return {
            "max_matches": 20,
        }

    # ------------------------------------------------------------------
    # AssetPlugin mixin

    def get_assets(self) -> dict[str, list[str]]:
        return {
            "js": [
                "js/marlin.js",
                "js/InteractiveTerminal.js",
            ],
            "css": ["css/InteractiveTerminal.css"],
        }

    # commands.json intentionally is not listed above.  It is data rather than
    # an embeddable web asset, and OctoPrint serves files under static/ directly:
    #   /plugin/<plugin-id>/static/commands.json

    # ------------------------------------------------------------------
    # EventHandlerPlugin mixin

    def on_event(self, event, payload) -> None:
        if event == Events.DISCONNECTED:
            self._clear_printer_state()
            self._push_state()

    # ------------------------------------------------------------------
    # Software update hook

    def get_update_information(self) -> dict[str, object]:
        return {
            "InteractiveTerminal": {
                "displayName": "Interactive Terminal Plugin",
                "displayVersion": self._plugin_version,
                "type": "github_release",
                "user": "Kaedenn",
                "repo": "OctoPrint-Interactiveterminal",
                "current": self._plugin_version,
                "pip": "https://github.com/Kaedenn/OctoPrint-Interactiveterminal/archive/{target_version}.zip",
            }
        }


__plugin_name__ = "Interactive Terminal Plugin"
__plugin_pythoncompat__ = ">=3,<4"


def __plugin_load__():
    global __plugin_implementation__
    __plugin_implementation__ = InteractiveTerminalPlugin()

    global __plugin_hooks__
    __plugin_hooks__ = {
        "octoprint.comm.protocol.firmware.info": __plugin_implementation__.on_firmware_info,
        "octoprint.comm.protocol.firmware.capability_report": __plugin_implementation__.on_firmware_capability_report,
        "octoprint.plugin.softwareupdate.check_config": __plugin_implementation__.get_update_information,
    }

# vim: set ts=4 sts=4 sw=4:
