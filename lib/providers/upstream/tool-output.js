// Adapted from devswha/herdr-web-ui at 685293e0a7b912f28b3e19af7e07ae335cfb45e0.
// Copyright (c) 2026 devswha. MIT; see public/vendor/herdr-web-ui/LICENSE.
const TOOL_OUTPUT_CHARS = 4000;
const WHOLE_OUTPUT_TOOLS = new Set(['create_goal', 'update_goal', 'get_goal']);
const WHOLE_OUTPUT_CHARS = 16_000;
function trimOutput(tool, output, ref, requestedLimit) {
  const limit =
    requestedLimit ?? (WHOLE_OUTPUT_TOOLS.has(tool.name) ? WHOLE_OUTPUT_CHARS : TOOL_OUTPUT_CHARS);
  if (output.length <= limit) {
    tool.output = output;
    return;
  }
  tool.output = `${output.slice(0, limit)}\n… trimmed`;
  tool.output_ref = ref;
  tool.output_size = output.length;
}

module.exports = { TOOL_OUTPUT_CHARS, trimOutput };
