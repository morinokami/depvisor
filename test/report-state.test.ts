import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_MARKER,
  generatorName,
  parseReportState,
  renderReportState,
} from "../src/core/report-state.ts";

const SHA = "b8c11270589ebbf12b49aed9a49d8ed587e9db24";

test("renders and parses the reviewed-head state line", () => {
  const line = renderReportState({
    headSha: SHA,
    conclusion: "success",
    generator: "depvisor@v2.2.0",
  });
  assert.ok(line);
  const body = `${REPORT_MARKER}\n${line}\n## Depvisor reviewed this update\n\nProse.`;
  assert.deepEqual(parseReportState(body), {
    headSha: SHA,
    conclusion: "success",
    generator: "depvisor@v2.2.0",
  });
});

test("refuses to render malformed state components", () => {
  assert.equal(
    renderReportState({ headSha: "HEAD", conclusion: "success", generator: "depvisor" }),
    null,
  );
  assert.equal(
    renderReportState({ headSha: SHA, conclusion: "Success -->", generator: "depvisor" }),
    null,
  );
  assert.equal(
    renderReportState({ headSha: SHA, conclusion: "success", generator: "depvisor@vNaN" }),
    null,
  );
});

test("treats absent, malformed, or embedded state lines as no state", () => {
  assert.equal(parseReportState(""), null);
  assert.equal(parseReportState(`${REPORT_MARKER}\n## Depvisor reviewed this update`), null);
  assert.equal(
    parseReportState("<!-- depvisor-v2-state sha:zz ci:success generator:depvisor -->"),
    null,
  );
  // Agent prose passes through cleanReportText, which escapes comment markers.
  assert.equal(
    parseReportState(`&lt;!-- depvisor-v2-state sha:${SHA} ci:success generator:depvisor --&gt;`),
    null,
  );
  // The line must stand alone; a forgery embedded mid-line does not parse.
  assert.equal(
    parseReportState(`text <!-- depvisor-v2-state sha:${SHA} ci:success generator:depvisor -->`),
    null,
  );
});

test("names the generator from the released package version", () => {
  assert.match(generatorName(), /^depvisor(@v\d+\.\d+\.\d+)?$/);
});
