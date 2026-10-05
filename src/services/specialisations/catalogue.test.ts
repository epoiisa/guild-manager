import assert from "node:assert/strict";
import test from "node:test";
import {
  SPECIALISATION_CATALOGUE,
  SPECIALISATION_CATALOGUE_COUNT,
  SPECIALISATION_TREE_COUNT,
  SPECIALISATION_WEAPON_COUNT,
  catalogueByKey,
  catalogueModalValue,
  normalizeCatalogueName,
  parseCatalogueSelection,
  searchCatalogue
} from "./catalogue.js";

test("canonical catalogue is the complete current 17-tree, 136-weapon snapshot", () => {
  const trees = SPECIALISATION_CATALOGUE.filter((entry) => entry.kind === "tree");
  const weapons = SPECIALISATION_CATALOGUE.filter((entry) => entry.kind === "weapon");

  assert.equal(SPECIALISATION_CATALOGUE.length, SPECIALISATION_CATALOGUE_COUNT);
  assert.equal(trees.length, SPECIALISATION_TREE_COUNT);
  assert.equal(weapons.length, SPECIALISATION_WEAPON_COUNT);
  assert.equal(SPECIALISATION_TREE_COUNT, 17);
  assert.equal(SPECIALISATION_WEAPON_COUNT, 136);
  assert.equal(SPECIALISATION_CATALOGUE_COUNT, 153);

  assert.equal(catalogueByKey.get("weapon:infinity-blade")?.treeKey, "tree:sword");
  assert.equal(catalogueByKey.get("weapon:truebolt-hammer")?.treeKey, "tree:hammer");
  assert.equal(catalogueByKey.get("weapon:stillgaze-staff")?.treeKey, "tree:shapeshifter-staff");
  assert.equal(catalogueByKey.get("weapon:demonfang")?.treeKey, "tree:dagger");
  assert.equal(catalogueByKey.get("weapon:black-monk-stave")?.name, "Black Monk Staff");
  assert.equal(catalogueByKey.has("weapon:black-monk-staff"), false);
  assert.equal(catalogueByKey.has("weapon:black-hands"), false);
  assert.equal(catalogueByKey.has("tree:shield"), false);
  assert.equal(catalogueByKey.has("tree:torch"), false);
  assert.equal(catalogueByKey.has("tree:tome-of-spells"), false);
});

test("canonical keys, normalized names, and weapon-to-tree mappings are invariant", () => {
  const keys = new Set<string>();
  const names = new Set<string>();
  const weaponCounts = new Map<string, number>();

  for (const entry of SPECIALISATION_CATALOGUE) {
    assert.equal(keys.has(entry.key), false, `duplicate key ${entry.key}`);
    keys.add(entry.key);
    const normalizedName = normalizeCatalogueName(entry.name);
    assert.equal(names.has(normalizedName), false, `duplicate name ${entry.name}`);
    names.add(normalizedName);
    if (entry.kind === "tree") {
      assert.equal(entry.treeKey, undefined);
      continue;
    }
    assert.ok(entry.treeKey);
    assert.equal(catalogueByKey.get(entry.treeKey)?.kind, "tree");
    weaponCounts.set(entry.treeKey, (weaponCounts.get(entry.treeKey) ?? 0) + 1);
  }

  for (const tree of SPECIALISATION_CATALOGUE.filter((entry) => entry.kind === "tree")) {
    assert.equal(weaponCounts.get(tree.key), 8, `${tree.name} should contain eight weapons`);
  }
});

test("catalogue ordering matches the configured tree and family sequence", () => {
  assert.deepEqual(
    SPECIALISATION_CATALOGUE.map((entry) => entry.name),
    [
      "Swords", "Axes", "Maces", "Hammers", "War Gloves", "Crossbows", "Bows", "Daggers",
      "Spears", "Quarterstaffs", "Shapeshifter Staffs", "Nature Staffs", "Fire Staffs", "Holy Staffs",
      "Arcane Staffs", "Frost Staffs", "Cursed Staffs",
      "Broadsword", "Claymore", "Dual Swords", "Clarent Blade", "Carving Sword", "Galatine Pair", "Kingmaker",
      "Infinity Blade",
      "Battleaxe", "Greataxe", "Halberd", "Carrioncaller", "Infernal Scythe", "Bear Paws", "Realmbreaker",
      "Crystal Reaper",
      "Mace", "Heavy Mace", "Morning Star", "Bedrock Mace", "Incubus Mace", "Camlann Mace", "Oathkeepers",
      "Dreadstorm Monarch",
      "Hammer", "Polehammer", "Great Hammer", "Tombhammer", "Forge Hammers", "Grovekeeper", "Hand of Justice",
      "Truebolt Hammer",
      "Brawler Gloves", "Battle Bracers", "Spiked Gauntlets", "Ursine Maulers", "Hellfire Hands",
      "Ravenstrike Cestus", "Fists of Avalon", "Forcepulse Bracers",
      "Crossbow", "Heavy Crossbow", "Light Crossbow", "Weeping Repeater", "Boltcasters", "Siegebow",
      "Energy Shaper", "Arclight Blasters",
      "Bow", "Warbow", "Longbow", "Whispering Bow", "Wailing Bow", "Bow of Badon", "Mistpiercer", "Skystrider Bow",
      "Dagger", "Dagger Pair", "Claws", "Bloodletter", "Demonfang", "Deathgivers", "Bridled Fury", "Twin Slayers",
      "Spear", "Pike", "Glaive", "Heron Spear", "Spirithunter", "Trinity Spear", "Daybreaker", "Rift Glaive",
      "Quarterstaff", "Iron-clad Staff", "Double Bladed Staff", "Black Monk Staff", "Soulscythe",
      "Staff of Balance", "Grailseeker", "Phantom Twinblade",
      "Prowling Staff", "Rootbound Staff", "Primal Staff", "Bloodmoon Staff", "Hellspawn Staff", "Earthrune Staff",
      "Lightcaller", "Stillgaze Staff",
      "Nature Staff", "Great Nature Staff", "Wild Staff", "Druidic Staff", "Blight Staff", "Rampant Staff",
      "Ironroot Staff", "Forgebark Staff",
      "Fire Staff", "Great Fire Staff", "Infernal Staff", "Wildfire Staff", "Brimstone Staff", "Blazing Staff",
      "Dawnsong", "Flamewalker Staff",
      "Holy Staff", "Great Holy Staff", "Divine Staff", "Lifetouch Staff", "Fallen Staff", "Redemption Staff",
      "Hallowfall", "Exalted Staff",
      "Arcane Staff", "Great Arcane Staff", "Enigmatic Staff", "Witchwork Staff", "Occult Staff",
      "Malevolent Locus", "Evensong", "Astral Staff",
      "Frost Staff", "Great Frost Staff", "Glacial Staff", "Hoarfrost Staff", "Icicle Staff", "Permafrost Prism",
      "Chillhowl", "Arctic Staff",
      "Cursed Staff", "Great Cursed Staff", "Demonic Staff", "Lifecurse Staff", "Cursed Skull", "Damnation Staff",
      "Shadowcaller", "Rotcaller Staff"
    ]
  );
});

test("complete enabled catalogue fits one Discord modal text input", () => {
  const value = catalogueModalValue(new Set());
  const sections = value.split("\n\n");
  assert.ok(value.length > 0);
  assert.ok(value.length <= 4_000, `catalogue modal is ${value.length} characters`);
  assert.equal(value.split("\n").filter(Boolean).length, SPECIALISATION_CATALOGUE_COUNT);
  assert.equal(sections.length, SPECIALISATION_TREE_COUNT + 1);
  assert.deepEqual(sections.map((section) => section.split("\n").length), [17, ...Array(17).fill(8)]);
  assert.deepEqual(
    sections.flatMap((section) => section.split("\n")),
    SPECIALISATION_CATALOGUE.map((entry) => entry.name)
  );
  assert.equal(
    sections[1],
    "Broadsword\nClaymore\nDual Swords\nClarent Blade\nCarving Sword\nGalatine Pair\nKingmaker\nInfinity Blade"
  );
});

test("catalogue modal parsing canonicalizes names and reports duplicates and invalid lines", () => {
  const parsed = parseCatalogueSelection("  axes  \nBATTLEAXE\n  battleaxe \nUnknown Weapon\n\n");
  assert.deepEqual([...parsed.enabledKeys], ["tree:axe", "weapon:battleaxe"]);
  assert.equal(parsed.duplicateCount, 1);
  assert.deepEqual(parsed.invalidNames, ["Unknown Weapon"]);
  assert.equal(parsed.disabledKeys.size, SPECIALISATION_CATALOGUE_COUNT - 2);
  assert.equal(parseCatalogueSelection("").enabledKeys.size, 0);
});

test("autocomplete searches the complete enabled catalogue and caps results at 25", () => {
  assert.equal(searchCatalogue("weapon", "", new Set()).length, 25);
  assert.deepEqual(
    searchCatalogue("weapon", "truebolt", new Set()).map((entry) => entry.key),
    ["weapon:truebolt-hammer"]
  );
  assert.deepEqual(searchCatalogue("weapon", "truebolt", new Set(["weapon:truebolt-hammer"])), []);
  assert.deepEqual(
    searchCatalogue("tree", "  shapeshifter   staffs ", new Set()).map((entry) => entry.key),
    ["tree:shapeshifter-staff"]
  );
});
