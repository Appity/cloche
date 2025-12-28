# cloche

A lightweight process supervisor for development — run, restart, and manage services with ease.

## Features

- **Named units** — Run services with memorable names like `web`, `api`, `worker`
- **Instant restart** — Press `^T` (Ctrl+T on macOS) to restart the subprocess without leaving your terminal
- **Process listing** — See all managed processes, their status, and listening ports at a glance
- **Environment management** — Automatically loads `.env` files, with CLI overrides
- **Persistent scripts** — Commands are saved, so restarting a unit doesn't require re-typing
- **Log capture** — STDOUT/STDERR saved to searchable logs with ANSI codes stripped
- **Log search** — Case-insensitive search with grep-style context (`--after`, `--before`, `--context`)
- **Log tail** — View last N lines of logs (default 500)
- **Persistent logging** — Use `--log` for full history without trimming

## Installation

```bash
npm install -g @appity/cloche
```

Or run directly with npx:

```bash
npx @appity/cloche --help
```

## Quick Start

```bash
# Start a web server as the "web" unit
cloche web npm run dev

# In another terminal, start an API server
cloche api node server.js

# List all running processes
cloche --ps

# Restart a service (sends SIGUSR1)
cloche web --restart

# Stop a service
cloche web --kill
```

## Usage

```
cloche [options] [unit] [command...]

Arguments:
  unit                    The name of the service
  command                 The command to run

Options:
  -V, --version           output the version number
  --restart               Restart the service
  --kill                  Kill the service
  -w, --workdir <dir>     Working directory for the subprocess
  --ps                    List all managed processes
  -e, --env <KEY=VALUE>   Set environment variable (repeatable)
  --env-file <path>       Load environment from file (default: .env)
  --no-env-file           Disable auto-loading .env
  --log                   Enable persistent logging (no trimming)
  --dump-log              Dump the entire log file
  --search <text>         Search log file for matching text (case-insensitive)
  -A, --after <n>         Show n lines after each match
  -B, --before <n>        Show n lines before each match
  -C, --context <n>       Show n lines before and after each match
  -E, --stderr            Filter to stderr only
  --tail [n]              Show last n lines of log (default: 500)
  -h, --help              display help for command
```

## Examples

### Running Services

```bash
# Start a Rails server
cloche rails bin/rails server

# Start with a custom working directory
cloche api --workdir ./backend node server.js

# Start with environment overrides
cloche web -e PORT=4000 -e NODE_ENV=development npm start

# Use a custom env file
cloche api --env-file .env.local npm run dev
```

### Managing Services

```bash
# List all services with status and ports
cloche --ps

# Output:
# UNIT                PID       STATUS         PORTS          COMMAND
# -----------------------------------------------------------------------------------------------
# api                 12345     RUNNING        3001           node server.js
# web                 12346     RUNNING        3000, 3001     npm run dev
# worker              -         STOPPED        -              node worker.js

# Restart a service (triggers graceful restart)
cloche api --restart

# Kill a service
cloche worker --kill
```

### Restarting from the Terminal

When a service is running, press **`^T`** (Ctrl+T) to trigger an instant restart. This sends `SIGINFO` on macOS, which cloche intercepts to restart the subprocess.

You can also restart programmatically from another terminal:

```bash
cloche web --restart
```

### Searching Logs

cloche captures all output (STDOUT/STDERR) to a log file with ANSI codes stripped for easy searching. Search is **case-insensitive** by default.

STDERR lines are prefixed with `2>` in the log, allowing you to filter errors specifically:

```bash
# Search for "error" in the web service logs (case-insensitive)
cloche web --search error

# Search only in stderr output
cloche web --search error --stderr
cloche web --search error -E  # short form

# Show 5 lines of context around each match
cloche web --search error --context 5
cloche web --search error -C 5  # short form

# Show 3 lines before and 10 lines after each match
cloche web --search "connection refused" --before 3 --after 10
cloche web --search "connection refused" -B 3 -A 10  # short form

# View the last 100 lines of logs
cloche api --tail 100

# View only stderr from the last 500 lines
cloche api --tail --stderr

# View the last 500 lines (default)
cloche api --tail

# Dump the entire log file (for piping or external processing)
cloche api --dump-log
cloche api --dump-log --stderr  # dump only stderr
cloche api --dump-log | grep -i "warning"
```

### Log Persistence

By default, logs are automatically trimmed to 100,000 lines to prevent unbounded growth. Use `--log` for persistent logging without trimming:

```bash
# Enable persistent logging (no trimming)
cloche web --log npm run dev
```

Logs are stored in `.cloche/<unit>.log` and are overwritten each time the service starts (but preserved across `^T` restarts).

## How It Works

- **State directory** — cloche creates a `.cloche/` directory in your current working directory to store PID files, shell scripts, and logs
- **Shell scripts** — Each unit's command is saved as a shell script (`.cloche/<unit>.sh`), allowing you to restart without re-specifying the command
- **PID tracking** — cloche writes its own PID to `.cloche/<unit>.pid`, enabling `--kill` and `--restart` operations
- **Log capture** — STDOUT/STDERR are captured to `.cloche/<unit>.log` with ANSI codes stripped; stderr lines prefixed with `2>` for filtering; auto-trims to 100K lines (unless `--log` is used)
- **Signal handling** — `SIGUSR1` and `SIGINFO` (^T on macOS) trigger subprocess restarts; `SIGINT` and `SIGTERM` cleanly shut down

## Configuration

You can customize cloche behavior by creating a `.cloche/config` file with `.env`-style settings:

```bash
# Maximum lines to keep in log files (default: 100000)
CLOCHE_MAX_LOG_LINES=50000

# Trim threshold - when to trigger log trimming (default: 10% over max)
# Optional: auto-calculated as max * 1.1 if not specified
CLOCHE_LOG_TRIM_THRESHOLD=55000
```

The config file is read each time a service starts, so changes take effect on the next service start or restart.

## Environment Variables

cloche automatically loads `.env` from the current directory. Environment priority (highest to lowest):

1. `-e KEY=VALUE` command line flags
2. `--env-file` specified file (or `.env` by default)
3. Inherited environment from parent process

## License

MIT
