#!/usr/bin/env node
// 打开 NapCat 的网页（自动带上 token）
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const cfgIndex = args.indexOf('--config');
const configFile = cfgIndex >= 0 ? args[cfgIndex + 1] : 'config.json';
const cfg = loadConfig({ file: configFile });

const napcat = cfg.napcat || {};
const base = String(napcat.webui || 'http://127.0.0.1:6099/webui');
const token = String(napcat.webuiToken || '').trim();
const url = token ? `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : base;

console.log(`打开：${url}`);
const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
child.unref();
