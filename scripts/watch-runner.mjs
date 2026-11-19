#!/usr/bin/env node
import path from 'node:path';
import { createWatchIO } from './lib/lifecycle-watch-io.mjs';
import { serveWatches } from './lib/lifecycle-watch-runner.mjs';
const [flag,root,...extra] = process.argv.slice(2);
if (flag !== '--state-root' || !path.isAbsolute(root ?? '') || extra.length) throw new Error('absolute --state-root required');
await serveWatches({stateRoot:root,io:createWatchIO()});
