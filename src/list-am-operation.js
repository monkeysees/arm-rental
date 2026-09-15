import { validateStartupConfig } from "./config.js";
import { ListAmHttpFetcher } from "./list-am-http.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import {
  parseAndEvaluateRegularApartments,
  sourceIntegrityPageSummary,
} from "./source-integrity.js";
import { LIST_AM_SOURCES, pageUrl } from "./target.js";

export async function runSourceSmoke(
  config,
  {
    signal,
    validateConfig = validateStartupConfig,
    acquireLock = acquireSingletonLock,
    sourceFetcherFactory = (settings, options) =>
      new ListAmHttpFetcher(settings, options),
  } = {},
) {
  await validateConfig(config);
  const lock = await acquireLock(config.dataDirectory);
  let fetcher;
  try {
    fetcher = sourceFetcherFactory(config, { signal });
    await fetcher.start();
    const pages = [];
    for (const source of config.listSources || LIST_AM_SOURCES) {
      const response = await fetcher.fetch(pageUrl(1, source.urlTemplate));
      if (!response.ok) {
        const error = new Error(`List.am returned HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }
      const parsed = parseAndEvaluateRegularApartments(await response.text(), {
        page: 1,
        kind: source.kind,
      });
      pages.push(sourceIntegrityPageSummary(parsed, 1, source.kind));
    }
    return { pages };
  } finally {
    try {
      await fetcher?.close();
    } finally {
      await lock.release();
    }
  }
}
