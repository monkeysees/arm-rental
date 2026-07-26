import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { CONFIGURATION_CATALOG } from "../src/config-catalog.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const accessSettings = [
  "TELEGRAM_ACCESS_MODE",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_USER_UPDATES_PER_MINUTE",
  "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE",
];

const readProjectFile = (filename) =>
  readFile(path.join(projectRoot, filename), "utf8");

function fail(filename, field, requirement) {
  throw new Error(`${filename}: ${field} ${requirement}`);
}

function requireDocumentation(condition, filename, field, requirement) {
  if (!condition) fail(filename, field, requirement);
}

function parseAssignments(contents) {
  const assignments = new Map();
  for (const match of contents.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gmu)) {
    const values = assignments.get(match[1]) || [];
    values.push(match[2]);
    assignments.set(match[1], values);
  }
  return assignments;
}

function expectedExampleValue(configuration) {
  return configuration.required || configuration.defaultValue === undefined
    ? ""
    : String(configuration.defaultValue);
}

function expectedReadmeDefault(configuration) {
  if (configuration.required) return "required";
  if (configuration.defaultDescription) return configuration.defaultDescription;
  if (configuration.defaultValue === "") return "blank";
  return String(configuration.defaultValue);
}

async function trackedRepositoryFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "-z", "--"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return new Set(stdout.split("\0").filter(Boolean));
}

function maintainedMarkdownFiles(trackedFiles) {
  return [...trackedFiles]
    .filter(
      (filename) =>
        filename === "README.md" ||
        (filename.startsWith("docs/") && filename.endsWith(".md")),
    )
    .sort();
}

function trackedPathIndex(trackedFiles) {
  const paths = new Set();
  for (const filename of trackedFiles) {
    // Git has no directory entries, so index parents to allow links to
    // directories that are materially present through tracked descendants.
    let candidate = filename;
    while (candidate !== ".") {
      paths.add(candidate);
      candidate = path.posix.dirname(candidate);
    }
  }
  return paths;
}

function repositoryPath(filename) {
  return path
    .relative(projectRoot, filename)
    .split(path.sep)
    .join(path.posix.sep);
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function isCheckedInPath(filename, trackedPaths, pathExists = exists) {
  return (
    trackedPaths.has(repositoryPath(filename)) && (await pathExists(filename))
  );
}

function inlineRepositoryPath(value) {
  if (
    /^(?:src|test|scripts|ops|infra|docs)\/[A-Za-z0-9._/-]+\/?$/u.test(value)
  ) {
    return value;
  }
  if (
    /^(?:\.env\.example|\.nvmrc|AGENTS\.MD|Dockerfile|README\.md|compose\.production\.yaml|eslint\.config\.js|package(?:-lock)?\.json)$/u.test(
      value,
    )
  ) {
    return value;
  }
  return null;
}

test("configuration example and README match the code-owned catalog", async () => {
  const [example, readme] = await Promise.all([
    readProjectFile(".env.example"),
    readProjectFile("README.md"),
  ]);
  const exampleAssignments = parseAssignments(example);
  const table = readme.split("## Configuration\n")[1]?.split(/\n## /u)[0];
  requireDocumentation(
    Boolean(table),
    "README.md",
    "Configuration",
    "table is missing",
  );

  const readmeRows = new Map();
  for (const match of table.matchAll(
    /^\| `([A-Z][A-Z0-9_]*)`\s+\|\s+(`?)([^|`]+)\2\s+\|/gmu,
  )) {
    const rows = readmeRows.get(match[1]) || [];
    rows.push(match[3].trim());
    readmeRows.set(match[1], rows);
  }

  const catalogNames = new Set(CONFIGURATION_CATALOG.map(({ name }) => name));
  for (const name of new Set([
    ...exampleAssignments.keys(),
    ...readmeRows.keys(),
  ])) {
    requireDocumentation(
      catalogNames.has(name),
      exampleAssignments.has(name) ? ".env.example" : "README.md",
      name,
      "is not a supported configuration field",
    );
  }

  for (const configuration of CONFIGURATION_CATALOG) {
    const exampleValues = exampleAssignments.get(configuration.name);
    requireDocumentation(
      exampleValues?.length === 1,
      ".env.example",
      configuration.name,
      "must appear exactly once",
    );
    requireDocumentation(
      exampleValues[0] === expectedExampleValue(configuration),
      ".env.example",
      configuration.name,
      "must preserve its catalog default",
    );

    const rows = readmeRows.get(configuration.name);
    requireDocumentation(
      rows?.length === 1,
      "README.md",
      configuration.name,
      "must appear exactly once in the configuration table",
    );
    requireDocumentation(
      rows[0] === expectedReadmeDefault(configuration),
      "README.md",
      configuration.name,
      "default must match the configuration catalog",
    );
  }
});

test("maintained Markdown links and repository paths resolve locally", async () => {
  const trackedFiles = await trackedRepositoryFiles();
  const trackedPaths = trackedPathIndex(trackedFiles);
  for (const filename of maintainedMarkdownFiles(trackedFiles)) {
    const contents = await readProjectFile(filename);
    for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
      const rawTarget = match[1].trim().replace(/^<|>$/gu, "");
      const target = rawTarget.split(/\s+["']/u)[0].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      const resolved = path.resolve(
        projectRoot,
        path.dirname(filename),
        decodeURIComponent(target),
      );
      const relativeTarget = path.relative(projectRoot, resolved);
      requireDocumentation(
        relativeTarget !== "" && !relativeTarget.startsWith(".."),
        filename,
        rawTarget,
        "must remain inside the repository",
      );
      requireDocumentation(
        await isCheckedInPath(resolved, trackedPaths),
        filename,
        rawTarget,
        "must resolve to a checked-in path",
      );
    }

    for (const match of contents.matchAll(/`([^`\r\n]+)`/gu)) {
      const repositoryPath = inlineRepositoryPath(match[1]);
      if (!repositoryPath) continue;
      requireDocumentation(
        await isCheckedInPath(
          path.join(projectRoot, repositoryPath),
          trackedPaths,
        ),
        filename,
        repositoryPath,
        "must resolve to a checked-in path",
      );
    }
  }
});

test("tracked documentation paths exclude untracked files from validation and references", async () => {
  const trackedFiles = new Set(["README.md", "docs/tracked.md"]);
  const trackedPaths = trackedPathIndex(trackedFiles);
  const presentPaths = new Set([
    path.join(projectRoot, "README.md"),
    path.join(projectRoot, "docs/tracked.md"),
    path.join(projectRoot, "docs/untracked.md"),
  ]);

  requireDocumentation(
    !maintainedMarkdownFiles(trackedFiles).includes("docs/untracked.md"),
    "docs/untracked.md",
    "maintained documentation",
    "must be selected from the Git index",
  );
  requireDocumentation(
    !(await isCheckedInPath(
      path.join(projectRoot, "docs/untracked.md"),
      trackedPaths,
      async (filename) => presentPaths.has(filename),
    )),
    "docs/untracked.md",
    "repository path",
    "must not be accepted only because it exists in the worktree",
  );
});

test("tracked files and directories with tracked descendants qualify as checked-in paths", async () => {
  const trackedPaths = trackedPathIndex(
    new Set(["docs/tracked.md", "docs/guides/introduction.md"]),
  );

  for (const filename of ["docs/tracked.md", "docs/guides"]) {
    requireDocumentation(
      await isCheckedInPath(
        path.join(projectRoot, filename),
        trackedPaths,
        async () => true,
      ),
      filename,
      "repository path",
      "must accept tracked files and directories containing tracked files",
    );
  }
});

test("tracked paths missing from the worktree are rejected", async () => {
  const trackedPaths = trackedPathIndex(
    new Set(["docs/tracked.md", "docs/guides/introduction.md"]),
  );

  for (const filename of ["docs/tracked.md", "docs/guides"]) {
    requireDocumentation(
      !(await isCheckedInPath(
        path.join(projectRoot, filename),
        trackedPaths,
        async () => false,
      )),
      filename,
      "repository path",
      "must exist in the worktree",
    );
  }
});

test("access documentation agrees on modes, defaults, and owner routing", async () => {
  const filenames = [
    ".env.example",
    "README.md",
    "docs/deployment-from-scratch.md",
    "docs/architecture.md",
  ];
  const documents = await Promise.all(filenames.map(readProjectFile));

  for (const [index, contents] of documents.entries()) {
    const filename = filenames[index];
    for (const mode of ["public", "owner", "allowlist"]) {
      requireDocumentation(
        new RegExp(`\\b${mode}\\b`, "u").test(contents),
        filename,
        "TELEGRAM_ACCESS_MODE",
        `must define ${mode} access`,
      );
    }
    requireDocumentation(
      /defaults? to [`]?public[`]?/iu.test(contents),
      filename,
      "TELEGRAM_ACCESS_MODE",
      "must state that private access defaults to public",
    );
    requireDocumentation(
      /server-alert recipient/iu.test(contents),
      filename,
      "TELEGRAM_OWNER_ID",
      "must identify the owner as the server-alert recipient",
    );
    requireDocumentation(
      /no private-user\s+admission\s+(?:cap|limit)/iu.test(contents),
      filename,
      "TELEGRAM_ACCESS_MODE",
      "must state that authorized private users have no admission limit",
    );
    requireDocumentation(
      /at least one/iu.test(contents) && /non-owner/iu.test(contents),
      filename,
      "TELEGRAM_ALLOWED_USER_IDS",
      "must require at least one non-owner ID in allowlist mode",
    );
    requireDocumentation(
      /(?:do\s+not|must\s+not)[^.]{0,80}(?:repeat|repeated)/iu.test(contents),
      filename,
      "TELEGRAM_ALLOWED_USER_IDS",
      "must forbid repeating the owner in the allowlist",
    );
  }

  const deployment = documents[2];
  for (const name of accessSettings) {
    requireDocumentation(
      new RegExp(`^${name}=`, "gmu").test(deployment),
      "docs/deployment-from-scratch.md",
      name,
      "must appear in the production environment example",
    );
  }

  const architecture = documents[3];
  for (const removed of [
    "src/staging-guard.js",
    "src/staging-smoke.js",
    "src/staging-soak.js",
  ]) {
    requireDocumentation(
      !architecture.includes(removed),
      "docs/architecture.md",
      removed,
      "must not be described as an active component",
    );
  }
  requireDocumentation(
    !/Fluentd-compatible|Production Compose requires an external collector/iu.test(
      architecture,
    ),
    "docs/architecture.md",
    "observability",
    "must not describe the removed external collector",
  );
});
