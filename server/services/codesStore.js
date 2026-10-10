import fs from 'fs';
import path from 'path';
import { ensureDataDir, serverConfig, dataPath } from '../config.js';
import { atomicWriteJson, atomicWriteFile } from '../../src/shared/atomicStore.js';

const CODES_LUA_FILE = () => dataPath('codes.lua');
const CODES_JSON_FILE = () => dataPath('codes.json');
const DEFAULT_CODES_FILE = path.join(process.cwd(), 'assets', 'codes.default.lua');

const LEGACY_TAIL_MARKERS = [
  '\nlocal lastFetchTime',
  '\nlocal LEGACY_CODES_KEY',
  '\nfunction refreshCodes',
  '\ntask.spawn(function()',
];

export function stripLegacyLuaTail(source) {
  let cut = source.length;
  for (const marker of LEGACY_TAIL_MARKERS) {
    const idx = source.indexOf(marker);
    if (idx !== -1) {
      cut = Math.min(cut, idx);
    }
  }
  return source.slice(0, cut).trimEnd();
}

function luaString(value) {
  return JSON.stringify(String(value ?? ''));
}

const EDITOR_INDENT = '    ';
const FUNCTION_CLOSE_END = /\n(\t+)end\b/g;

function expandTabs(text) {
  return String(text || '').replace(/\t/g, EDITOR_INDENT);
}

function countLeadingWhitespace(line) {
  let count = 0;
  for (const ch of line) {
    if (ch === '\t' || ch === ' ') {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function stripLeadingWhitespace(line, amount) {
  if (amount <= 0) {
    return line;
  }

  let removed = 0;
  let index = 0;
  while (index < line.length && removed < amount) {
    const ch = line[index];
    if (ch === '\t' || ch === ' ') {
      removed += 1;
      index += 1;
    } else {
      break;
    }
  }

  return line.slice(index);
}

function normalizeFunctionBody(body) {
  const expanded = expandTabs(body);
  const lines = expanded.split('\n');
  const contentLines = lines.filter((line) => line.trim().length > 0);
  if (!contentLines.length) {
    return '';
  }

  const minIndent = Math.min(...contentLines.map((line) => countLeadingWhitespace(line)));

  return lines
    .map((line) => (line.trim().length ? stripLeadingWhitespace(line, minIndent) : ''))
    .join('\n')
    .trim();
}

function functionBodyNeedsAutoIndent(body) {
  const lines = String(body || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return false;
  }

  const hasBlockKeywords = lines.some((line) =>
    /^(if\b|else\b|elseif\b|for\b|while\b|repeat\b|function\b)/.test(line)
  );
  if (!hasBlockKeywords) {
    return false;
  }

  return lines.every((line) => !/^\s/.test(line));
}

function splitLuaTableFields(inner) {
  const fields = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      current += ch;
      if (ch === stringChar && inner[i - 1] !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (ch === '{' || ch === '(') {
      depth += 1;
    } else if (ch === '}' || ch === ')') {
      depth -= 1;
    }

    if (ch === ',' && depth === 0) {
      if (current.trim()) {
        fields.push(current.trim());
      }
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    fields.push(current.trim());
  }

  return fields;
}

function expandTablesInLine(line) {
  const trimmedEnd = line.trimEnd();
  if (!trimmedEnd.trim()) {
    return [''];
  }

  const lineIndent = trimmedEnd.match(/^(\s*)/)?.[1] || '';
  const content = trimmedEnd.slice(lineIndent.length);
  const tableMatch = content.match(/^(.+?)\{([^{}]+)\}(.*)$/);
  if (!tableMatch) {
    return [line];
  }

  const [, prefix, inner, suffix] = tableMatch;
  if (!inner.includes(',') || !inner.includes('=')) {
    return [line];
  }

  const fields = splitLuaTableFields(inner);
  if (fields.length < 2) {
    return [line];
  }

  const innerIndent = `${lineIndent}${EDITOR_INDENT}`;
  const expanded = [`${lineIndent}${prefix}{`];
  for (let i = 0; i < fields.length; i += 1) {
    expanded.push(`${innerIndent}${fields[i]}${i < fields.length - 1 ? ',' : ''}`);
  }
  expanded.push(`${lineIndent}}${suffix}`);
  return expanded;
}

function expandInlineTableLiterals(body) {
  const lines = expandTabs(body).split('\n');
  const out = [];
  for (const line of lines) {
    out.push(...expandTablesInLine(line));
  }
  return out.join('\n');
}

function countOpenBraces(line) {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  for (const ch of line) {
    if (inString) {
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
  }
  return depth;
}

function autoIndentLuaFunction(body) {
  const lines = expandTabs(body).split('\n');
  let depth = 0;
  let tableDepth = 0;
  const out = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }

    const closingBraceOnly = trimmed === '}' || trimmed.startsWith('},') || trimmed.startsWith('})');
    if (closingBraceOnly) {
      tableDepth = Math.max(0, tableDepth - 1);
    }

    if (/^(end|else\b|elseif\b|until\b)/.test(trimmed)) {
      depth = Math.max(0, depth - 1);
    }

    const indentLevel = depth + tableDepth;
    out.push(`${EDITOR_INDENT.repeat(indentLevel)}${trimmed}`);

    if (/\bthen\b/.test(trimmed)) {
      depth += 1;
    } else if (/\bdo\b/.test(trimmed)) {
      depth += 1;
    } else if (/\brepeat\b/.test(trimmed)) {
      depth += 1;
    } else if (/\bfunction\b/.test(trimmed)) {
      depth += 1;
    } else if (/^else\b/.test(trimmed) || /^elseif\b/.test(trimmed)) {
      depth += 1;
    }

    if (trimmed.endsWith('{') || (trimmed.includes('{') && countOpenBraces(trimmed) > 0 && !closingBraceOnly)) {
      tableDepth += countOpenBraces(trimmed);
    }
  }

  return out.join('\n').trim();
}

function functionBodyLooksUnindented(body) {
  const lines = String(body || '').split('\n').filter((line) => line.trim());
  if (lines.length < 2) {
    return false;
  }
  return lines.every((line) => countLeadingWhitespace(line) === 0);
}

export function formatFunctionBodyForEditor(body) {
  let text = expandInlineTableLiterals(body);
  text = normalizeFunctionBody(text);

  if (!text) {
    return 'return "Code Successfully Redeemed!"';
  }

  const contentLines = text.split('\n').filter((line) => line.trim());
  const maxIndent = Math.max(
    0,
    ...contentLines.map((line) => countLeadingWhitespace(line))
  );

  if (maxIndent === 0 || functionBodyNeedsAutoIndent(text) || functionBodyLooksUnindented(body)) {
    text = autoIndentLuaFunction(expandInlineTableLiterals(text));
  }

  return text.trim();
}

function spacesPrefixToTabs(prefix) {
  const expanded = expandTabs(prefix);
  const tabCount = Math.floor(expanded.length / EDITOR_INDENT.length);
  return '\t'.repeat(Math.max(0, tabCount));
}

function findFunctionBodyEndIndex(afterFunc) {
  let lastFunctionClose = -1;
  let match = FUNCTION_CLOSE_END.exec(afterFunc);
  while (match) {
    if (match[1].length === 2) {
      lastFunctionClose = match.index;
    }
    match = FUNCTION_CLOSE_END.exec(afterFunc);
  }
  FUNCTION_CLOSE_END.lastIndex = 0;
  return lastFunctionClose;
}

function indentFunctionBody(body) {
  const formatted = formatFunctionBodyForEditor(body);
  if (!formatted) {
    return '\t\t\treturn "Code Successfully Redeemed!"';
  }

  const baseIndent = '\t\t\t';
  return formatted
    .split('\n')
    .map((line) => {
      if (!line.trim().length) {
        return '';
      }

      const parts = line.match(/^(\s*)(.*)$/);
      const prefix = parts?.[1] || '';
      const content = parts?.[2] || line.trim();
      return `${baseIndent}${spacesPrefixToTabs(prefix)}${content}`;
    })
    .join('\n');
}

export function parseCodesLua(source) {
  const clean = stripLegacyLuaTail(source);
  const codes = [];
  const nameRegex = /\["Name"\]\s*=\s*"([^"]+)"/g;
  const names = [];
  let match = nameRegex.exec(clean);
  while (match) {
    names.push({ name: match[1], index: match.index });
    match = nameRegex.exec(clean);
  }

  for (let i = 0; i < names.length; i += 1) {
    const start = names[i].index;
    const end = i + 1 < names.length ? names[i + 1].index : clean.length;
    const block = clean.slice(start, end);

    const dateMatch = block.match(/\['Date'\]\s*=\s*(\d+)/);
    const limitMatch = block.match(/\['Limit'\]\s*=\s*(false|\d+)/);
    const rewardsMatch = block.match(/\['Rewards'\]\s*=\s*"((?:[^"\\]|\\.)*)"/);
    const groupLockMatch = block.match(/\['GroupLock'\]\s*=\s*(true|false)/);
    const groupIdMatch = block.match(/\['GroupId'\]\s*=\s*(\d+)/);
    const groupRankMatch = block.match(/\['GroupRank'\]\s*=\s*(\d+)/);

    let functionBody = '';
    const funcStart = block.indexOf('function(self)');
    if (funcStart !== -1) {
      const afterFunc = block.slice(funcStart + 'function(self)'.length);
      const endIdx = findFunctionBodyEndIndex(afterFunc);
      if (endIdx !== -1) {
        functionBody = formatFunctionBodyForEditor(afterFunc.slice(0, endIdx));
      }
    }

    codes.push({
      name: names[i].name,
      date: dateMatch ? Number(dateMatch[1]) : 999999999999,
      limit: limitMatch && limitMatch[1] !== 'false' ? Number(limitMatch[1]) : false,
      rewards: rewardsMatch ? rewardsMatch[1] : '',
      groupLock: groupLockMatch ? groupLockMatch[1] === 'true' : false,
      groupId: groupIdMatch ? Number(groupIdMatch[1]) : null,
      groupRank: groupRankMatch ? Number(groupRankMatch[1]) : null,
      functionBody,
    });
  }

  return codes;
}

export function serializeCodesLua(codes) {
  const entries = (codes || []).map((code) => {
    const lines = [
      '\t{',
      `\t\t["Name"] = ${luaString(code.name)},`,
      `\t\t['Date'] = ${Number(code.date) || 999999999999},`,
      `\t\t['Limit'] = ${code.limit === false || code.limit === '' || code.limit === null ? 'false' : Number(code.limit)},`,
    ];

    if (code.groupLock) {
      lines.push("\t\t['GroupLock'] = true,");
      if (code.groupId) {
        lines.push(`\t\t['GroupId'] = ${Number(code.groupId)},`);
      }
      if (code.groupRank) {
        lines.push(`\t\t['GroupRank'] = ${Number(code.groupRank)},`);
      }
    }

    lines.push(`\t\t['Rewards'] = ${luaString(code.rewards)},`);
    lines.push('\t\t["Function"] = function(self)');
    lines.push(indentFunctionBody(code.functionBody));
    lines.push('\t\tend');
    lines.push('\t},');
    return lines.join('\n');
  });

  return `return {\n${entries.join('\n')}\n}\n`;
}

export function createCodeTemplate() {
  return {
    name: 'NewCode',
    date: 999999999999,
    limit: false,
    rewards: '',
    groupLock: false,
    groupId: null,
    groupRank: null,
    functionBody: 'return "Code Successfully Redeemed!"',
  };
}

function readSourceLua() {
  ensureDataDir();
  const live = CODES_LUA_FILE();
  if (fs.existsSync(live)) {
    return fs.readFileSync(live, 'utf8');
  }
  if (fs.existsSync(DEFAULT_CODES_FILE)) {
    return fs.readFileSync(DEFAULT_CODES_FILE, 'utf8');
  }
  return 'return {}\n';
}

function ensureCodesJson() {
  ensureDataDir();
  const jsonFile = CODES_JSON_FILE();
  if (fs.existsSync(jsonFile)) {
    return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  }

  const parsed = parseCodesLua(readSourceLua());
  const payload = { codes: parsed };
  saveCodesData(payload);
  return payload;
}

export function loadCodesData() {
  return ensureCodesJson();
}

export function saveCodesData(payload) {
  ensureDataDir();
  const codes = Array.isArray(payload?.codes) ? payload.codes : [];
  const normalized = codes.map((code) => ({
    name: String(code.name || '').trim(),
    date: Number(code.date) || 999999999999,
    limit:
      code.limit === false || code.limit === '' || code.limit === null || code.limit === undefined
        ? false
        : Number(code.limit),
    rewards: String(code.rewards || ''),
    groupLock: Boolean(code.groupLock),
    groupId: code.groupId ? Number(code.groupId) : null,
    groupRank: code.groupRank ? Number(code.groupRank) : null,
    functionBody: formatFunctionBodyForEditor(code.functionBody),
  }));

  atomicWriteJson(CODES_JSON_FILE(), { codes: normalized }, { backup: true });
  atomicWriteFile(CODES_LUA_FILE(), serializeCodesLua(normalized), { backup: true });
  return { codes: normalized };
}

export function loadCodesLuaSource() {
  ensureCodesJson();
  return fs.readFileSync(CODES_LUA_FILE(), 'utf8');
}

export function saveCodesLuaSource(source) {
  const parsed = parseCodesLua(source);
  return saveCodesData({ codes: parsed });
}

export function getCodesForDashboard() {
  const data = loadCodesData();
  const luaPath = CODES_LUA_FILE();
  if (fs.existsSync(luaPath)) {
    const fromLua = parseCodesLua(fs.readFileSync(luaPath, 'utf8'));
    const byName = new Map(fromLua.map((code) => [code.name, code]));
    data.codes = (data.codes || []).map((code) => {
      const match = byName.get(code.name);
      return match
        ? { ...code, functionBody: formatFunctionBodyForEditor(match.functionBody) }
        : { ...code, functionBody: formatFunctionBodyForEditor(code.functionBody) };
    });
  } else {
    data.codes = (data.codes || []).map((code) => ({
      ...code,
      functionBody: formatFunctionBodyForEditor(code.functionBody),
    }));
  }

  return {
    meta: getCodesMeta(),
    codes: data.codes,
  };
}

export function updateCodesFromDashboard(codes) {
  const saved = saveCodesData({ codes });
  return {
    meta: getCodesMeta(),
    codes: saved.codes,
  };
}

export function addCodeEntry() {
  const data = loadCodesData();
  data.codes.push(createCodeTemplate());
  return updateCodesFromDashboard(data.codes);
}

export function removeCodeEntry(index) {
  const data = loadCodesData();
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= data.codes.length) {
    throw new Error(`Invalid code index: ${index}`);
  }
  data.codes.splice(idx, 1);
  return updateCodesFromDashboard(data.codes);
}

export function getCodesMeta() {
  ensureDataDir();
  const luaFile = CODES_LUA_FILE();
  const jsonFile = CODES_JSON_FILE();
  return {
    path: luaFile,
    jsonPath: jsonFile,
    exists: fs.existsSync(luaFile),
    updatedAt: fs.existsSync(luaFile) ? fs.statSync(luaFile).mtime.toISOString() : null,
    apiKeyRequired: Boolean(serverConfig.codesApiKey),
  };
}
