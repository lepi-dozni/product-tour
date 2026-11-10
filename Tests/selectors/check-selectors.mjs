#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDirectory, '../..');

function usageError(message) {
  throw new Error(`${message}\nUsage: node Tests/selectors/check-selectors.mjs --core <label>=<path> [--core <label>=<path>] [--tour <path>] [--allowlist <path>]`);
}

function parseArguments(argumentsList) {
  const options = {
    cores: [],
    tour: resolve(pluginRoot, 'Assets/js/tour.js'),
    allowlist: resolve(scriptDirectory, 'allowlist.json'),
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];

    if (!['--core', '--tour', '--allowlist'].includes(option)) {
      usageError(`Unknown option: ${option}`);
    }
    if (!value || value.startsWith('--')) {
      usageError(`Missing value for ${option}`);
    }
    index += 1;

    if (option === '--core') {
      const separator = value.indexOf('=');
      if (separator < 1 || separator === value.length - 1) {
        usageError(`Invalid --core value: ${value}`);
      }
      options.cores.push({
        label: value.slice(0, separator),
        path: resolve(value.slice(separator + 1)),
      });
    } else {
      const path = isAbsolute(value) ? value : resolve(pluginRoot, value);
      options[option.slice(2)] = path;
    }
  }

  if (options.cores.length === 0) {
    usageError('At least one --core option is required');
  }

  return options;
}

function stripTrailingComments(source) {
  return source.split('\n').map((line) => {
    let quote = null;
    let escaped = false;

    for (let index = 0; index < line.length - 1; index += 1) {
      const character = line[index];
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
      } else if (character === '\'' || character === '"' || character === '`') {
        quote = character;
      } else if (character === '/' && line[index + 1] === '/') {
        return line.slice(0, index);
      }
    }

    return line;
  }).join('\n');
}

function findMatching(source, start, opening, closing) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function readStringAt(source, start) {
  const quote = source[start];
  if (quote !== '\'' && quote !== '"') {
    return null;
  }

  let value = '';
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
      value += escapes[character] ?? character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      return { value, end: index + 1 };
    } else {
      value += character;
    }
  }

  return null;
}

function extractSteps(source) {
  const strippedSource = stripTrailingComments(source);
  const steps = [];
  const arrayPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;
  let arrayMatch;

  while ((arrayMatch = arrayPattern.exec(strippedSource)) !== null) {
    const tour = arrayMatch[1];
    const arrayStart = strippedSource.indexOf('[', arrayMatch.index);
    const arrayEnd = findMatching(strippedSource, arrayStart, '[', ']');
    if (arrayEnd === -1) {
      usageError(`Could not parse array ${tour}`);
    }

    let index = arrayStart + 1;
    while (index < arrayEnd) {
      if (strippedSource[index] !== '{') {
        index += 1;
        continue;
      }

      const objectEnd = findMatching(strippedSource, index, '{', '}');
      if (objectEnd === -1 || objectEnd > arrayEnd) {
        usageError(`Could not parse a step in ${tour}`);
      }

      const object = strippedSource.slice(index, objectEnd + 1);
      const idMatch = /\bid\s*:\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1/.exec(object);
      if (idMatch !== null) {
        const selectors = [];
        const skippedReasons = [];
        const attachMatch = /\battachTo\s*:\s*\{/.exec(object);

        if (attachMatch !== null) {
          const attachStart = object.indexOf('{', attachMatch.index);
          const attachEnd = findMatching(object, attachStart, '{', '}');
          const attachBlock = object.slice(attachStart + 1, attachEnd);
          const elementMatch = /\belement\s*:\s*/.exec(attachBlock);
          if (elementMatch !== null) {
            const valueStart = elementMatch.index + elementMatch[0].length;
            const string = readStringAt(attachBlock, valueStart);
            if (string === null) {
              skippedReasons.push('attachTo.element is not a string literal');
            } else {
              selectors.push(string.value);
            }
          }
        }

        const lazyPattern = /\blazyElement\s*\(/g;
        let lazyMatch;
        while ((lazyMatch = lazyPattern.exec(object)) !== null) {
          let valueStart = lazyMatch.index + lazyMatch[0].length;
          while (/\s/.test(object[valueStart] ?? '')) {
            valueStart += 1;
          }
          const string = readStringAt(object, valueStart);
          if (string === null) {
            skippedReasons.push('lazyElement selector is not a string literal');
          } else {
            selectors.push(string.value);
            lazyPattern.lastIndex = string.end;
          }
        }

        steps.push({
          tour,
          id: readStringAt(idMatch[0], idMatch[0].indexOf(idMatch[1])).value,
          selectors: [...new Set(selectors)],
          skippedReasons: [...new Set(skippedReasons)],
        });
      }

      index = objectEnd + 1;
    }

    arrayPattern.lastIndex = arrayEnd + 1;
  }

  return steps;
}

function splitCompounds(selector) {
  const compounds = [];
  let current = '';
  let bracketDepth = 0;
  let quote = null;

  for (const character of selector.trim()) {
    if (quote !== null) {
      current += character;
      if (character === quote) {
        quote = null;
      }
    } else if (character === '\'' || character === '"') {
      quote = character;
      current += character;
    } else if (character === '[') {
      bracketDepth += 1;
      current += character;
    } else if (character === ']') {
      bracketDepth -= 1;
      current += character;
    } else if (bracketDepth === 0 && (character === '>' || /\s/.test(character))) {
      if (current !== '') {
        compounds.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (current !== '') {
    compounds.push(current);
  }

  return compounds;
}

function parseCompound(source) {
  const tokens = [];
  const pseudos = [];
  let base = '';
  let index = 0;
  const tagMatch = /^[A-Za-z][\w-]*/.exec(source);
  if (tagMatch !== null) {
    tokens.push({ type: 'tag', value: tagMatch[0].toLowerCase(), raw: tagMatch[0].toLowerCase() });
    base += tagMatch[0];
    index = tagMatch[0].length;
  }

  while (index < source.length) {
    const marker = source[index];
    if (marker === '#' || marker === '.') {
      const valueMatch = /^[\w-]+/.exec(source.slice(index + 1));
      if (valueMatch === null) {
        return { error: `unsupported token in ${source}` };
      }
      const raw = marker + valueMatch[0];
      tokens.push({ type: marker === '#' ? 'id' : 'class', value: valueMatch[0], raw });
      base += raw;
      index += raw.length;
    } else if (marker === '[') {
      const end = source.indexOf(']', index + 1);
      if (end === -1) {
        return { error: `unterminated attribute in ${source}` };
      }
      const body = source.slice(index + 1, end);
      const attributeMatch = /^([\w:-]+)\s*(?:(\*=|\^=|\$=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?$/.exec(body);
      if (attributeMatch === null) {
        return { error: `unsupported attribute in ${source}` };
      }
      const value = attributeMatch[3] ?? attributeMatch[4] ?? attributeMatch[5] ?? null;
      const raw = value === null
        ? `[${attributeMatch[1]}]`
        : `[${attributeMatch[1]}${attributeMatch[2]}"${value}"]`;
      tokens.push({
        type: 'attribute',
        name: attributeMatch[1],
        operator: attributeMatch[2] ?? null,
        value,
        raw,
      });
      base += source.slice(index, end + 1);
      index = end + 1;
    } else if (marker === ':') {
      const pseudoMatch = /^:([\w-]+)/.exec(source.slice(index));
      if (pseudoMatch === null) {
        return { error: `unsupported pseudo-class in ${source}` };
      }
      pseudos.push(`:${pseudoMatch[1]}`);
      index += pseudoMatch[0].length;
      if (source[index] === '(') {
        const end = findMatching(source, index, '(', ')');
        if (end === -1) {
          return { error: `unterminated pseudo-class in ${source}` };
        }
        index = end + 1;
      }
    } else {
      return { error: `unsupported token in ${source}` };
    }
  }

  return { source, base, tokens, pseudos };
}

function parseSelector(selector) {
  const compounds = splitCompounds(selector).map(parseCompound);
  const invalid = compounds.find((compound) => compound.error);
  return invalid ? { error: invalid.error } : { compounds };
}

function extractStrings(line) {
  const strings = [];
  for (let index = 0; index < line.length; index += 1) {
    const string = readStringAt(line, index);
    if (string !== null) {
      strings.push(string.value);
      index = string.end - 1;
    }
  }
  return strings;
}

function extractOpeningTags(line) {
  return [...line.matchAll(/<[A-Za-z][^>]*>/g)].map((match) => match[0]);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attributeValues(fragment, name) {
  const pattern = new RegExp(`\\b${escapeRegularExpression(name)}\\s*=\\s*(["'])((?:(?!\\1).)*)\\1`, 'g');
  return [...fragment.matchAll(pattern)].map((match) => match[2]);
}

function valueMatches(actual, operator, expected) {
  if (operator === null) {
    return true;
  }
  if (operator === '=') {
    return actual === expected;
  }
  if (operator === '*=') {
    return actual.includes(expected);
  }
  if (operator === '^=') {
    return actual.startsWith(expected);
  }
  return actual.endsWith(expected);
}

function tokenMatchesFragment(token, fragment, type) {
  if (type === 'js') {
    if (token.type === 'id') {
      return fragment.includes(`#${token.value}`) || fragment === token.value;
    }
    if (token.type === 'class') {
      return new RegExp(`(^|[^\\w-])\\.?${escapeRegularExpression(token.value)}([^\\w-]|$)`).test(fragment);
    }
    if (token.type === 'tag') {
      return new RegExp(`<${escapeRegularExpression(token.value)}\\b`, 'i').test(fragment);
    }
    return fragment.includes(token.raw);
  }

  if (token.type === 'id') {
    return attributeValues(fragment, 'id').some((value) => value === token.value)
      || fragment.includes(`#${token.value}`)
      || fragment.includes(`'${token.value}'`)
      || fragment.includes(`"${token.value}"`);
  }
  if (token.type === 'class') {
    return attributeValues(fragment, 'class').some((value) => value.split(/\s+/).includes(token.value));
  }
  if (token.type === 'tag') {
    return new RegExp(`^<${escapeRegularExpression(token.value)}\\b`, 'i').test(fragment);
  }
  const values = attributeValues(fragment, token.name);
  if (token.operator === null) {
    return values.length > 0 || new RegExp(`\\s${escapeRegularExpression(token.name)}(?:\\s|>|$)`).test(fragment);
  }
  return values.some((value) => valueMatches(value, token.operator, token.value));
}

function lineMatchesToken(file, line, token) {
  const tags = extractOpeningTags(line);
  if (tags.some((tag) => tokenMatchesFragment(token, tag, 'tag'))) {
    return true;
  }
  if (file.relativePath.endsWith('.js')) {
    return extractStrings(line).some((string) => tokenMatchesFragment(token, string, 'js'));
  }
  if (token.type === 'id') {
    return line.includes(`#${token.value}`)
      || line.includes(`'${token.value}'`)
      || line.includes(`"${token.value}"`);
  }
  return false;
}

function lineMatchesCompound(file, line, compound, tokens) {
  if (extractOpeningTags(line).some((tag) => tokens.every((token) => tokenMatchesFragment(token, tag, 'tag')))) {
    return true;
  }
  if (file.relativePath.endsWith('.js')) {
    return extractStrings(line).some((string) => string.includes(compound.base));
  }
  return false;
}

function findEvidence(files, predicate) {
  for (const file of files) {
    for (let index = 0; index < file.lines.length; index += 1) {
      if (predicate(file, file.lines[index])) {
        return { file: file.relativePath, line: index + 1 };
      }
    }
  }
  return null;
}

function formatEvidence(evidence) {
  return evidence === null ? 'no source evidence' : `${evidence.file}:${evidence.line}`;
}

async function collectPaths(directory, root, paths = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === 'vendor' || entry.name === 'plugins') {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectPaths(path, root, paths);
      continue;
    }

    const relativePath = relative(root, path).split(sep).join('/');
    if (relativePath.endsWith('.twig') || /\/Assets\/js\/[^/]+\.js$/.test(`/${relativePath}`)) {
      paths.push({ path, relativePath });
    }
  }

  return paths;
}

async function loadCorpus(core) {
  const coreStat = await stat(core.path);
  if (!coreStat.isDirectory()) {
    throw new Error(`Core path is not a directory: ${core.path}`);
  }

  const paths = await collectPaths(core.path, core.path);
  const files = [];
  for (const item of paths) {
    const content = await readFile(item.path, 'utf8');
    files.push({ ...item, lines: content.split('\n') });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return { ...core, files, fileMap: new Map(files.map((file) => [file.relativePath, file])) };
}

function resolveInclude(path) {
  const match = /^@Mautic([^/]+)\/(.+)$/.exec(path);
  return match === null ? null : `${match[1]}Bundle/Resources/views/${match[2]}`;
}

function scopeFiles(core, scope) {
  const paths = new Set(scope);
  for (const path of scope) {
    const file = core.fileMap.get(path);
    if (!file) {
      continue;
    }
    for (const line of file.lines) {
      const patterns = [
        /{%\s*include\s+['"](@Mautic[^'"]+)['"]/g,
        /{{\s*include\(\s*['"](@Mautic[^'"]+)['"]/g,
      ];
      for (const pattern of patterns) {
        for (const match of line.matchAll(pattern)) {
          const included = resolveInclude(match[1]);
          if (included !== null) {
            paths.add(included);
          }
        }
      }
    }
  }

  return [...paths].map((path) => core.fileMap.get(path)).filter(Boolean);
}

function findAllowlistEntry(allowlist, token, version) {
  return allowlist.findIndex((entry) => entry.token === token && entry.versions.includes(version));
}

function evaluateSelector(selector, core, allowlist, usedEntries) {
  const parsed = parseSelector(selector);
  if (parsed.error) {
    return { status: 'SKIPPED', reason: parsed.error, pseudos: [] };
  }

  let allowed = false;
  let activeScope = null;
  let firstEvidence = null;
  const pseudos = [];

  for (const compound of parsed.compounds) {
    pseudos.push(...compound.pseudos);
    const staticTokens = [];

    for (const token of compound.tokens) {
      const allowlistIndex = findAllowlistEntry(allowlist, token.raw, core.label);
      if (allowlistIndex !== -1) {
        usedEntries.add(allowlistIndex);
        allowed = true;
        if (firstEvidence === null) {
          firstEvidence = { allowlist: allowlist[allowlistIndex].evidence };
        }
        if (allowlist[allowlistIndex].scope) {
          activeScope = allowlist[allowlistIndex].scope;
        }
      } else {
        staticTokens.push(token);
      }
    }

    const files = activeScope === null ? core.files : scopeFiles(core, activeScope);
    for (const token of staticTokens) {
      const evidence = findEvidence(files, (file, line) => lineMatchesToken(file, line, token));
      if (evidence === null) {
        const globalEvidence = activeScope === null
          ? null
          : findEvidence(core.files, (file, line) => lineMatchesToken(file, line, token));
        return {
          status: 'MISSING',
          reason: `${token.raw} rule ${activeScope === null ? 1 : 3} (${activeScope === null ? 'token presence' : 'scope'})`,
          evidence: globalEvidence,
          pseudos,
        };
      }
      firstEvidence = evidence;
    }

    if (staticTokens.length > 1) {
      const evidence = findEvidence(files, (file, line) => lineMatchesCompound(file, line, compound, staticTokens));
      if (evidence === null) {
        const tokenEvidence = findEvidence(files, (file, line) => lineMatchesToken(file, line, staticTokens[0]));
        return {
          status: 'MISSING',
          reason: `${staticTokens.map((token) => token.raw).join(' + ')} rule 2 (same element)`,
          evidence: tokenEvidence,
          pseudos,
        };
      }
      if (firstEvidence === null || firstEvidence.allowlist) {
        firstEvidence = evidence;
      }
    }
  }

  return { status: allowed ? 'ALLOWLISTED' : 'OK', evidence: firstEvidence, pseudos };
}

function evaluateStep(step, core, allowlist, usedEntries) {
  if (step.skippedReasons.length > 0) {
    return { status: 'SKIPPED', reason: step.skippedReasons[0], selector: '(non-literal)' };
  }
  if (step.selectors.length === 0) {
    return { status: 'SKIPPED', reason: 'no literal selector found', selector: '(none)' };
  }

  const evaluations = step.selectors.map((selector) => ({
    selector,
    ...evaluateSelector(selector, core, allowlist, usedEntries),
  }));
  const failure = evaluations.find((evaluation) => evaluation.status === 'MISSING' || evaluation.status === 'SKIPPED');
  if (failure) {
    return failure;
  }

  const allowlisted = evaluations.some((evaluation) => evaluation.status === 'ALLOWLISTED');
  return {
    status: allowlisted ? 'ALLOWLISTED' : 'OK',
    selector: step.selectors.join(' || '),
    evidence: evaluations.find((evaluation) => evaluation.evidence && !evaluation.evidence.allowlist)?.evidence
      ?? evaluations[0].evidence,
    pseudos: [...new Set(evaluations.flatMap((evaluation) => evaluation.pseudos))],
  };
}

function printResult(step, core, result) {
  const ignored = result.pseudos?.length > 0 ? `; ignored ${result.pseudos.join(', ')}` : '';
  let detail;
  if (result.status === 'MISSING' || result.status === 'SKIPPED') {
    detail = `${result.reason}; ${formatEvidence(result.evidence ?? null)}`;
  } else if (result.evidence?.allowlist) {
    detail = `allowlist: ${result.evidence.allowlist}`;
  } else {
    detail = formatEvidence(result.evidence ?? null);
  }
  console.log(`${result.status} ${step.tour}/${step.id}@${core.label} ${JSON.stringify(result.selector)} — ${detail}${ignored}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [tourSource, allowlistSource] = await Promise.all([
    readFile(options.tour, 'utf8'),
    readFile(options.allowlist, 'utf8'),
  ]);
  const allowlist = JSON.parse(allowlistSource);
  if (!Array.isArray(allowlist)) {
    usageError('The allowlist must be a JSON array');
  }

  const steps = extractSteps(tourSource);
  const cores = [];
  for (const core of options.cores) {
    cores.push(await loadCorpus(core));
  }

  const usedEntries = new Set();
  const summaries = new Map(cores.map((core) => [core.label, {
    OK: 0,
    ALLOWLISTED: 0,
    MISSING: 0,
    SKIPPED: 0,
  }]));

  for (const step of steps) {
    for (const core of cores) {
      const result = evaluateStep(step, core, allowlist, usedEntries);
      summaries.get(core.label)[result.status] += 1;
      printResult(step, core, result);
    }
  }

  allowlist.forEach((entry, index) => {
    if (!usedEntries.has(index)) {
      console.warn(`WARNING unused allowlist entry ${entry.token} (${entry.versions.join(', ')}) — ${entry.reason}`);
    }
  });

  for (const core of cores) {
    const counts = summaries.get(core.label);
    console.log(`SUMMARY ${core.label}: OK=${counts.OK} ALLOWLISTED=${counts.ALLOWLISTED} MISSING=${counts.MISSING} SKIPPED=${counts.SKIPPED}`);
  }

  const failed = [...summaries.values()].some((counts) => counts.MISSING > 0 || counts.SKIPPED > 0);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 2;
});
