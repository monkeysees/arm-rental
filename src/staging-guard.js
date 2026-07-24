import { lstat } from "node:fs/promises";
import path from "node:path";

import { readState } from "./state.js";

export const STAGING_MARKER_FILENAME = ".staging-test-environment.json";
export const STAGING_MARKER_TYPE = "rental-apartments-staging-environment";

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function privateChannelId(value) {
  const normalized = String(value || "").trim();
  if (!/^-100\d{6,}$/u.test(normalized)) {
    throw new Error(
      "STAGING_TELEGRAM_CHANNEL_ID must be a numeric private-channel ID beginning with -100",
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("STAGING_TELEGRAM_CHANNEL_ID is outside the safe range");
  }
  return parsed;
}

/**
 * Fails closed unless the command is pointed at a deliberately provisioned
 * staging volume and dedicated private Telegram resources.
 */
export async function validateStagingGuard(
  env,
  { loadState = readState, inspectPath = lstat } = {},
) {
  if (env.DEPLOYMENT_ENVIRONMENT !== "staging") {
    throw new Error("DEPLOYMENT_ENVIRONMENT must be exactly staging");
  }
  if (env.ALLOW_STAGING_TESTS !== "true") {
    throw new Error("ALLOW_STAGING_TESTS=true is required");
  }
  if (env.NODE_ENV !== "production") {
    throw new Error(
      "NODE_ENV=production is required so staging tests use production behavior",
    );
  }
  if (env.TELEGRAM_CHANNEL_ID?.trim()) {
    throw new Error(
      "TELEGRAM_CHANNEL_ID must be unset; staging tests use only STAGING_TELEGRAM_CHANNEL_ID",
    );
  }
  if (!env.DATA_DIRECTORY?.trim() || !path.isAbsolute(env.DATA_DIRECTORY)) {
    throw new Error("DATA_DIRECTORY must be an explicit absolute staging path");
  }

  const botId = positiveInteger(
    env.STAGING_TELEGRAM_BOT_ID,
    "STAGING_TELEGRAM_BOT_ID",
  );
  const channelId = privateChannelId(env.STAGING_TELEGRAM_CHANNEL_ID);
  const markerFilename = path.join(
    path.resolve(env.DATA_DIRECTORY),
    STAGING_MARKER_FILENAME,
  );
  const details = await inspectPath(markerFilename).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(
        `Dedicated staging marker is missing: ${markerFilename}`,
        { cause: error },
      );
    }
    throw error;
  });
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("The dedicated staging marker must be a regular file");
  }
  if ((details.mode & 0o077) !== 0) {
    throw new Error("The dedicated staging marker must have mode 0600");
  }

  const marker = await loadState(markerFilename);
  if (
    marker?.type !== STAGING_MARKER_TYPE ||
    marker.version !== 1 ||
    marker.environment !== "staging" ||
    marker.botId !== botId ||
    marker.channelId !== channelId
  ) {
    throw new Error(
      "The dedicated staging marker does not match the requested Telegram bot and private channel",
    );
  }

  return {
    botId,
    channelId,
    dataDirectory: path.resolve(env.DATA_DIRECTORY),
    markerFilename,
  };
}
