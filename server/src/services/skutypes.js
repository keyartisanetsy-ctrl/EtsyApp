/**
 * What kind of product a listing is, from its title - so an automatic SKU can
 * start with the letters of that kind: KC001 (keycap), KCS001 (keycap set),
 * BAG001, DM001 (deskmat), MP001 (mousepad), SW001 (switches), KB001 (keyboard),
 * MS001 (mouse) ...
 *
 * The rules are a short ordered list; the first one whose words appear in the
 * title wins, so the narrow ones (a keycap PULLER is a tool, not a keycap) come
 * before the wide ones (anything with "keycap" in it). A word matches whole
 * (case-insensitive, with an optional plural s); an entry written between
 * slashes is a regular expression. They can be changed from the Auto SKUs
 * screen and are then kept in the settings.
 */
import { readSetting, writeSetting } from './settings.js';
import { badRequest } from '../lib/errors.js';

export const DEFAULT_TYPES = [
  { key: 'tool', label: 'Tool', prefix: 'TL', words: 'puller, opener, tweezer, switch tester, lube brush' },
  { key: 'lube', label: 'Lube', prefix: 'LB', words: 'lube, lubricant, krytox' },
  { key: 'stabilizer', label: 'Stabilizer', prefix: 'ST', words: 'stabilizer, stabiliser' },
  { key: 'keychain', label: 'Keychain / plush', prefix: 'KY', words: 'keychain, key chain, lanyard, phone strap, plush' },
  { key: 'keyboard-kit', label: 'Keyboard', prefix: 'KB', words: 'barebone, barebones, keyboard kit, gasket mount, hot-swappable keyboard, tkl keyboard, alice layout, /\\b\\d{2,3}%\\s*(mechanical\\s*)?(gaming\\s*)?keyboard/' },
  { key: 'keycap-set', label: 'Keycap set', prefix: 'KCS', words: '/keycaps?\\s+set/, set of keycaps, /keycaps?.{0,60}\\b\\d{2,3}\\s*(pcs|keys)\\b/, /\\bsets?\\b.{0,40}keycaps?/' },
  { key: 'keycap', label: 'Keycap', prefix: 'KC', words: 'keycap' },
  { key: 'deskmat', label: 'Deskmat', prefix: 'DM', words: 'deskmat, desk mat, desk pad, deskpad' },
  { key: 'mousepad', label: 'Mousepad', prefix: 'MP', words: 'mousepad, mouse pad, mouse mat' },
  { key: 'mouse', label: 'Mouse', prefix: 'MS', words: 'mouse' },
  { key: 'bag', label: 'Bag', prefix: 'BAG', words: 'bag, pouch, tote, backpack, sling' },
  { key: 'switches', label: 'Switches', prefix: 'SW', words: 'switches, switch' },
  { key: 'wrist-rest', label: 'Wrist rest', prefix: 'WR', words: 'wrist rest, palm rest' },
  { key: 'cable', label: 'Cable', prefix: 'CB', words: 'cable' },
  { key: 'knob', label: 'Knob', prefix: 'KN', words: 'knob' },
  { key: 'sticker', label: 'Sticker', prefix: 'SK', words: 'sticker, decal' },
  { key: 'pcb', label: 'PCB / plate', prefix: 'PCB', words: 'pcb, switch plate' },
  { key: 'keyboard', label: 'Keyboard', prefix: 'KB', words: 'keyboard' },
];

const SETTING = 'sku.types';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rule list in use: what was saved, else the defaults. */
export function loadTypes() {
  const raw = readSetting(SETTING);
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) return list.map(clean);
    } catch { /* fall back to the defaults */ }
  }
  return DEFAULT_TYPES.map((t) => ({ ...t }));
}

function clean(t) {
  return {
    key: String(t.key || t.label || t.prefix).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'type',
    label: String(t.label ?? t.prefix ?? '').trim().slice(0, 40),
    prefix: String(t.prefix ?? '').trim().toUpperCase(),
    words: String(t.words ?? '').trim().slice(0, 600),
  };
}

/** Check an edited rule list (and return it cleaned) without keeping it. */
export function validateTypes(list) {
  if (!Array.isArray(list) || !list.length) throw badRequest('Give at least one product type.');
  if (list.length > 60) throw badRequest('That is more product types than make sense (60 at most).');
  const cleaned = list.map(clean);
  for (const t of cleaned) {
    if (!/^[A-Z0-9_-]{1,12}$/.test(t.prefix)) throw badRequest(`"${t.prefix || '(empty)'}" cannot start a SKU - use letters or digits, up to 12.`);
    if (!t.label) throw badRequest(`The type with prefix ${t.prefix} needs a name.`);
    compile(t); // throws on a broken expression
  }
  return cleaned;
}

/** Check and keep an edited rule list. */
export function saveTypes(list) {
  const cleaned = validateTypes(list);
  writeSetting(SETTING, JSON.stringify(cleaned));
  return cleaned;
}

export const resetTypes = () => { writeSetting(SETTING, ''); return loadTypes(); };

/** One rule as a RegExp. Plain words match whole, with an optional plural "s". */
function compile(t) {
  // a comma inside {2,3} belongs to an expression, it does not separate two words
  const parts = String(t.words).split(/\s*,(?![^{}]*\})\s*/).map((w) => w.trim()).filter(Boolean);
  const sources = [];
  for (const w of parts) {
    if (w.length > 2 && w.startsWith('/') && w.endsWith('/')) {
      try { new RegExp(w.slice(1, -1), 'i'); } catch { throw badRequest(`"${w}" is not a valid expression (type ${t.label}).`); }
      sources.push(`(?:${w.slice(1, -1)})`);
    } else {
      sources.push(`(?<![a-z0-9])${escape(w.toLowerCase()).replace(/\s+/g, '[\\s-]+')}s?(?![a-z0-9])`);
    }
  }
  return sources.length ? new RegExp(sources.join('|'), 'i') : null;
}

/** The first type whose rule matches this title, or null. */
export function classify(title, types = loadTypes()) {
  const text = String(title ?? '');
  for (const t of types) {
    const re = t._re ?? (t._re = compile(t));
    if (re && re.test(text)) return t;
  }
  return null;
}
