// Adapted from devswha/herdr-web-ui at 685293e0a7b912f28b3e19af7e07ae335cfb45e0.
// Copyright (c) 2026 devswha. MIT; see public/vendor/herdr-web-ui/LICENSE.
const { basename, dirname } = require('node:path');
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const label = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value)
    ? value
    : null;
function skillDocument(path) {
  if (typeof path !== 'string' || path.length > 4096 || /[\r\n]/.test(path)) return null;
  const normalized = path.replaceAll('\\', '/');
  if (!normalized.endsWith('/SKILL.md')) return null;
  const name = label(basename(dirname(normalized)));
  return name && name !== '.'
    ? {
        name,
        path,
        evidence: 'instructions',
        status: 'loaded',
      }
    : null;
}
function selectedSkill(text) {
  const match =
    /^<skill>\s*<name>([^<>\r\n]+)<\/name>\s*<path>([^<>\r\n]+)<\/path>[\s\S]*<\/skill>$/.exec(
      text.trim(),
    );
  if (!match) return null;
  const name = label(match[1]);
  const document = skillDocument(match[2]);
  return name && document
    ? {
        ...document,
        name,
      }
    : null;
}
const SKILL_INSTRUCTION =
  /^The user explicitly invoked the "([^"]+)" skill\. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions\.\n\n<skill-instruction name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill-instruction>/;
const LEGACY_SKILL =
  /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
function loadedSkill(name, location) {
  const skill = label(name);
  if (
    skill === null ||
    typeof location !== 'string' ||
    location.length === 0 ||
    location.length > 4096 ||
    /[\r\n]/.test(location)
  )
    return null;
  return {
    name: skill,
    path: location,
    evidence: 'instructions',
    status: 'loaded',
  };
}
function skillInvocationPrompt(text) {
  const skills = [];
  let remainder = text;
  let match = SKILL_INSTRUCTION.exec(remainder);
  while (match !== null) {
    const skill = match[1] === match[2] ? loadedSkill(match[1], match[3]) : null;
    if (skill === null) return null;
    skills.push(skill);
    remainder = remainder.slice(match[0].length);
    if (!remainder.startsWith('\n\nThe user explicitly invoked the ')) break;
    remainder = remainder.slice(2);
    match = SKILL_INSTRUCTION.exec(remainder);
    if (match === null) return null;
  }
  if (skills.length > 0) {
    if (remainder.length === 0)
      return {
        skills,
        request: '',
      };
    const request = /^\n\n<user-request>\n([\s\S]*?)\n<\/user-request>$/.exec(remainder);
    return request
      ? {
          skills,
          request: request[1].trim(),
        }
      : null;
  }
  const legacy = LEGACY_SKILL.exec(text);
  const skill = legacy ? loadedSkill(legacy[1], legacy[2]) : null;
  return skill
    ? {
        skills: [skill],
        request: legacy[3]?.trim() ?? '',
      }
    : null;
}
function invokedSkill(name, input) {
  if (name !== 'Skill') return null;
  const skill = label(input.skill);
  return skill
    ? {
        name: skill,
        evidence: 'invocation',
        status: 'requested',
      }
    : null;
}
function codexReadSkills(value) {
  const item = record(value);
  if (item.type !== 'CommandExecution' || !Array.isArray(item.parsed_cmd)) return [];
  if (item.status !== 'completed' && item.status !== 'failed') return [];
  const status =
    item.exit_code === 0 ? 'loaded' : typeof item.exit_code === 'number' ? 'failed' : null;
  if (!status) return [];
  return item.parsed_cmd.flatMap((value) => {
    const command = record(value);
    const skill = command.type === 'read' ? skillDocument(command.path) : null;
    return skill
      ? [
          {
            ...skill,
            status,
          },
        ]
      : [];
  });
}
function codexReadCall(name, args) {
  if (name === 'read_file' || name === 'Read') {
    const skill = skillDocument(args.file_path ?? args.path);
    return skill
      ? {
          ...skill,
          status: 'requested',
        }
      : null;
  }
  if (name !== 'exec_command' && name !== 'shell_command' && name !== 'shell') return null;
  const cmd = args.cmd ?? args.command;
  if (typeof cmd !== 'string' || /[\n;&|<>`$]/.test(cmd)) return null;
  const match =
    /^(?:cat|head(?:\s+-n\s+\d+)?|sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?)\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))\s*$/.exec(
      cmd.trim(),
    );
  const skill = match ? skillDocument(match[1] ?? match[2] ?? match[3]) : null;
  return skill
    ? {
        ...skill,
        status: 'requested',
      }
    : null;
}

module.exports = {
  skillDocument,
  selectedSkill,
  skillInvocationPrompt,
  invokedSkill,
  codexReadSkills,
  codexReadCall,
};
