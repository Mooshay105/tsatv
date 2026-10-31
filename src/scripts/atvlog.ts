#!/usr/bin/env bun
/** Script converting pyatv logs to HTML. */

import { readFileSync, writeFileSync } from "node:fs";
import { getLogger } from "../support/logging.ts";
import { ArgumentParser, SystemExit } from "./argparse.ts";
import { eprint, getIO, print } from "./io.ts";

const LOGGER = getLogger("pyatv.scripts.atvlog");

// Used by atvremote, atvscript, etc.
const LOG_LINE_RE = /^(?<date>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (?<level>[A-Z]+):(?<content>.*)/s;

// Used by Home Assistant
const HA_LOG_LINE_RE =
  /^(?<date>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (?<level>[A-Z]+) \([^)]*\) \[(pyatv|homeassistant.components.apple_tv)[^\]]*\] (?<content>.*)/s;

const HTML_TEMPLATE = `<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pyatv log</title>
  <style type="text/css" media="screen">
    .box_log {
      margin: 3px;
      padding: 2px;
      border-color: #aaaaaa;
      border-radius: 5px;
      border-style: dotted;
      background: #cccccc;
    }
    .box_log summary {
      overflow: scroll;
      white-space: wrap;
    }
    .box_log pre {
      overflow-x: auto;
    }
  </style>

  <script>
    var content = __CONTENT__;
    var level_checkboxes = [];

    function createEntry(entry) {
      var show_date = document.getElementById("show_date").checked;
      var outer = document.createElement("div");
      outer.className = "box_log";

      var details = document.createElement("details");
      outer.appendChild(details);

      var summary = document.createElement("summary");
      summary.innerText = (show_date ? entry[0] + " " : "") + entry[2];
      details.appendChild(summary);

      var desc = document.createElement("pre");
      details.appendChild(desc);

      details.addEventListener("toggle", event => {
        if (details.open) {
          desc.innerText = entry[3];

        }
      });

      return outer;
    }

    function populate() {
      include_filter = document.getElementById("include_filter").value;
      exclude_filter = document.getElementById("exclude_filter").value;

      entries = document.getElementById("entries")
      entries.innerHTML = "";

      active_levels = new Set();
      for (const checkbox of level_checkboxes) {
        if (checkbox.checked) {
          active_levels.add(checkbox.value);
        }
      }

      include_regexp = new RegExp(include_filter, "i");
      exclude_regexp = new RegExp(exclude_filter, "i");
      for (const entry of content) {
        if (exclude_filter && exclude_regexp.test(entry[3])) {
          continue;
        }

        if ((include_filter == null || include_regexp.test(entry[3])) &&
            active_levels.has(entry[1])) {
          entries.appendChild(createEntry(entry));
        }
      }
    }

    function loadData() {
      var log_levels = new Set();

      for (const entry of content) {
        log_levels.add(entry[1]);
      }

      for (const level of log_levels) {
        var outer = document.createElement("div");
        outer.style = "display: inline";

        var filter_box = document.createElement("input");
        filter_box.type = "checkbox";
        filter_box.value = level;
        filter_box.id = "LEVEL_" + level;
        filter_box.value = level;
        filter_box.checked = true;
        filter_box.addEventListener('change', (event) => {
          populate();
        });

        outer.appendChild(filter_box);
        level_checkboxes.push(filter_box);

        var label = document.createElement("label");
        label.innerText = level;
        label.for = "LEVEL_" + level;
        outer.appendChild(label);

        document.getElementById("filters").appendChild(outer);
      }

      populate();
    }

    // onload does not seem to work nicely with htmlpreview, so this is a workaround
    var checkExist = setInterval(function() {
      if (document.getElementById("entries")) {
        loadData();
        clearInterval(checkExist);
      }
    }, 100);
  </script>

</head>
<body>
  <h1>pyatv log2html</h1>
  <div>
    Generated at __TIME__<br />
    Command: __COMMAND__
  </div>
  <div id="filters" style="display: inline">
    <div>
      <label for="include_filter">Include</label>
      <input type="text" id="include_filter" onkeyup="populate()"
             placeholder="Include regexp..." />
    </div>
    <div>
      <label for="exclude_filter">Exclude</label>
      <input type="text" id="exclude_filter" onkeyup="populate()"
             placeholder="Exclude regexp..." />
    </div>
    <div>
      <input type="checkbox" id="show_date" onclick="populate()" checked />
      <label for="show_date">Show date</label>
    </div>
  </div>
  <div id="entries" />
</body>
`;

export type LogEntry = [string, string, string, string];

/** Parse lines in a log and return entries [date, level, first line, content]. */
export function* parseLogs(lines: Iterable<string>): Generator<LogEntry> {
  let currentDate: string | null = null;
  let currentLevel = "";
  let currentFirstLine = "";
  let currentContent = "";

  for (const line of lines) {
    const match = LOG_LINE_RE.exec(line) ?? HA_LOG_LINE_RE.exec(line);
    if (!match) {
      currentContent += line;
      continue;
    }

    if (currentDate) yield [currentDate, currentLevel, currentFirstLine, currentContent];

    currentDate = match.groups!.date!;
    currentLevel = match.groups!.level!;
    currentContent = match.groups!.content!.replace(/\n$/, "");
    currentFirstLine = currentContent;
    currentContent += "\n";
  }

  if (currentDate) yield [currentDate, currentLevel, currentFirstLine, currentContent];
}

function pythonNow(): string {
  const d = new Date();
  const p = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`;
}

/** Generate HTML output for log output. */
export function generateLogPage(lines: Iterable<string>, command: string): string | null {
  const logs = [...parseLogs(lines)];
  if (logs.length === 0) {
    LOGGER.warning("No log points found, not generating output");
    return null;
  }

  return HTML_TEMPLATE.replace("__CONTENT__", () => JSON.stringify(logs))
    .replace("__TIME__", () => pythonNow())
    .replace("__COMMAND__", () => command);
}

/** Serve log output from an internal web server. */
async function servePage(page: string, port: number): Promise<void> {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  });
  try {
    print("Press ENTER to quit");
    await getIO().readline();
  } finally {
    server.stop(true);
  }
}

/** Split text into lines, keeping line endings (like iterating over a file). */
function splitLinesKeepEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Look for markup start and end in input.
 *
 * This will look for input between tags looking like this:
 *
 * ```log
 *
 * ```
 */
function* markdownParser(lines: Iterable<string>): Generator<string> {
  let found = false;
  for (const line of lines) {
    if (line.startsWith("```log")) found = true;
    else if (line.startsWith("```")) break;
    else if (found) yield line;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of getIO().stdinStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

/** Script starts here. */
export async function appstart(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parser = new ArgumentParser("atvlog");
  parser.addArgument("file", { help: "log file" });
  parser.addArgument("-o", "--output", { default: null, help: "output file" });
  parser.addArgument("-f", "--format", { default: "plain", choices: ["plain", "markdown"], help: "input format" });
  parser.addArgument("-e", "--env", { default: false, action: "store_true", help: "read from environment variable" });
  parser.addArgument("-w", "--web-server", { default: false, action: "store_true", help: "serve output as web page" });
  parser.addArgument("-p", "--port", { default: 8008, type: (v) => parseInt(v, 10), help: "web server port" });

  let args;
  try {
    args = parser.parseArgs(argv);
  } catch (ex) {
    if (ex instanceof SystemExit) return ex.code;
    throw ex;
  }

  const generateLog = async (lines: string[]): Promise<number> => {
    const page = generateLogPage(args.format === "markdown" ? markdownParser(lines) : lines, ["atvlog", ...argv].join(" "));
    if (!page) {
      eprint("No page generated (missing log points)");
      return 1;
    }

    if (args.web_server) await servePage(page, args.port);
    else if (args.output) writeFileSync(args.output, page, "utf-8");
    else print(page);
    return 0;
  };

  if (args.env) {
    const value = process.env[args.file];
    if (value === undefined) throw new Error(`environment variable ${args.file} not set`);
    await generateLog(value.split(/\r?\n/));
  } else if (args.file === "-") {
    await generateLog(splitLinesKeepEnds(await readStdin()));
  } else {
    await generateLog(splitLinesKeepEnds(readFileSync(args.file, "utf-8")));
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await appstart());
}
