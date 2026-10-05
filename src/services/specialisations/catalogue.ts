export type SpecialisationKind = "weapon" | "tree";
export type SpecialisationLevel = 100 | 800;

export interface CatalogueEntry {
  key: string;
  name: string;
  kind: SpecialisationKind;
  treeKey?: string;
}

export interface ParsedCatalogueSelection {
  enabledKeys: Set<string>;
  disabledKeys: Set<string>;
  duplicateCount: number;
  invalidNames: string[];
}

/**
 * Snapshot: 23 August 2026.
 *
 * The weapon families and their eight Destiny Board specialisations are taken
 * from Albion Online's current weapon table:
 * https://wiki.albiononline.com/wiki/Weapon
 *
 * Sandbox Interactive's final Crystal Weapon announcement confirms that the
 * lineup was completed by Truebolt Hammer and Stillgaze Staff in June 2025:
 * https://albiononline.com/news/dev-talk-new-player-experience
 *
 * Offhand families (Shields, Torches, and Tomes) are intentionally excluded:
 * they do not form the weapon-specialisation trees represented by this domain.
 */
const WEAPON_FAMILIES = {
  Sword: [
    "Broadsword", "Claymore", "Dual Swords", "Clarent Blade", "Carving Sword",
    "Galatine Pair", "Kingmaker", "Infinity Blade"
  ],
  Axe: [
    "Battleaxe", "Greataxe", "Halberd", "Carrioncaller", "Infernal Scythe",
    "Bear Paws", "Realmbreaker", "Crystal Reaper"
  ],
  Mace: [
    "Mace", "Heavy Mace", "Morning Star", "Bedrock Mace", "Incubus Mace",
    "Camlann Mace", "Oathkeepers", "Dreadstorm Monarch"
  ],
  Hammer: [
    "Hammer", "Polehammer", "Great Hammer", "Tombhammer", "Forge Hammers",
    "Grovekeeper", "Hand of Justice", "Truebolt Hammer"
  ],
  "War Gloves": [
    "Brawler Gloves", "Battle Bracers", "Spiked Gauntlets", "Ursine Maulers",
    "Hellfire Hands", "Ravenstrike Cestus", "Fists of Avalon", "Forcepulse Bracers"
  ],
  Crossbow: [
    "Crossbow", "Heavy Crossbow", "Light Crossbow", "Weeping Repeater",
    "Boltcasters", "Siegebow", "Energy Shaper", "Arclight Blasters"
  ],
  Bow: [
    "Bow", "Warbow", "Longbow", "Whispering Bow", "Wailing Bow", "Bow of Badon",
    "Mistpiercer", "Skystrider Bow"
  ],
  Dagger: [
    "Dagger", "Dagger Pair", "Claws", "Bloodletter", "Demonfang", "Deathgivers",
    "Bridled Fury", "Twin Slayers"
  ],
  Spear: [
    "Spear", "Pike", "Glaive", "Heron Spear", "Spirithunter", "Trinity Spear",
    "Daybreaker", "Rift Glaive"
  ],
  Quarterstaff: [
    "Quarterstaff", "Iron-clad Staff", "Double Bladed Staff", "Black Monk Staff",
    "Soulscythe", "Staff of Balance", "Grailseeker", "Phantom Twinblade"
  ],
  "Shapeshifter Staff": [
    "Prowling Staff", "Rootbound Staff", "Primal Staff", "Bloodmoon Staff",
    "Hellspawn Staff", "Earthrune Staff", "Lightcaller", "Stillgaze Staff"
  ],
  "Nature Staff": [
    "Nature Staff", "Great Nature Staff", "Wild Staff", "Druidic Staff",
    "Blight Staff", "Rampant Staff", "Ironroot Staff", "Forgebark Staff"
  ],
  "Fire Staff": [
    "Fire Staff", "Great Fire Staff", "Infernal Staff", "Wildfire Staff",
    "Brimstone Staff", "Blazing Staff", "Dawnsong", "Flamewalker Staff"
  ],
  "Holy Staff": [
    "Holy Staff", "Great Holy Staff", "Divine Staff", "Lifetouch Staff",
    "Fallen Staff", "Redemption Staff", "Hallowfall", "Exalted Staff"
  ],
  "Arcane Staff": [
    "Arcane Staff", "Great Arcane Staff", "Enigmatic Staff", "Witchwork Staff",
    "Occult Staff", "Malevolent Locus", "Evensong", "Astral Staff"
  ],
  "Frost Staff": [
    "Frost Staff", "Great Frost Staff", "Glacial Staff", "Hoarfrost Staff",
    "Icicle Staff", "Permafrost Prism", "Chillhowl", "Arctic Staff"
  ],
  "Cursed Staff": [
    "Cursed Staff", "Great Cursed Staff", "Demonic Staff", "Lifecurse Staff",
    "Cursed Skull", "Damnation Staff", "Shadowcaller", "Rotcaller Staff"
  ]
} as const;

// Tree labels remain distinct from base weapon names so the one-name-per-line
// catalogue editor is unambiguous while the stable tree keys remain singular.
const TREE_DISPLAY_NAMES: Record<keyof typeof WEAPON_FAMILIES, string> = {
  Sword: "Swords",
  Axe: "Axes",
  Mace: "Maces",
  Hammer: "Hammers",
  "War Gloves": "War Gloves",
  Crossbow: "Crossbows",
  Bow: "Bows",
  Dagger: "Daggers",
  Spear: "Spears",
  Quarterstaff: "Quarterstaffs",
  "Shapeshifter Staff": "Shapeshifter Staffs",
  "Nature Staff": "Nature Staffs",
  "Fire Staff": "Fire Staffs",
  "Holy Staff": "Holy Staffs",
  "Arcane Staff": "Arcane Staffs",
  "Frost Staff": "Frost Staffs",
  "Cursed Staff": "Cursed Staffs"
};

export const SPECIALISATION_TREE_COUNT = 17;
export const SPECIALISATION_WEAPON_COUNT = 136;
export const SPECIALISATION_CATALOGUE_COUNT = 153;

function stableKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function stableWeaponKey(name: string): string {
  // Preserve the original persisted key while using the current in-game English display name.
  return name === "Black Monk Staff" ? "black-monk-stave" : stableKey(name);
}

const treeEntries: CatalogueEntry[] = (Object.keys(WEAPON_FAMILIES) as Array<keyof typeof WEAPON_FAMILIES>).map((keyName) => ({
  key: `tree:${stableKey(keyName)}`,
  name: TREE_DISPLAY_NAMES[keyName],
  kind: "tree"
}));

const weaponEntries: CatalogueEntry[] = Object.entries(WEAPON_FAMILIES).flatMap(
  ([treeName, weapons]) => weapons.map((name) => ({
    key: `weapon:${stableWeaponKey(name)}`,
    name,
    kind: "weapon" as const,
    treeKey: `tree:${stableKey(treeName)}`
  }))
);

export const SPECIALISATION_CATALOGUE: readonly CatalogueEntry[] = Object.freeze(
  [...treeEntries, ...weaponEntries].map((entry) => Object.freeze(entry))
);

export const catalogueByKey: ReadonlyMap<string, CatalogueEntry> = new Map(
  SPECIALISATION_CATALOGUE.map((entry) => [entry.key, entry])
);

export function normalizeCatalogueName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

const catalogueByNormalizedName: ReadonlyMap<string, CatalogueEntry> = new Map(
  SPECIALISATION_CATALOGUE.map((entry) => [normalizeCatalogueName(entry.name), entry])
);

export function levelForKind(kind: SpecialisationKind): SpecialisationLevel {
  return kind === "weapon" ? 100 : 800;
}

export function isLevelValidForKind(kind: SpecialisationKind, level: number): level is SpecialisationLevel {
  return levelForKind(kind) === level;
}

export function listEnabledCatalogue(excludedKeys: ReadonlySet<string>): CatalogueEntry[] {
  return SPECIALISATION_CATALOGUE.filter((entry) => !excludedKeys.has(entry.key));
}

export function catalogueModalValue(excludedKeys: ReadonlySet<string>): string {
  const enabledEntries = listEnabledCatalogue(excludedKeys);
  const sections = [
    enabledEntries.filter((entry) => entry.kind === "tree"),
    ...treeEntries.map((tree) => enabledEntries.filter((entry) => entry.treeKey === tree.key))
  ].filter((section) => section.length > 0);

  return sections.map((section) => section.map((entry) => entry.name).join("\n")).join("\n\n");
}

export function parseCatalogueSelection(value: string): ParsedCatalogueSelection {
  const enabledKeys = new Set<string>();
  const invalidNames: string[] = [];
  let duplicateCount = 0;

  for (const rawLine of value.split(/\r?\n/)) {
    const displayLine = rawLine.trim().replace(/\s+/g, " ");
    if (!displayLine) continue;
    const entry = catalogueByNormalizedName.get(normalizeCatalogueName(displayLine));
    if (!entry) {
      invalidNames.push(displayLine);
      continue;
    }
    if (enabledKeys.has(entry.key)) {
      duplicateCount += 1;
      continue;
    }
    enabledKeys.add(entry.key);
  }

  return {
    enabledKeys,
    disabledKeys: new Set(
      SPECIALISATION_CATALOGUE.filter((entry) => !enabledKeys.has(entry.key)).map((entry) => entry.key)
    ),
    duplicateCount,
    invalidNames
  };
}

export function searchCatalogue(
  kind: SpecialisationKind,
  query: string,
  excludedKeys: ReadonlySet<string> = new Set()
): CatalogueEntry[] {
  const normalizedQuery = normalizeCatalogueName(query);
  return SPECIALISATION_CATALOGUE
    .filter((entry) =>
      entry.kind === kind
      && !excludedKeys.has(entry.key)
      && normalizeCatalogueName(entry.name).includes(normalizedQuery)
    )
    .slice(0, 25);
}
