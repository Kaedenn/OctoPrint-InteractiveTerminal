/*
 * Marlin requirement evaluation for InteractiveTerminal.
 *
 * Pure utility module: no OctoPrint, Knockout, or DOM dependencies.
 *
 * Input:
 *   - normalized `requirements` AST from commands.json
 *   - firmware state from the Python backend
 *
 * Output:
 *   MarlinSupport.SUPPORTED
 *   MarlinSupport.UNSUPPORTED
 *   MarlinSupport.UNKNOWN
 */

(function (global) {
    "use strict";

    const SUPPORTED = "supported";
    const UNSUPPORTED = "unsupported";
    const UNKNOWN = "unknown";

    /*
     * Maps Marlin documentation/configuration feature names to M115
     * capability names where a reliable relationship is known.
     *
     * A string means:
     *     FEATURE -> Cap:STRING
     *
     * A function may be used for cases requiring custom interpretation.
     *
     * Keep this table conservative. It is better for a feature to remain
     * UNKNOWN than to incorrectly hide a command that the firmware supports.
     */
    const FEATURE_CAPABILITY_MAP = Object.freeze({
        ARC_SUPPORT: "ARCS",
        EEPROM_SETTINGS: "EEPROM",
        SDSUPPORT: "SDCARD",
        LONG_FILENAME_HOST_SUPPORT: "LONG_FILENAME",
        LONG_FILENAME_WRITE_SUPPORT: "LFN_WRITE",
        EMERGENCY_PARSER: "EMERGENCY_PARSER",
        AUTO_REPORT_TEMPERATURES: "AUTOREPORT_TEMP",
        AUTO_REPORT_SD_STATUS: "AUTOREPORT_SD_STATUS",
        AUTO_REPORT_POSITION: "AUTOREPORT_POS",
        EXTENDED_CAPABILITIES_REPORT: function(firmwareState, capabilities) {
            return Object.keys(capabilities).length > 0
                ? SUPPORTED
                : UNKNOWN;
        },

        /*
         * These are intentionally broad Marlin pseudo-features used by the
         * documentation. M115 reports them directly on sufficiently capable
         * Marlin builds.
         */
        HAS_BED_PROBE: "Z_PROBE",
        HAS_LEVELING: "AUTOLEVEL"
    });

    function normalizeCapabilities(firmwareState) {
        const source =
            firmwareState &&
            firmwareState.capabilities &&
            typeof firmwareState.capabilities === "object"
                ? firmwareState.capabilities
                : {};

        const result = Object.create(null);

        Object.keys(source).forEach(function (name) {
            result[String(name).toUpperCase()] = source[name];
        });

        return result;
    }

    function capabilityValue(capabilities, name) {
        const key = String(name).toUpperCase();

        if (!Object.prototype.hasOwnProperty.call(capabilities, key)) {
            return UNKNOWN;
        }

        const value = capabilities[key];

        if (value === true || value === 1 || value === "1") {
            return SUPPORTED;
        }

        if (value === false || value === 0 || value === "0") {
            return UNSUPPORTED;
        }

        return UNKNOWN;
    }

    function evaluateFeature(name, firmwareState) {
        const capabilities = normalizeCapabilities(firmwareState);
        const mapping = FEATURE_CAPABILITY_MAP[name];

        if (typeof mapping === "string") {
            return capabilityValue(capabilities, mapping);
        }

        if (typeof mapping === "function") {
            return mapping(firmwareState, capabilities);
        }

        /*
         * Some documentation requirement names are identical to M115
         * capability names. Allow those without requiring duplicate entries
         * in FEATURE_CAPABILITY_MAP.
         */
        if (
            Object.prototype.hasOwnProperty.call(
                capabilities,
                String(name).toUpperCase()
            )
        ) {
            return capabilityValue(capabilities, name);
        }

        return UNKNOWN;
    }

    function combineAnd(results) {
        if (results.some(function (result) { return result === UNSUPPORTED; })) {
            return UNSUPPORTED;
        }

        if (results.every(function (result) { return result === SUPPORTED; })) {
            return SUPPORTED;
        }

        return UNKNOWN;
    }

    function combineOr(results) {
        if (results.some(function (result) { return result === SUPPORTED; })) {
            return SUPPORTED;
        }

        if (results.every(function (result) { return result === UNSUPPORTED; })) {
            return UNSUPPORTED;
        }

        return UNKNOWN;
    }

    function compareValues(left, operator, right) {
        switch (operator) {
            case "==":
            case "=":
                return left === right;
            case "!=":
                return left !== right;
            case ">":
                return left > right;
            case ">=":
                return left >= right;
            case "<":
                return left < right;
            case "<=":
                return left <= right;
            default:
                return null;
        }
    }

    /*
     * M115 does not expose arbitrary Configuration.h values such as EXTRUDERS
     * or AXIS4_NAME. This function exists as an extension point for later
     * configuration sources, but today these nodes normally remain UNKNOWN.
     */
    function lookupConfigurationValue(name, firmwareState) {
        if (
            firmwareState &&
            firmwareState.configuration &&
            Object.prototype.hasOwnProperty.call(
                firmwareState.configuration,
                name
            )
        ) {
            return {
                known: true,
                value: firmwareState.configuration[name]
            };
        }

        return {
            known: false,
            value: undefined
        };
    }

    function evaluateRequirement(node, firmwareState) {
        if (node === null || node === undefined) {
            return SUPPORTED;
        }

        if (typeof node !== "object") {
            return UNKNOWN;
        }

        switch (node.op) {
            case "feature":
                return evaluateFeature(node.name, firmwareState);

            case "and":
                return combineAnd(
                    (node.items || []).map(function (item) {
                        return evaluateRequirement(item, firmwareState);
                    })
                );

            case "or":
                return combineOr(
                    (node.items || []).map(function (item) {
                        return evaluateRequirement(item, firmwareState);
                    })
                );

            case "not": {
                const result = evaluateRequirement(node.item, firmwareState);

                if (result === SUPPORTED) {
                    return UNSUPPORTED;
                }

                if (result === UNSUPPORTED) {
                    return SUPPORTED;
                }

                return UNKNOWN;
            }

            case "compare": {
                const configured = lookupConfigurationValue(
                    node.name,
                    firmwareState
                );

                if (!configured.known) {
                    return UNKNOWN;
                }

                const compared = compareValues(
                    configured.value,
                    node.operator,
                    node.value
                );

                if (compared === null) {
                    return UNKNOWN;
                }

                return compared ? SUPPORTED : UNSUPPORTED;
            }

            case "equals": {
                const configured = lookupConfigurationValue(
                    node.name,
                    firmwareState
                );

                if (!configured.known) {
                    return UNKNOWN;
                }

                return configured.value === node.value
                    ? SUPPORTED
                    : UNSUPPORTED;
            }

            /*
             * Patterns and free-form text cannot be reliably resolved from
             * M115 alone. Never guess.
             */
            case "pattern":
            case "text":
                return UNKNOWN;

            default:
                return UNKNOWN;
        }
    }

    function evaluateVariant(variant, firmwareState) {
        if (!variant || typeof variant !== "object") {
            return UNKNOWN;
        }

        return evaluateRequirement(variant.requirements, firmwareState);
    }

    function evaluateCommand(command, firmwareState) {
        if (!command || !Array.isArray(command.variants)) {
            return UNKNOWN;
        }

        if (command.variants.length === 0) {
            return SUPPORTED;
        }

        /*
         * A command is supported if at least one documented variant is known
         * supported. It is unsupported only if every variant is known false.
         */
        return combineOr(
            command.variants.map(function (variant) {
                return evaluateVariant(variant, firmwareState);
            })
        );
    }

    function supportedVariants(command, firmwareState) {
        if (!command || !Array.isArray(command.variants)) {
            return [];
        }

        return command.variants.filter(function (variant) {
            return evaluateVariant(variant, firmwareState) === SUPPORTED;
        });
    }

    function classifyVariants(command, firmwareState) {
        if (!command || !Array.isArray(command.variants)) {
            return [];
        }

        return command.variants.map(function (variant) {
            return {
                variant: variant,
                support: evaluateVariant(variant, firmwareState)
            };
        });
    }

    global.MarlinSupport = Object.freeze({
        SUPPORTED: SUPPORTED,
        UNSUPPORTED: UNSUPPORTED,
        UNKNOWN: UNKNOWN,

        FEATURE_CAPABILITY_MAP: FEATURE_CAPABILITY_MAP,

        evaluateRequirement: evaluateRequirement,
        evaluateFeature: evaluateFeature,
        evaluateVariant: evaluateVariant,
        evaluateCommand: evaluateCommand,
        supportedVariants: supportedVariants,
        classifyVariants: classifyVariants
    });
})(window);
