import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();

async function filesUnder(directory) {
  const result = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result.push(file);
    }
  }
  await visit(directory);
  return result;
}

function findMatches(file, source, patterns) {
  return patterns.flatMap(({ id, expression }) => {
    const match = expression.exec(source);
    return match ? [{ file, rule: id, match: match[0] }] : [];
  });
}

export async function runCompliance(base = root) {
  const skills = await filesUnder(path.join(base, 'skills'));
  const controls = (await filesUnder(path.join(base, 'scripts'))).filter(file => file.endsWith('.mjs') && !file.endsWith('.test.mjs') && path.basename(file) !== 'compliance.mjs');
  const docs = (await filesUnder(path.join(base, 'docs'))).filter(file => file.endsWith('.md'));
  const publicFiles = ['README.md', 'LICENSE', 'package.json', 'hooks/hooks.json'].map(file => path.join(base, file));
  const sources = await Promise.all([...skills, ...controls, ...docs, ...publicFiles].map(async file => [path.relative(base, file), await readFile(file, 'utf8')]));
  const findings = [];

  for (const [file, source] of sources) {
    if (file.startsWith('skills/')) {
      findings.push(...findMatches(file, source, [
        { id: 'skill-state-write', expression: /\b(?:writeFile|appendFile|createWriteStream|writeTextFile)\s*\(/g },
      ]));
    }
    if (file.startsWith('scripts/')) {
      findings.push(...findMatches(file, source, [
        { id: 'control-llm-import', expression: /(?:from\s*|import\s*\()\s*['"](?:openai|@anthropic-ai\/sdk|@google\/generative-ai)(?:\/[^'"]*)?['"]/g },
        { id: 'control-llm-call', expression: /\b(?:chat\.completions\.create|responses\.create|messages\.create)\s*\(/g },
        { id: 'forbidden-command', expression: /(?:\bgit\s+(?:reset|checkout|restore)\b|--no-verify|\b(?:sdi|gate)\s+(?:bypass|disable)\b)/g },
      ]));
    }
    if (file.startsWith('docs/') || file.startsWith('skills/') || file.startsWith('scripts/')) {
      findings.push(...findMatches(file, source, [
        { id: 'private-path', expression: /\/(?:Users|home)\/[^\s/]+/g },
        { id: 'account-email', expression: /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
      ]));
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.match.localeCompare(b.match));
  return { ok: findings.length === 0, findings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runCompliance();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
