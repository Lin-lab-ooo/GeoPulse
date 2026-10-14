/** Core tests use no browser, AK or external service. Historical archive tests are opt-in. */
import assert from 'node:assert/strict';
import {readdir, readFile, access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
assert.ok(process.argv.slice(2).every(a=>a==='--archive'),'Only --archive is supported');
const archive=process.argv.includes('--archive');
const archiveFile='release-evidence-audit-2.6.test.mjs';
let files=(await readdir(path.join(root,'tests'))).filter(n=>n.endsWith('.test.mjs')).sort();
files=files.filter(n=>archive?n===archiveFile:n!==archiveFile);
if(archive){
  const required=JSON.parse(await readFile(path.join(root,'docs/archive-test-inputs.json'),'utf8'));
  const missing=[];
  for(const {path:relative}of required.files)try{await access(path.join(root,relative));}catch{missing.push(relative);}
  if(missing.length){console.error('Archive inputs are not bundled. See docs/ARCHIVE-TESTS.md. Missing paths:');console.error(missing.join('\n'));process.exit(2);}
}
assert.ok(files.length,'No selected tests');
console.log(JSON.stringify({suite:archive?'archive-evidence':'core',testFiles:files.length,scope:'Node tests; no native browser or SDK validation'}));
const child=spawn(process.execPath,['--test',...files.map(n=>path.join('tests',n))],{cwd:root,stdio:'inherit',windowsHide:true});
child.once('error',e=>{console.error(e.message);process.exitCode=1;});
child.once('close',(code,signal)=>{process.exitCode=signal?1:(code??1);});
