import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readState(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`State file is not valid JSON: ${filename}`);
    }
    throw error;
  }
}

export async function writeState(filename, state) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporaryFile = `${filename}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(
      temporaryFile,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryFile, filename);
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}
