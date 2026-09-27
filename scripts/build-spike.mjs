import { rmSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
rmSync(`${root}/www`, { recursive: true, force: true });
cpSync(`${root}/spike`, `${root}/www`, { recursive: true });
