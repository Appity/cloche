#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { quote } from 'shell-quote';

const program = new Command();

const RUN_DIR = path.resolve(process.cwd(), '.cloche');
const CONFIG_FILE = path.join(RUN_DIR, 'config');

// Default log rotation settings
const DEFAULT_CONFIG = {
    maxLogLines: 100000,
    logTrimThreshold: 110000, // Trim when 10% over max
};

/**
 * Load configuration from .cloche/config if it exists.
 * Supports CLOCHE_MAX_LOG_LINES and CLOCHE_LOG_TRIM_THRESHOLD.
 */
function loadConfig() {
    const config = { ...DEFAULT_CONFIG };

    if (fs.existsSync(CONFIG_FILE)) {
        const rcEnv = parseEnvFile(CONFIG_FILE);

        if (rcEnv.CLOCHE_MAX_LOG_LINES) {
            const val = parseInt(rcEnv.CLOCHE_MAX_LOG_LINES, 10);
            if (!isNaN(val) && val > 0) {
                config.maxLogLines = val;
                // Auto-calculate threshold if not explicitly set (10% over max)
                config.logTrimThreshold = Math.ceil(val * 1.1);
            }
        }

        if (rcEnv.CLOCHE_LOG_TRIM_THRESHOLD) {
            const val = parseInt(rcEnv.CLOCHE_LOG_TRIM_THRESHOLD, 10);
            if (!isNaN(val) && val > config.maxLogLines) {
                config.logTrimThreshold = val;
            }
        }
    }

    return config;
}

/**
 * Strip ANSI escape codes and other control characters from a string.
 * Preserves newlines but removes colors, cursor movements, etc.
 */
function stripAnsi(str) {
    // Remove ANSI escape sequences (colors, cursor movement, etc.)
    // eslint-disable-next-line no-control-regex
    return str
        .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')  // CSI sequences (colors, cursor, etc.)
        .replace(/\x1B\][^\x07]*\x07/g, '')     // OSC sequences (title, etc.)
        .replace(/\x1B[PX^_][^\x1B]*\x1B\\/g, '') // DCS, SOS, PM, APC sequences
        .replace(/\x1B\[\?[0-9;]*[hl]/g, '')    // Private mode set/reset
        .replace(/\x1B[()][AB012]/g, '')        // Character set selection
        .replace(/\x1B[78]/g, '')               // Save/restore cursor
        .replace(/\x1B[=>]/g, '')               // Keypad mode
        .replace(/\r/g, '');                    // Remove carriage returns
}

if (!fs.existsSync(RUN_DIR)) {
    fs.mkdirSync(RUN_DIR, { recursive: true });

    // Create .gitignore to exclude logs/pids but allow config and scripts
    const gitignorePath = path.join(RUN_DIR, '.gitignore');
    const gitignoreContent = `# Ignore everything by default
*

# Allow useful files to be tracked
!.gitignore
!config
!*.sh
`;
    fs.writeFileSync(gitignorePath, gitignoreContent);
}

/**
 * Parse a .env file and return an object of key-value pairs.
 * Handles comments, empty lines, quotes, and basic escape sequences.
 */
function parseEnvFile(filePath) {
    const env = {};
    if (!fs.existsSync(filePath)) {
        return env;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) continue;

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        // Handle quoted values (preserve # inside quotes)
        if ((value.startsWith('"') && value.includes('"', 1)) ||
            (value.startsWith("'") && value.includes("'", 1))) {
            const quote = value[0];
            const endQuote = value.indexOf(quote, 1);
            value = value.slice(1, endQuote);
        } else {
            // Unquoted: strip inline comments
            const commentIndex = value.indexOf('#');
            if (commentIndex !== -1) {
                value = value.slice(0, commentIndex).trim();
            }
        }

        env[key] = value;
    }
    return env;
}

/**
 * Collect -e KEY=VALUE options into an object
 */
function collectEnvVar(value, previous) {
    const eqIndex = value.indexOf('=');
    if (eqIndex === -1) {
        console.error(`Error: Invalid -e format '${value}'. Expected KEY=VALUE`);
        process.exit(1);
    }
    const key = value.slice(0, eqIndex);
    const val = value.slice(eqIndex + 1);
    return { ...previous, [key]: val };
}

program
    .name('cloche')
    .description('A lightweight process supervisor for development')
    .version('0.1.0')
    .argument('[unit]', 'The name of the service')
    .option('--restart', 'Restart the service')
    .option('--kill', 'Kill the service')
    .option('-w, --workdir <dir>', 'Working directory for the subprocess')
    .option('--ps', 'List all managed processes')
    .option('-e, --env <KEY=VALUE>', 'Set environment variable (repeatable)', collectEnvVar, {})
    .option('--env-file <path>', 'Load environment from file (default: .env)')
    .option('--no-env-file', 'Disable auto-loading .env')
    .option('--log', 'Enable persistent logging (no trimming)')
    .option('--dump-log', 'Dump the entire log file')
    .option('--search <text>', 'Search log file for matching text (case-insensitive)')
    .option('-A, --after <n>', 'Show n lines after each match', parseInt)
    .option('-B, --before <n>', 'Show n lines before each match', parseInt)
    .option('-C, --context <n>', 'Show n lines before and after each match', parseInt)
    .option('-E, --stderr', 'Filter to stderr only (lines prefixed with "2>")')
    .option('--tail [n]', 'Show last n lines of log (default: 500)', (val) => val === undefined ? 500 : parseInt(val))
    .argument('[command...]', 'The command to run')
    .action((unit, commandParts, options) => {
        // Warn if context flags used without --search
        if ((options.after || options.before || options.context) && options.search === undefined) {
            console.warn("Warning: -A/-B/-C (--after/--before/--context) only apply with --search");
        }

        if (options.ps) {
            handlePs();
        } else if (unit) {
            validateUnitName(unit);
            if (options.kill) {
                handleKill(unit);
            } else if (options.restart) {
                handleRestart(unit);
            } else if (options.dumpLog) {
                handleDumpLog(unit, options);
            } else if (options.search !== undefined) {
                handleSearch(unit, options);
            } else if (options.tail !== undefined) {
                handleTail(unit, options);
            } else {
                handleRun(unit, commandParts, options);
            }
        } else {
            console.error("Error: Service unit name is required unless using --ps.");
            process.exit(1);
        }
    });

program.parse();

/**
 * Validate unit name to prevent path traversal and shell injection.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
function validateUnitName(unit) {
    if (!/^[a-zA-Z0-9_-]+$/.test(unit)) {
        console.error(`Error: Invalid unit name '${unit}'.`);
        console.error("Unit names can only contain letters, numbers, hyphens, and underscores.");
        process.exit(1);
    }
}

function getPidFilePath(unit) {
    return path.join(RUN_DIR, `${unit}.pid`);
}

function getScriptFilePath(unit) {
    return path.join(RUN_DIR, `${unit}.sh`);
}

function getLogFilePath(unit) {
    return path.join(RUN_DIR, `${unit}.log`);
}

function handlePs() {
    const files = fs.readdirSync(RUN_DIR);
    const units = new Set();

    files.forEach(f => {
        if (f.endsWith('.pid') || f.endsWith('.sh')) {
            units.add(f.replace(/\.(pid|sh)$/, ''));
        }
    });

    // Sort units for display
    const sortedUnits = Array.from(units).sort();

    console.log(String("UNIT").padEnd(20) + String("PID").padEnd(10) + String("STATUS").padEnd(15) + String("PORTS").padEnd(15) + "COMMAND");
    console.log("-".repeat(95));

    if (sortedUnits.length === 0) {
        console.log("No managed processes found.");
        return;
    }

    // Capture process tree snapshot once
    let ppidMap = new Map();
    try {
        const psOutput = execSync('ps -eo pid,ppid', { encoding: 'utf8' });
        const lines = psOutput.trim().split('\n').slice(1); // skip header
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const pid = parts[0];
                const ppid = parts[1];
                if (!ppidMap.has(ppid)) {
                    ppidMap.set(ppid, []);
                }
                ppidMap.get(ppid).push(pid);
            }
        });
    } catch (e) {
        // Ignore ps errors
    }

    function getDescendants(pid) {
        let descendants = [];
        const queue = [pid];
        while (queue.length > 0) {
            const current = queue.shift();
            const children = ppidMap.get(current) || [];
            children.forEach(child => {
                descendants.push(child);
                queue.push(child);
            });
        }
        return descendants;
    }

    sortedUnits.forEach(unit => {
        const pidFile = getPidFilePath(unit);
        const scriptFile = getScriptFilePath(unit);

        let pid = '-';
        let status = 'STOPPED';
        let ports = '-';
        let command = '-';

        if (fs.existsSync(pidFile)) {
            try {
                const pidVal = fs.readFileSync(pidFile, 'utf8').trim();
                pid = pidVal;
                process.kill(parseInt(pidVal, 10), 0);
                status = 'RUNNING';

                // Get descendant PIDs including self
                const allPids = [pidVal, ...getDescendants(pidVal)];
                const pidList = allPids.join(',');

                // Get ports
                try {
                    // -P (no port names), -n (no host names), -iTCP -sTCP:LISTEN
                    const lsofOutput = execSync(`lsof -a -p ${pidList} -iTCP -sTCP:LISTEN -P -n`, {
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'ignore']
                    });

                    const openPorts = [];
                    lsofOutput.split('\n').forEach(line => {
                        if (line.includes('(LISTEN)')) {
                            const match = line.match(/:(\d+)\s+\(LISTEN\)/);
                            if (match) {
                                openPorts.push(match[1]);
                            }
                        }
                    });
                    if (openPorts.length > 0) {
                        ports = [...new Set(openPorts)].sort((a, b) => parseInt(a) - parseInt(b)).join(', ');
                    }
                } catch (e) {
                    // lsof returns exit code 1 if no files found
                }

            } catch (e) {
                // If kill throws, process doesn't exist (or permission denied)
                status = 'DEAD';
            }
        }

        if (fs.existsSync(scriptFile)) {
            try {
                const scriptContent = fs.readFileSync(scriptFile, 'utf8');
                const lines = scriptContent.split('\n');
                const execLine = lines.find(l => l.startsWith('exec '));
                if (execLine) {
                    command = execLine.substring(5).trim();
                } else {
                    command = '(unknown script format)';
                }
            } catch (e) {
                command = '(error reading script)';
            }
        }

        console.log(
            unit.padEnd(20) +
            pid.padEnd(10) +
            status.padEnd(15) +
            ports.padEnd(15) +
            (command.length > 35 ? command.substring(0, 32) + '...' : command)
        );
    });
}


function handleRestart(unit) {
    const pidFile = getPidFilePath(unit);

    if (!fs.existsSync(pidFile)) {
        console.error(`Error: PID file for '${unit}' not found at ${pidFile}`);
        process.exit(1);
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);

    try {
        process.kill(pid, 0); // Check if process exists
    } catch (e) {
        console.error(`Error: Process ${pid} for '${unit}' is not running.`);
        // Optional: cleanup PID file?
        process.exit(1);
    }

    console.log(`Sending restart signal (SIGUSR1) to process ${pid} (${unit})...`);
    try {
        process.kill(pid, 'SIGUSR1');
        console.log("Signal sent.");
    } catch (e) {
        console.error("Failed to send signal:", e.message);
        process.exit(1);
    }
}

function handleKill(unit) {
    const pidFile = getPidFilePath(unit);

    if (!fs.existsSync(pidFile)) {
        console.error(`Error: PID file for '${unit}' not found at ${pidFile}`);
        process.exit(1);
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);

    try {
        process.kill(pid, 0); // Check if process exists
    } catch (e) {
        console.log(`Process ${pid} for '${unit}' is not running. Cleaning up PID file.`);
        fs.unlinkSync(pidFile);
        process.exit(0);
    }

    console.log(`Sending SIGTERM to process ${pid} (${unit})...`);
    try {
        process.kill(pid, 'SIGTERM');
        console.log(`Process ${pid} terminated.`);
    } catch (e) {
        console.error("Failed to kill process:", e.message);
        process.exit(1);
    }
}

function handleRun(unit, commandParts, options) {
    const pidFile = getPidFilePath(unit);
    const scriptFile = getScriptFilePath(unit);
    const workdir = options.workdir;

    // Set terminal title
    process.stdout.write(`\x1b]0;${unit}\x07`);

    // If new command provided, write the script
    if (commandParts && commandParts.length > 0) {
        // Use path relative to project root (parent of .cloche) for portability
        const projectRoot = path.dirname(RUN_DIR);
        const absoluteCwd = workdir ? path.resolve(process.cwd(), workdir) : process.cwd();
        const relativeCwd = path.relative(projectRoot, absoluteCwd) || '.';
        // shell-quote escapes colons which is unnecessary and annoys linters
        const quotedCommand = quote(commandParts).replace(/\\:/g, ':');
        const scriptContent = [
            '#!/bin/sh',
            'set -e',
            `cd "$(dirname "$0")/../${relativeCwd}"`,
            `exec ${quotedCommand}`
        ].join('\n');

        fs.writeFileSync(scriptFile, scriptContent, { mode: 0o755 });
        console.log(`[cloche:${unit}] Created start script: ${scriptFile}`);
    } else {
        // No command provided, verify script exists
        if (!fs.existsSync(scriptFile)) {
            console.error(`Error: No command provided and no script found for '${unit}' at ${scriptFile}`);
            process.exit(1);
        }
        console.log(`[cloche:${unit}] Using existing script: ${scriptFile}`);
    }

    // Build environment: base process.env + .env file + -e overrides
    const spawnEnv = { ...process.env };

    // If we're running in a TTY, signal to subprocesses that colors are supported.
    // Since we pipe stdout/stderr for tee, subprocesses can't detect TTY directly.
    // We set FORCE_COLOR (Node.js/chalk) and CLICOLOR_FORCE (BSD convention).
    if (process.stdout.isTTY) {
        spawnEnv.FORCE_COLOR = spawnEnv.FORCE_COLOR ?? '1';
        spawnEnv.CLICOLOR_FORCE = spawnEnv.CLICOLOR_FORCE ?? '1';
    }

    // Load .env file (auto-load .env by default, or use --env-file path)
    if (options.envFile !== false) {
        const envFilePath = typeof options.envFile === 'string'
            ? path.resolve(process.cwd(), options.envFile)
            : path.resolve(process.cwd(), '.env');

        if (fs.existsSync(envFilePath)) {
            const fileEnv = parseEnvFile(envFilePath);
            const loadedKeys = Object.keys(fileEnv);
            if (loadedKeys.length > 0) {
                console.log(`[cloche:${unit}] Loaded ${loadedKeys.length} vars from ${path.basename(envFilePath)}`);
            }
            Object.assign(spawnEnv, fileEnv);
        }
    }

    // Apply -e overrides (highest priority)
    if (options.env && Object.keys(options.env).length > 0) {
        console.log(`[cloche:${unit}] Applying overrides: ${Object.keys(options.env).join(', ')}`);
        Object.assign(spawnEnv, options.env);
    }

    // Write own PID
    fs.writeFileSync(pidFile, process.pid.toString());

    // Herald with restart hint
    console.log(`[cloche:${unit}] Press \x1b[1m^T\x1b[0m to restart`);


    // Setup cleanup on exit
    const cleanup = () => {
        if (fs.existsSync(pidFile)) {
            try {
                // Only delete if it holds our PID (race condition protection)
                const currentPid = fs.readFileSync(pidFile, 'utf8');
                if (currentPid === process.pid.toString()) {
                    fs.unlinkSync(pidFile);
                }
            } catch (e) { /* ignore */ }
        }
    };

    // We don't rely only on explicit exit, signal handlers will do it.

    let child;
    let restarting = false;
    const logFile = getLogFilePath(unit);

    // Load config (may have overrides from .cloche/config)
    const config = loadConfig();
    const persistentLog = options.log === true;

    // Log management state
    let logStream = fs.createWriteStream(logFile, { flags: 'w' });
    let logLineCount = 0;
    let trimPending = false;

    /**
     * Write to log with line counting and automatic trimming.
     * Trimming is disabled when --log is specified (persistent logging).
     * @param {Buffer|string} data - The data to write
     * @param {boolean} isStderr - Whether this is from stderr (prefixes lines with "2>")
     */
    const writeToLog = (data, isStderr = false) => {
        const stripped = stripAnsi(data.toString());

        // For stderr, prefix each line with "2>" for filtering
        let output;
        if (isStderr) {
            output = stripped.split('\n').map((line, i, arr) => {
                // Don't prefix empty trailing line from split
                if (i === arr.length - 1 && line === '') return '';
                return `2>${line}`;
            }).join('\n');
        } else {
            output = stripped;
        }

        logStream.write(output);

        // Skip trimming if persistent logging is enabled
        if (persistentLog) return;

        // Count newlines in this chunk
        const newlineCount = (stripped.match(/\n/g) || []).length;
        logLineCount += newlineCount;

        // Schedule trim if we've exceeded threshold and one isn't pending
        if (logLineCount >= config.logTrimThreshold && !trimPending) {
            trimPending = true;
            // Use setImmediate to avoid blocking the data handler
            setImmediate(trimLogFile);
        }
    };

    /**
     * Trim log file to maxLogLines, keeping the most recent lines.
     */
    const trimLogFile = () => {
        // End current stream before modifying file
        logStream.end(() => {
            try {
                const content = fs.readFileSync(logFile, 'utf8');
                const lines = content.split('\n');

                if (lines.length > config.maxLogLines) {
                    // Keep last maxLogLines lines
                    const trimmedLines = lines.slice(-config.maxLogLines);
                    fs.writeFileSync(logFile, trimmedLines.join('\n'));
                    logLineCount = trimmedLines.length;
                }
            } catch (e) {
                console.error(`[cloche:${unit}] Error trimming log: ${e.message}`);
            }

            // Reopen stream in append mode
            logStream = fs.createWriteStream(logFile, { flags: 'a' });
            trimPending = false;
        });
    };

    const startChild = () => {
        console.log(`[cloche:${unit}] Spawning script...`);

        // Spawn with piped stdout/stderr so we can tee to console and log
        child = spawn(scriptFile, [], {
            stdio: ['inherit', 'pipe', 'pipe'],
            env: spawnEnv
        });

        // Tee stdout: show on console (with ANSI), write stripped to log
        child.stdout.on('data', (data) => {
            process.stdout.write(data);
            writeToLog(data, false);
        });

        // Tee stderr: show on console (with ANSI), write stripped to log (prefixed with "2>")
        child.stderr.on('data', (data) => {
            process.stderr.write(data);
            writeToLog(data, true);
        });

        child.on('close', (code) => {
            if (restarting) {
                console.log(`[cloche:${unit}] Process exited for restart. Restarting...`);
                restarting = false;
                startChild();
            } else {
                console.log(`[cloche:${unit}] Process exited with code ${code}.`);
                logStream.end();
                cleanup();
                process.exit(code !== null ? code : 1);
            }
        });

        child.on('error', (err) => {
            console.error(`[cloche:${unit}] Failed to start subprocess: ${err.message}`);
            logStream.end();
            cleanup();
            process.exit(1);
        });
    };

    // Start initial process
    startChild();

    // Signal Handlers - SIGUSR1 (programmatic) and SIGINFO (^T on macOS) trigger restart
    ['SIGUSR1', 'SIGINFO'].forEach(signal => {
        process.on(signal, () => {
            const hint = signal === 'SIGINFO' ? ' (^T)' : '';
            console.log(`[cloche:${unit}] Received ${signal}${hint}. Restarting subprocess...`);
            restarting = true;
            if (child) {
                child.kill('SIGTERM');
            }
        });
    });

    ['SIGINT', 'SIGTERM'].forEach(signal => {
        process.on(signal, () => {
            console.log(`[cloche:${unit}] Received ${signal}. Stopping subprocess...`);
            if (child) {
                child.kill(signal);
            }
            cleanup();
            process.exit(0); // Forwarding exit code isn't trivial if we kill it ourselves, but 0 is safe for SIGINT/TERM usually.
        });
    });
}

/**
 * Search log file for matching text with grep-style context options.
 */
function handleSearch(unit, options) {
    const logFile = getLogFilePath(unit);

    if (!fs.existsSync(logFile)) {
        console.error(`Error: Log file for '${unit}' not found at ${logFile}`);
        console.error(`Hint: Run the service first to generate logs.`);
        process.exit(1);
    }

    const searchText = options.search;
    const linesAfter = options.context ?? options.after ?? 0;
    const linesBefore = options.context ?? options.before ?? 0;
    const stderrOnly = options.stderr === true;

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');

    // Find all matching line indices
    const matches = [];
    const searchLower = searchText.toLowerCase();

    lines.forEach((line, index) => {
        // If --stderr filter is active, only match stderr lines (prefixed with "2>")
        if (stderrOnly && !line.startsWith('2>')) {
            return;
        }

        // Get the actual content (strip stderr prefix for matching if present)
        const lineContent = line.startsWith('2>') ? line.slice(2) : line;

        if (lineContent.toLowerCase().includes(searchLower)) {
            matches.push(index);
        }
    });

    if (matches.length === 0) {
        const filterNote = stderrOnly ? ' in stderr' : '';
        console.log(`No matches found for "${searchText}"${filterNote} in ${logFile}`);
        process.exit(0);
    }

    // Build set of line indices to display (including context)
    const linesToShow = new Set();
    matches.forEach(matchIndex => {
        const start = Math.max(0, matchIndex - linesBefore);
        const end = Math.min(lines.length - 1, matchIndex + linesAfter);
        for (let i = start; i <= end; i++) {
            linesToShow.add(i);
        }
    });

    // Convert to sorted array for output
    const sortedIndices = Array.from(linesToShow).sort((a, b) => a - b);

    // Output with line numbers and separators for non-contiguous sections
    let lastIndex = -2;
    const lineNumWidth = String(lines.length).length;

    sortedIndices.forEach(index => {
        // Add separator if there's a gap
        if (lastIndex !== -2 && index > lastIndex + 1) {
            console.log('--');
        }

        const lineNum = String(index + 1).padStart(lineNumWidth, ' ');
        const isMatch = matches.includes(index);
        const separator = isMatch ? ':' : '-';
        const line = lines[index];

        // Highlight match in the output (match against content without prefix)
        if (isMatch) {
            const highlighted = line.replace(
                new RegExp(`(${escapeRegex(searchText)})`, 'gi'),
                '\x1b[1;31m$1\x1b[0m'
            );
            console.log(`${lineNum}${separator}${highlighted}`);
        } else {
            console.log(`${lineNum}${separator}${line}`);
        }

        lastIndex = index;
    });

    const filterNote = stderrOnly ? ' (stderr only)' : '';
    console.log(`\n${matches.length} match${matches.length === 1 ? '' : 'es'} found${filterNote}.`);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Show the last N lines of the log file.
 */
function handleTail(unit, options) {
    const logFile = getLogFilePath(unit);
    const n = options.tail || 500;
    const stderrOnly = options.stderr === true;

    if (!fs.existsSync(logFile)) {
        console.error(`Error: Log file for '${unit}' not found at ${logFile}`);
        console.error(`Hint: Run the service first to generate logs.`);
        process.exit(1);
    }

    const content = fs.readFileSync(logFile, 'utf8');
    let lines = content.split('\n');

    // Remove trailing empty line if present
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    // Filter to stderr only if requested
    let filteredLines;
    let lineMapping; // Maps filtered index to original line number
    if (stderrOnly) {
        filteredLines = [];
        lineMapping = [];
        lines.forEach((line, i) => {
            if (line.startsWith('2>')) {
                filteredLines.push(line);
                lineMapping.push(i + 1); // 1-based line numbers
            }
        });
    } else {
        filteredLines = lines;
        lineMapping = lines.map((_, i) => i + 1);
    }

    const totalFiltered = filteredLines.length;
    const startIndex = Math.max(0, totalFiltered - n);
    const tailLines = filteredLines.slice(startIndex);
    const tailLineNumbers = lineMapping.slice(startIndex);

    if (tailLines.length === 0) {
        const filterNote = stderrOnly ? ' (stderr only)' : '';
        console.log(`Log file for '${unit}' is empty${filterNote}.`);
        process.exit(0);
    }

    const lineNumWidth = String(lines.length).length;

    tailLines.forEach((line, i) => {
        const lineNum = String(tailLineNumbers[i]).padStart(lineNumWidth, ' ');
        console.log(`${lineNum}:${line}`);
    });

    if (startIndex > 0) {
        const filterNote = stderrOnly ? ' stderr' : '';
        console.log(`\n(showing last ${tailLines.length} of ${totalFiltered}${filterNote} lines)`);
    }
}

/**
 * Dump the entire log file.
 */
function handleDumpLog(unit, options) {
    const logFile = getLogFilePath(unit);
    const stderrOnly = options.stderr === true;

    if (!fs.existsSync(logFile)) {
        console.error(`Error: Log file for '${unit}' not found at ${logFile}`);
        console.error(`Hint: Run the service with --log to enable persistent logging.`);
        process.exit(1);
    }

    const content = fs.readFileSync(logFile, 'utf8');

    if (content.length === 0) {
        console.log(`Log file for '${unit}' is empty.`);
        process.exit(0);
    }

    // Filter to stderr only if requested
    let output;
    if (stderrOnly) {
        const lines = content.split('\n');
        const stderrLines = lines.filter(line => line.startsWith('2>'));
        if (stderrLines.length === 0) {
            console.log(`No stderr output in log file for '${unit}'.`);
            process.exit(0);
        }
        output = stderrLines.join('\n');
    } else {
        output = content;
    }

    // Output without line numbers for easy piping/processing
    process.stdout.write(output);

    // Ensure trailing newline
    if (!output.endsWith('\n')) {
        process.stdout.write('\n');
    }
}
