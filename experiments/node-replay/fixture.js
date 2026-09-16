import { readFileSync } from "node:fs";

export const contract = JSON.parse(
  readFileSync(new URL("./contract.json", import.meta.url), "utf8"),
);
export const sequence = (base, count) =>
  Array.from({ length: count }, (_, i) => String(base + i));
export const retainedIds = sequence(
  contract.seed.listingIdBase,
  contract.seed.listingCount,
);
export const absentIds = sequence(
  contract.seed.absentIdBase,
  contract.seed.absentCount,
);
export const groupOf = (id) => Number(id) % 4;
export const filtersFor = (group) => ({
  kinds: ["apartment", "house"],
  price: {
    min: contract.profiles[group].price,
    max: contract.profiles[group].price,
  },
  rooms: group === 2 ? { min: 2, max: 2 } : null,
  locations: [],
});
export function page(ids, kind, updated = false) {
  return `<div id="contentr">${[...ids]
    .sort((a, b) => Number(b) - Number(a))
    .filter((id) => (Number(id) % 2 === 1) === (kind === "house"))
    .map(
      (id) =>
        `<a class="category-data-list-card__destination" href="/ru/item/${id}"><div class="dltitle">Replay rental ${id}${updated && Number(id) < 100008 ? " updated" : ""}</div><div class="p">${contract.profiles[groupOf(id)].originalAmount} ${contract.profiles[groupOf(id)].currency}</div><div class="l">Арабкир</div><div class="at">2 ком. · 60 кв.м. · 3/9 этаж</div><div class="d">${Number(id) < 200000 ? "Вторник, Сентябрь 15" : "Среда, Сентябрь 16"}, 2026, 10:00</div></a>`,
    )
    .join("")}</div>`;
}

export const phases = [
  {
    name: "seed",
    ids: retainedIds,
    updated: false,
    action: "store-without-delivery-then-seed-decisions",
  },
  {
    name: "unchanged",
    ids: retainedIds.slice(0, 40),
    updated: false,
    action: "deliver",
    repeats: 4,
  },
  { name: "updated", ids: retainedIds.slice(0, 40), action: "deliver" },
  { name: "fresh", ids: sequence(200000, 8), action: "deliver" },
  {
    name: "catchup-store",
    ids: sequence(300000, 40),
    action: "store-without-delivery",
  },
  {
    name: "catchup",
    ids: sequence(300000, 40),
    action: "request-selection-all-then-deliver",
  },
  {
    name: "interrupted",
    ids: sequence(400000, 32),
    action: "deliver-two-per-recipient-fail-third-exit-without-close",
  },
  {
    name: "resumed",
    ids: sequence(400000, 32),
    action: "new-process-deliver-pending",
  },
  { name: "drained", ids: sequence(400000, 32), action: "deliver" },
  {
    name: "returning",
    ids: sequence(contract.seed.absentIdBase, 4),
    action: "deliver",
  },
];

export function phasePage(phase, kind) {
  const ids = [
    ...new Set([
      ...phase.ids,
      ...retainedIds.slice(0, Math.max(0, 40 - phase.ids.length)),
    ]),
  ];
  return page(ids, kind, phase.updated !== false);
}
