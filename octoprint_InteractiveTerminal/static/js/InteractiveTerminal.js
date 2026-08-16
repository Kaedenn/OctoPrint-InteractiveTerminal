/*
 * View model for OctoPrint-InteractiveTerminal
 *
 * Author: Kaedenn A. D. N.
 * License: AGPL-3.0-or-later
 */
$(function() {
    "use strict";

    const PLUGIN_ID = "InteractiveTerminal";
    const COMMANDS_URL = "plugin/" + PLUGIN_ID + "/static/commands.json";

    const commandSorter = new Intl.Collator(
        undefined,
        {
            numeric: true,
            sensitivity: "base"
        }
    );

    function InteractiveTerminalViewModel(parameters) {
        const self = this;

        self.terminalViewModel = parameters[0];
        self.settingsViewModel = parameters[1];

        // Convenient development/debugging handle in the browser console.
        window.InteractiveTerminalPlugin_ref = self;

        // Dynamic state supplied by the Python plugin.
        self.firmwareState = ko.observable({
            firmware_name: null,
            firmware_data: {},
            capabilities: {},
            dialect: null
        });

        // Static G-code documentation loaded directly from commands.json.
        self.commandCatalog = ko.observable(null);
        self.commands = ko.observable({});

        self._autocomplete = {
            input: null,
            popup: null,
            matches: [],
            selectedIndex: -1,
            keydownHandler: null
        };

        /*
         * Runtime support classification derived from commands.json plus the
         * connected printer's M115 capability report.
         */
        self.commandSupport = ko.observable({});

        self.stateReady = ko.observable(false);
        self.catalogReady = ko.observable(false);
        self.stateError = ko.observable(null);
        self.catalogError = ko.observable(null);

        // One in-flight/completed catalog request is shared by all callers.
        let catalogRequest = null;

        self._normalizeFirmwareState = function(state) {
            state = state || {};

            return {
                firmware_name: state.firmware_name || null,
                firmware_data: state.firmware_data || {},
                capabilities: state.capabilities || {},
                dialect: state.dialect || null
            };
        };

        self._rebuildCommandSupport = function() {
            const commands = self.commands();
            const firmware = self.firmwareState();
            const support = {};

            /*
             * We currently only have a Marlin requirement evaluator. If the
             * connected firmware is some other dialect, retain the catalog but
             * classify everything as unknown.
             */
            const canEvaluate =
                firmware.dialect === "marlin" &&
                typeof MarlinSupport !== "undefined";

            Object.keys(commands).forEach(function(code) {
                const command = commands[code];

                if (!canEvaluate) {
                    support[code] = {
                        support: "unknown",
                        variants: (command.variants || []).map(function(variant) {
                            return {
                                variant: variant,
                                support: "unknown"
                            };
                        })
                    };
                    return;
                }

                support[code] = {
                    support: MarlinSupport.evaluateCommand(command, firmware),
                    variants: MarlinSupport.classifyVariants(command, firmware)
                };
            });

            self.commandSupport(support);
        };

        self._setFirmwareState = function(state) {
            self.firmwareState(self._normalizeFirmwareState(state));
            self._rebuildCommandSupport();
            self.stateError(null);
            self.stateReady(true);
        };

        self.loadPrinterState = function() {
            self.stateReady(false);
            self.stateError(null);

            return OctoPrint.simpleApiGet(PLUGIN_ID)
                .done(function(state) {
                    self._setFirmwareState(state);
                })
                .fail(function(xhr, status, error) {
                    self.stateError(error || status || "Unable to load printer state");
                    console.error(
                        "InteractiveTerminal: unable to load printer state",
                        status,
                        error
                    );
                });
        };

        self.loadCommandCatalog = function() {
            if (catalogRequest !== null) {
                return catalogRequest;
            }

            self.catalogReady(false);
            self.catalogError(null);

            catalogRequest = OctoPrint.get(COMMANDS_URL)
                .done(function(catalog) {
                    if (!catalog || typeof catalog !== "object" || !catalog.commands) {
                        throw new Error(
                            "commands.json does not contain a commands object"
                        );
                    }

                    self.commandCatalog(catalog);
                    self.commands(catalog.commands);
                    self._rebuildCommandSupport();
                    self.catalogError(null);
                    self.catalogReady(true);

                    // The user may already have typed while the catalog loaded.
                    self._updateAutocomplete();
                })
                .fail(function(xhr, status, error) {
                    catalogRequest = null; // permit an explicit retry
                    self.catalogError(
                        error || status || "Unable to load command catalog"
                    );
                    console.error(
                        "InteractiveTerminal: unable to load command catalog",
                        status,
                        error
                    );
                });

            return catalogRequest;
        };

        self.command = function(code) {
            if (typeof code !== "string") {
                return null;
            }

            return self.commands()[code.trim().toUpperCase()] || null;
        };

        self.supportFor = function(code) {
            if (typeof code !== "string") {
                return null;
            }

            const entry = self.commandSupport()[code.trim().toUpperCase()];
            return entry ? entry.support : null;
        };

        self.supportDetailsFor = function(code) {
            if (typeof code !== "string") {
                return null;
            }

            return self.commandSupport()[code.trim().toUpperCase()] || null;
        };

        self.supportedVariantsFor = function(code) {
            const details = self.supportDetailsFor(code);

            if (!details) {
                return [];
            }

            return details.variants
                .filter(function(entry) {
                    return entry.support === "supported";
                })
                .map(function(entry) {
                    return entry.variant;
                });
        };

        self.commandLabel = function(code) {
            const variant = self._displayVariantFor(code);

            if (!variant) {
                return "";
            }

            return variant.title || variant.brief || "";
        };

        self.onStartup = function() {
            self.loadCommandCatalog();
            self.loadPrinterState();
        };

        self.onStartupComplete = function() {
            self._setupAutocomplete();
        };

        self.onDataUpdaterPluginMessage = function(plugin, message) {
            if (
                plugin !== PLUGIN_ID ||
                !message ||
                message.type !== "printer_state"
            ) {
                return;
            }

            self._setFirmwareState(message.state);
        };

        /*
         * Python's get_settings_defaults() remains authoritative. This
         * fallback is only defensive in case settings have not yet been
         * populated into settingsViewModel.
         */
        self.maxMatches = function() {
            const plugins =
                self.settingsViewModel &&
                self.settingsViewModel.settings &&
                self.settingsViewModel.settings.plugins;

            const pluginSettings = plugins && plugins[PLUGIN_ID];
            const setting = pluginSettings && pluginSettings.max_matches;

            if (typeof setting === "function") {
                const value = Number(setting());

                if (Number.isFinite(value) && value >= 0) {
                    return Math.floor(value);
                }
            }

            return 20;
        };

        self.marlinDocumentationUrl = function(variant) {
            if (!variant || typeof variant.source !== "string") {
                return null;
            }

            const page = variant.source.replace(/\.md$/i, ".html");

            return "https://marlinfw.org/docs/gcode/" + page;
        };

        /*
         * Return matching G-code command names only.
         *
         * Matching is case-insensitive and prefix-based. Empty/non-string
         * input returns an empty array.
         */
        self.matchCommandCodes = function(text) {
            if (typeof text !== "string") {
                return [];
            }

            const prefix = text.trim().toUpperCase();

            if (!prefix) {
                return [];
            }

            return Object.keys(self.commands())
                .filter(function(code) {
                    return (
                        code.startsWith(prefix) &&
                        self.supportFor(code) !== "unsupported"
                    );
                })
                .sort(commandSorter.compare)
                .slice(0, self.maxMatches());
        };

        self._commandPrefix = function(text) {
            if (typeof text !== "string") {
                return {
                    code: "",
                    exact: false
                };
            }

            const leftTrimmed = text.replace(/^\s+/, "");

            if (!leftTrimmed) {
                return {
                    code: "",
                    exact: false
                };
            }

            const match = leftTrimmed.match(/^(\S+)(\s|$)/);

            if (!match) {
                return {
                    code: leftTrimmed,
                    exact: false
                };
            }

            return {
                code: match[1],
                exact: match[2] !== ""
            };
        };

        self._updateAutocomplete = function() {
            const input = self._autocomplete.input;

            if (!input || !input.length) {
                return;
            }

            const parsed = self._commandPrefix(input.val());

            if (!parsed.code) {
                self._renderAutocomplete([]);
                return;
            }

            let matches;

            if (parsed.exact) {
                matches = self.command(parsed.code)
                    ? [parsed.code.toUpperCase()]
                    : [];
            } else {
                matches = self.matchCommandCodes(parsed.code);
            }

            self._renderAutocomplete(matches);
        };

        self._hideAutocomplete = function() {
            const popup = self._autocomplete.popup;

            self._autocomplete.matches = [];
            self._autocomplete.selectedIndex = -1;

            if (popup && popup.length) {
                popup.hide();
            }
        };

        self._setupAutocomplete = function() {
            const input = $("#terminal-command");

            if (!input.length) {
                console.warn(
                    "InteractiveTerminal: terminal command input not found"
                );
                return;
            }

            input.off(".interactiveTerminal");

            let popup = $("#interactive-terminal-autocomplete");

            if (!popup.length) {
                popup = $("<div>")
                    .attr({
                        id: "interactive-terminal-autocomplete",
                        role: "listbox",
                        "aria-label": "G-code autocomplete suggestions"
                    })
                    .addClass("interactive-terminal-autocomplete")
                    .hide()
                    .appendTo(document.body);
            }

            self._autocomplete.input = input;
            self._autocomplete.popup = popup;

            popup
                .off(".interactiveTerminal")
                .on(
                    "mousedown.interactiveTerminal",
                    ".interactive-terminal-autocomplete-item",
                    function(event) {
                        /*
                         * Don't let clicking a suggestion blur the Terminal input
                         * before the click handler runs.
                         */
                        event.preventDefault();
                    }
                )
                .on(
                    "click.interactiveTerminal",
                    ".interactive-terminal-autocomplete-item",
                    function(event) {
                        event.preventDefault();

                        const code = $(this).attr("data-code");

                        if (code) {
                            self._completeCommand(code);
                        }
                    }
                );

            input.on(
                "input.interactiveTerminal",
                self._updateAutocomplete
            );

            input.on(
                "focus.interactiveTerminal",
                self._updateAutocomplete
            );

            input.on(
                "blur.interactiveTerminal",
                self._hideAutocomplete
            );

            if (self._autocomplete.keydownHandler) {
                input[0].removeEventListener(
                    "keydown",
                    self._autocomplete.keydownHandler,
                    true
                );
            }

            self._autocomplete.keydownHandler = function(event) {
                const matches = self._autocomplete.matches;
                const matchCount = matches.length;

                /*
                * Let OctoPrint submit the command normally, but clear our popup/state
                * first so it doesn't linger after submission.
                */
                if (event.key === "Enter") {
                    self._hideAutocomplete();
                    return;
                }

                /*
                 * Up/Down belongs to autocomplete only while there are multiple
                 * choices. Otherwise allow OctoPrint's normal command-history
                 * handler to receive the event unchanged.
                 */
                if (
                    matchCount > 1 &&
                    (event.key === "ArrowDown" || event.key === "ArrowUp")
                ) {
                    event.preventDefault();
                    event.stopImmediatePropagation();

                    if (event.key === "ArrowDown") {
                        self._selectAutocompleteIndex(
                            self._autocomplete.selectedIndex + 1
                        );
                    } else {
                        self._selectAutocompleteIndex(
                            self._autocomplete.selectedIndex - 1
                        );
                    }

                    return;
                }

                /*
                 * Tab completes whenever there is at least one candidate.
                 *
                 * With one match, complete that match.
                 * With multiple matches, complete the currently selected one.
                 */
                if (event.key === "Tab" && matchCount > 0) {
                    event.preventDefault();
                    event.stopImmediatePropagation();

                    const index =
                        matchCount === 1
                        ? 0
                        : self._autocomplete.selectedIndex;

                    self._completeCommand(matches[index]);
                    return;
                }

                if (
                    event.key === "Escape" &&
                    self._autocomplete.popup &&
                    self._autocomplete.popup.is(":visible")
                ) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    self._hideAutocomplete();
                }
            };

            input[0].addEventListener(
                "keydown",
                self._autocomplete.keydownHandler,
                true
            );

            self._updateAutocomplete();
        };

        self._positionAutocomplete = function() {
            const input = self._autocomplete.input;
            const popup = self._autocomplete.popup;

            if (!input || !input.length || !popup || !popup.length) {
                return;
            }

            const rect = input[0].getBoundingClientRect();

            popup.css({
                left: rect.left + window.scrollX,
                top: rect.bottom + window.scrollY + 2,
                minWidth: rect.width
            });
        };

        self._displayVariantFor = function(code) {
            const command = self.command(code);

            if (!command || !Array.isArray(command.variants)) {
                return null;
            }

            const details = self.supportDetailsFor(code);

            if (details && Array.isArray(details.variants)) {
                const supported = details.variants.find(function(entry) {
                    return entry.support === "supported";
                });

                if (supported) {
                    return supported.variant;
                }

                const unknown = details.variants.find(function(entry) {
                    return entry.support === "unknown";
                });

                if (unknown) {
                    return unknown.variant;
                }
            }

            return command.variants[0] || null;
        };

        self._renderCommandDetails = function(code) {
            const popup = self._autocomplete.popup;
            const variant = self._displayVariantFor(code);

            if (!popup || !popup.length || !variant) {
                self._hideAutocomplete();
                return;
            }

            popup.empty();

            const details = $("<div>")
                .addClass("interactive-terminal-command-details");

            const header = $("<div>")
                .addClass("interactive-terminal-command-header");

            $("<span>")
                .addClass("interactive-terminal-command-code")
                .text(code)
                .appendTo(header);

            $("<span>")
                .addClass("interactive-terminal-command-title")
                .text(variant.title || "")
                .appendTo(header);

            const docsUrl = self.marlinDocumentationUrl(variant);

            if (docsUrl) {
                $("<a>")
                    .addClass("interactive-terminal-command-doc-link")
                    .attr({
                        href: docsUrl,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        title: "Open Marlin documentation",
                        "aria-label": "Open Marlin documentation for " + code
                    })
                    .text("?")
                    .appendTo(header);
            }

            header.appendTo(details);

            if (variant.brief) {
                $("<div>")
                    .addClass("interactive-terminal-command-description")
                    .text(variant.brief)
                    .appendTo(details);
            }

            if (
                Array.isArray(variant.parameters) &&
                variant.parameters.length > 0
            ) {
                const parameterBlock = $("<div>")
                    .addClass("interactive-terminal-command-parameters")
                    .appendTo(details);

                $("<div>")
                    .addClass("interactive-terminal-command-section-title")
                    .text("Parameters")
                    .appendTo(parameterBlock);

                variant.parameters.forEach(function(parameter) {
                    const row = $("<div>")
                        .addClass("interactive-terminal-command-parameter");

                    $("<span>")
                        .addClass("interactive-terminal-command-parameter-name")
                        .text(parameter.tag || parameter.name || "")
                        .appendTo(row);

                    $("<span>")
                        .addClass("interactive-terminal-command-parameter-description")
                        .text(parameter.description || "")
                        .appendTo(row);

                    row.appendTo(parameterBlock);
                });
            }

            details.appendTo(popup);

            self._positionAutocomplete();
            popup.show();
        };

        self._renderAutocomplete = function(matches) {
            const popup = self._autocomplete.popup;

            if (!popup || !popup.length) {
                return;
            }

            matches = Array.isArray(matches) ? matches : [];

            self._autocomplete.matches = matches.slice();
            self._autocomplete.selectedIndex =
                matches.length > 0 ? 0 : -1;

            popup.empty();

            if (matches.length === 0) {
                popup.hide();
                return;
            }

            if (matches.length === 1) {
                self._renderCommandDetails(matches[0]);
                return;
            }

            matches.forEach(function(code, index) {
                $("<div>")
                    .addClass("interactive-terminal-autocomplete-item")
                    .attr({
                        role: "option",
                        "data-index": index,
                        "data-code": code,
                        "aria-selected": "false"
                    })
                    .append(
                        $("<span>")
                        .addClass("interactive-terminal-autocomplete-code")
                        .text(code)
                    )
                    .append(
                        $("<span>")
                        .addClass("interactive-terminal-autocomplete-label")
                        .text(self.commandLabel(code))
                    )
                    .appendTo(popup);
            });

            self._positionAutocomplete();
            popup.show();

            // The first result is always selected initially.
            self._selectAutocompleteIndex(0);
        };

        self._selectAutocompleteIndex = function(index) {
            const popup = self._autocomplete.popup;
            const matches = self._autocomplete.matches;

            if (!popup || !popup.length || matches.length <= 1) {
                return;
            }

            if (index < 0) {
                index = matches.length - 1;
            } else if (index >= matches.length) {
                index = 0;
            }

            self._autocomplete.selectedIndex = index;

            const items = popup.find(
                ".interactive-terminal-autocomplete-item"
            );

            items
                .removeClass("selected")
                .attr("aria-selected", "false");

            const selected = items.eq(index);

            selected
                .addClass("selected")
                .attr("aria-selected", "true");

            if (selected.length) {
                selected[0].scrollIntoView({
                    block: "nearest"
                });
            }
        };

        self._completeCommand = function(code) {
            const input = self._autocomplete.input;

            if (!input || !input.length || !code) {
                return;
            }

            const text = input.val();
            const match = text.match(/^(\s*)\S*(.*)$/);

            if (!match) {
                return;
            }

            const leading = match[1];
            let remainder = match[2];

            if (!remainder) {
                remainder = " ";
            }

            input.val(leading + code + remainder);
            input.trigger("input");
            input.trigger("focus");
        };

        $(window)
            .off(".interactiveTerminal")
            .on(
                "resize.interactiveTerminal scroll.interactiveTerminal",
                self._positionAutocomplete
            );
    }

    OCTOPRINT_VIEWMODELS.push({
        construct: InteractiveTerminalViewModel,
        dependencies: [
            "terminalViewModel",
            "settingsViewModel"
        ],
        elements: []
    });
});
