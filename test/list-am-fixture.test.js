import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseRegularApartments } from "../src/list-am.js";
import { sanitizeListAmFixture } from "../scripts/sanitize-list-am-fixture.js";

const fixtureDirectory = path.join(
  import.meta.dirname,
  "fixtures",
  "list-am-real-shape",
);

const forbiddenFixtureContent =
  /(?:https?:\/\/|@(?:gmail|yahoo|mail|outlook)\.|\b(?:TELEGRAM_BOT_TOKEN|GHCR_READ_TOKEN|Authorization|cookie|phone|email|account)\b|\+?\d[\d ()-]{7,}\d)/iu;
const forbiddenElements =
  /<(?:script|style|form|input|textarea|button|svg|img|video|audio|iframe|object|embed)\b/iu;

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

test("manifested real-shape List.am fixtures remain sanitized and parseable", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(fixtureDirectory, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(
    manifest.sanitizationPolicy,
    "allowlisted-dom-shape-and-synthetic-content",
  );

  const files = (await readdir(fixtureDirectory))
    .filter((filename) => filename.endsWith(".html"))
    .sort();
  assert.deepEqual(files, manifest.fixtures.map(({ file }) => file).sort());

  for (const fixture of manifest.fixtures) {
    const source = await readFile(
      path.join(fixtureDirectory, fixture.file),
      "utf8",
    );
    assert.equal(hash(source), fixture.sha256, `${fixture.file} checksum`);
    assert.doesNotMatch(
      source.replaceAll(/999999990\d{6}/gu, "SYNTHETIC_ITEM_ID"),
      forbiddenFixtureContent,
    );
    assert.doesNotMatch(source, forbiddenElements);
    assert.match(source, /<div id="contentr">/u);
    assert.match(source, /<div id="tp"/u);
    assert.match(
      source,
      /class="(?:category-data-list-card__destination|fav-item-info-container)"/u,
    );
    assert.match(source, /href="\/ru\/item\/999999990\d{6}"/u);

    const { apartments, ...diagnostics } = parseRegularApartments(source);
    assert.ok(apartments.every(({ itemId }) => itemId.startsWith("999999990")));
    assert.deepEqual(diagnostics, fixture.expectedDiagnostics);
  }
});

test("fixture sanitizer removes sensitive content while retaining parser shape", () => {
  const sanitized = sanitizeListAmFixture(`
    <div id="contentr" data-account="99887766">
      <div id="tp"><a class="fav-item-info-container" href="https://list.am/item/55?phone=123">
        <div class="dltitle"><div class="pt">Real address</div></div>
      </a></div>
      <div class="dl account_99887766"><a class="fav-item-info-container tracking-account_99887766" href="/item/12345678">
        <div class="dltitle"><div class="pt">Call +374 99 123456</div></div>
        <div class="p">$secret</div><div class="at">private@example.com</div>
        <div class="d">cookie=session</div><img src="https://private.invalid/a.jpg">
      </a></div><script>TELEGRAM_BOT_TOKEN=secret</script>
    </div>`);

  assert.doesNotMatch(
    sanitized.replaceAll(/999999990\d{6}/gu, "SYNTHETIC_ITEM_ID"),
    forbiddenFixtureContent,
  );
  assert.doesNotMatch(sanitized, forbiddenElements);
  assert.doesNotMatch(sanitized, /account_99887766/u);
  const diagnostics = parseRegularApartments(sanitized);
  assert.equal(diagnostics.candidateCount, 1);
  assert.equal(diagnostics.parsedCount, 1);
  assert.equal(diagnostics.completeness.title, 1);
  assert.equal(diagnostics.completeness.date, 1);
});
