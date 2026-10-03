// `npx shipcue init --cloud <public key>` (shipcue report 5fdbd60f): wires the button to a
// shipcue Cloud project, with no database or handler of your own. Prints the env line and a small
// client component; --write adds them (never overwriting). Next.js only.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { flagValue } from './doctor';

export const CLOUD_ORIGIN = 'https://shipcue.ibuildathing.com';
const ENV_NAME = 'NEXT_PUBLIC_SHIPCUE_ENDPOINT';

export function cloudInit(o: { key: string; origin?: string; srcDir?: boolean }) {
  const origin = (o.origin ?? CLOUD_ORIGIN).replace(/\/+$/, '');
  return {
    envLine: `${ENV_NAME}=${origin}/api/cloud/p/${o.key}`,
    componentPath: `${o.srcDir ? 'src/' : ''}components/shipcue-button.tsx`,
    component: `'use client';
import { ReportButton } from 'shipcue/react';

/** shipcue Cloud's report button. Pass who is signed in, so the CueLog shows who filed each report. */
export function ShipcueButton({ reporter }: { reporter?: string | null }) {
  return <ReportButton endpoint={process.env.${ENV_NAME}} reporter={reporter ?? undefined} />;
}
`,
  };
}

const USAGE = 'usage: npx shipcue init --cloud <public key, pk_…> [--write] [--origin https://…]';

export async function runInit(o: { cwd: string; args: string[] }): Promise<{ output: string; code: number }> {
  const key = flagValue(o.args, '--cloud');
  if (!key || !/^pk_[A-Za-z0-9]+$/.test(key)) {
    return { output: `The button key from your Cloud project's Setup starts with pk_ (an agent token, sca_…, never goes in the browser).\n${USAGE}\n`, code: 1 };
  }
  const srcDir = existsSync(join(o.cwd, 'src/app'));
  const { envLine, componentPath, component } = cloudInit({ key, origin: flagValue(o.args, '--origin'), srcDir });
  const layout = `${srcDir ? 'src/' : ''}app/layout.tsx`;
  const steps = `Then:
  1. npm i shipcue   (until it's on npm: the release tarball, see https://github.com/cyu60/shipcue#install)
  2. In ${layout}: import { ShipcueButton } from '@/components/shipcue-button'; and render <ShipcueButton reporter={user?.email} />
  3. List your sites in the Cloud project's Setup, and set ${ENV_NAME} on your host too.
`;
  if (!o.args.includes('--write')) {
    return { output: `.env.local\n  ${envLine}\n\n${componentPath}\n${component.replace(/^/gm, '  ')}\n${steps}`, code: 0 };
  }
  let out = '';
  const envPath = join(o.cwd, '.env.local');
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (new RegExp(`^\\s*${ENV_NAME}=`, 'm').test(envText)) out += `.env.local already has ${ENV_NAME}; left as it is\n`;
  else {
    appendFileSync(envPath, `${envText && !envText.endsWith('\n') ? '\n' : ''}${envLine}\n`);
    out += `added ${ENV_NAME} to .env.local\n`;
  }
  const file = join(o.cwd, componentPath);
  if (existsSync(file)) out += `${componentPath} already exists; left as it is\n`;
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, component);
    out += `wrote ${componentPath}\n`;
  }
  return { output: `${out}\n${steps}`, code: 0 };
}
