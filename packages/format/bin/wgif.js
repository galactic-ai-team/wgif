#!/usr/bin/env node
/** Stable npm bin entrypoint. Run `npm run build` before using this CLI. */
import { runCli } from '../dist/src/cli.js';
void runCli(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
