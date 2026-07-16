/** Rendering boundaries for agent-authored and otherwise untrusted text. */

// oxlint-disable no-control-regex -- normalize control bytes at a rendering boundary
function inline(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, max)
    .trim();
}
// oxlint-enable no-control-regex

/** Preserve ordinary punctuation while preventing marker injection in the PR report. */
export function cleanReportText(value: string, max = 4_000): string {
  return inline(value, max).replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
}

/** Render a single untrusted value as literal inline text in a step summary. */
export function escapeStepSummaryText(value: string, max = 2_000): string {
  const html = inline(value, max)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  let escaped = html;
  for (const character of [
    "\\",
    "`",
    "*",
    "_",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "#",
    "+",
    "-",
    ".",
    "!",
    "|",
    "~",
  ]) {
    escaped = escaped.replaceAll(character, `\\${character}`);
  }
  return escaped;
}
