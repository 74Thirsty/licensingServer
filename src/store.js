import fs from 'fs';
import path from 'path';
import { loadEnvFile } from './env.js';

loadEnvFile();

const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data.json');

const DEFAULT_STATE = {
  products: {},
  licenses: {},
  activations: {},
  audit: [],
  lockouts: {},
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export function loadState() {
  if (!fs.existsSync(DATA_FILE)) return clone(DEFAULT_STATE);
  const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return { ...clone(DEFAULT_STATE), ...state };
}

export function saveState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}
