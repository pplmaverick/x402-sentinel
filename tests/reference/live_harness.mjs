// Extracts recordResult() and currentScore() verbatim from oracle/reporter.js
// (never imports the file — importing would run main() and send txs) and runs
// them against an in-memory fake redis. Reads JSON on stdin, writes JSON on stdout.
//   {"mode":"extract"}                         -> {recordResult:{src,sha256}, currentScore:{...}, file_sha256}
//   {"mode":"run","cases":[{"fn":"currentScore"|"recordResult","history":[...],"passed":bool,"strings":bool}]}
//   history is newest-first, matching Redis LRANGE order.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORTER = path.resolve(here, '../../oracle/reporter.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function extractFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name} end not found`);
  return src.slice(start, end + 3);
}

const file = fs.readFileSync(REPORTER, 'utf8');
const extracted = {
  recordResult: extractFn(file, 'recordResult'),
  currentScore: extractFn(file, 'currentScore'),
};

const input = JSON.parse(fs.readFileSync(0, 'utf8'));

if (input.mode === 'extract') {
  const out = { file_sha256: sha(file) };
  for (const [k, v] of Object.entries(extracted)) out[k] = { src: v, sha256: sha(v) };
  console.log(JSON.stringify(out));
} else {
  const WINDOW_SIZE = Number(file.match(/const WINDOW_SIZE = (\d+);/)[1]);
  const RELIABILITY_HISTORY_PREFIX = file.match(/const RELIABILITY_HISTORY_PREFIX = '([^']+)'/)[1];
  const results = [];
  for (const c of input.cases) {
    // fake redis: list stored newest-first, like LPUSH. `strings` returns "1"/"0"
    // instead of numbers to confirm both deserialisation shapes score the same.
    let list = [...c.history];
    const conv = (v) => (c.strings ? String(v) : Number(v));
    const redis = {
      async lpush(_k, v) { list.unshift(v); return list.length; },
      async ltrim(_k, a, b) { list = list.slice(a, b + 1); return 'OK'; },
      async lrange(_k, a, b) { return (b === -1 ? list.slice(a) : list.slice(a, b + 1)).map(conv); },
    };
    const factory = new Function(
      'redis', 'WINDOW_SIZE', 'RELIABILITY_HISTORY_PREFIX',
      `${extracted.recordResult}\n${extracted.currentScore}\nreturn { recordResult, currentScore };`
    );
    const fns = factory(redis, WINDOW_SIZE, RELIABILITY_HISTORY_PREFIX);
    const score = c.fn === 'recordResult'
      ? await fns.recordResult('0xsubject', c.passed)
      : await fns.currentScore('0xsubject');
    results.push({ score, list: list.map(Number) });
  }
  console.log(JSON.stringify({ window_size: WINDOW_SIZE, results }));
}
