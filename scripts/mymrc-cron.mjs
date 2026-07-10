#!/usr/bin/env node
// Long-running cron host for the MyMRC scrape worker.
//
// Runs `scripts/mymrc-scrape.mjs` once on boot and once per hour
// thereafter. We use a long-running Node process with `setTimeout`
// rather than docker-cron because the Playwright browser binaries
// take ~2-3s to launch — keeping the process alive lets the next
// hourly tick reuse the cached storage state without re-spawning a
// container.
//
// Restart policy is `unless-stopped` in compose; if the loop ever
// throws past the per-iteration try/catch, the container restart
// brings us back to the same shape (boot scrape → hourly).
//
// Per-tick timing: we anchor to the next "top of hour" so two scrapes
// don't collide if the previous one runs long. The boot scrape fires
// immediately so a fresh container deploy populates the queue
// promptly without waiting up to 60 minutes.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRAPE_SCRIPT = resolve(__dirname, 'mymrc-scrape.mjs');
const HOUR_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 5_000; // Tiny delay so postgres healthcheck likely settled.

let inFlight = false;
let stopping = false;

function logTs(message) {
  console.log(`[mymrc-cron ${new Date().toISOString()}] ${message}`);
}

function runScrapeOnce() {
  if (stopping) return;
  if (inFlight) {
    logTs('previous scrape still running, skipping this tick');
    return;
  }
  inFlight = true;
  logTs(`spawning ${SCRAPE_SCRIPT}`);
  const child = spawn(process.execPath, [SCRAPE_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    inFlight = false;
    if (signal) {
      logTs(`scrape exited via signal ${signal}`);
    } else {
      logTs(`scrape exit code ${code ?? '?'}`);
    }
  });
  child.on('error', (err) => {
    inFlight = false;
    logTs(`scrape spawn error: ${err.message}`);
  });
}

function msUntilNextHour() {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() + 1,
      0,
      0,
      0,
    ),
  );
  return Math.max(1_000, next.getTime() - now.getTime());
}

function scheduleNext() {
  if (stopping) return;
  const delay = msUntilNextHour();
  logTs(`next scrape in ${(delay / 1000).toFixed(0)}s`);
  setTimeout(() => {
    runScrapeOnce();
    scheduleNext();
  }, delay); // NOT .unref() — this timer must keep the daemon alive (else the
  // process exits after the boot scrape and `unless-stopped` turns it into a
  // continuous restart/scrape loop).
}

function setupShutdown() {
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logTs(`received ${signal}, exiting`);
    // Give an in-flight scrape up to 30s to wrap before the container
    // is force-killed.
    setTimeout(() => process.exit(0), 30_000).unref();
    if (!inFlight) process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

setupShutdown();
logTs('cron host started');
setTimeout(() => {
  runScrapeOnce();
  scheduleNext();
}, BOOT_DELAY_MS);
