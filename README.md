# OctoPrint-Interactiveterminal

This plugin provides autocompletion when typing Marlin G-code into the interactive terminal.

## Setup

Install manually using this URL:

    https://github.com/Kaedenn/OctoPrint-Interactiveterminal/archive/main.zip

No further setup should be needed to use this plugin. It will query your printer's features and conditionally disable which commands your printer doesn't support.

Note that this plugin will do nothing if your printer isn't configured for Marlin.

## Configuration

**TODO**

## Development and Hacking

If you want to modify this plugin for any reason, you'll need to be able to generate the Marlin documentation.

1. Clone this repository with `--recurse-submodules`: `git clone --recurse-submodules git@github.com:/Kaedenn/OctoPrint-InteractiveTerminal.git`
   * If you cloned without `--recurse-submodules`, then pull down the Marlin documentation via `git submodule update --init MarlinDocumentation`
2. Ensure your OctoPrint virtual environment is active:
   * `source <path/to/venv>/bin/activate`
3. Run the `extract_marlin_gcode.py` script on the `MarlinDocumentation/_gcode` directory:
   * `python3 scripts/extract_marlin_gcode.py MarlinDocumentation/_gcode`
   * You should get `commands.json`
4. Copy (or move) that file into the `octoprint_InteractiveTerminal/static/config/` directory:
   * `mv commands.json octoprint_InteractiveTerminal/static/config/commands.json`

## License

Copyright (C) 2026 Kaedenn A. D. N.

This project is licensed under the GNU Affero General Public License v3.0 or
later (AGPL-3.0-or-later). See the `LICENSE` file for the full text, or visit:

https://www.gnu.org/licenses/agpl-3.0.html
