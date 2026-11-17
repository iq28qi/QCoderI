// Resume only the existing disposable installed preview profile for final visuals.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
const child=spawn(process.execPath,[resolve('harness-base/scripts/launch-installed-fixture.mjs'),resolve('harness-base/tests/.runtime/platform-installed-20261115-v134'),resolve('harness-base/tests/platform-final-preview.json')],{cwd:process.cwd(),stdio:'inherit',env:{...process.env,QCODERI_INSTALLED_FIXTURE_HOME:resolve('harness-base/tests/installed-native-iYgj42')}});
await once(child,'exit');
