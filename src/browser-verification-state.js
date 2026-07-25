import path from "node:path";

import { readState, writeState } from "./state.js";

const TYPE = "list-am-browser-verification";
const VERSION = 1;

export function browserVerificationStateFile(config) {
  return path.join(
    config.browserProfileDir,
    ".rental-apartments-verification.json",
  );
}

export function compatibleBrowserVerification(state, listUrlTemplate) {
  return Boolean(
    state &&
    state.type === TYPE &&
    state.version === VERSION &&
    state.urlTemplate === listUrlTemplate &&
    !Number.isNaN(Date.parse(state.verifiedAt)) &&
    Number.isSafeInteger(state.regularAdsCount) &&
    state.regularAdsCount >= 0,
  );
}

export async function recordBrowserVerification(
  config,
  regularAdsCount,
  { now = () => new Date(), saveState = writeState } = {},
) {
  const state = {
    type: TYPE,
    version: VERSION,
    urlTemplate: config.listUrlTemplate,
    verifiedAt: now().toISOString(),
    regularAdsCount,
  };
  await saveState(browserVerificationStateFile(config), state, {
    validateSerialized: (serialized) =>
      compatibleBrowserVerification(serialized, config.listUrlTemplate),
  });
  return state;
}

export async function loadBrowserVerification(
  config,
  { loadState = readState } = {},
) {
  const state = await loadState(browserVerificationStateFile(config));
  return compatibleBrowserVerification(state, config.listUrlTemplate)
    ? state
    : undefined;
}
