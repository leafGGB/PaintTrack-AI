// Shared copy for the package-wide delete confirmation.
//
// Every Studio has its own message bundle keyed to that screen's vocabulary,
// but the destructive-confirmation wording is identical across all of them
// ("Delete this item?" / "This cannot be undone."). Copying five keys into
// eighteen bundles (nine screens × two locales) would guarantee they drift,
// so the strings live here once and screens pull them by `locale`.
//
// English is the source of truth, matching `i18nUtils.resolveCopy`: an
// unknown or missing locale falls back to English rather than `undefined`.

import en from "./messages/en/confirmDialog.json";
import zh from "./messages/zh/confirmDialog.json";

const BUNDLES = { en, zh };

export function getConfirmCopy(locale) {
  if (!locale || locale === "en") return en;
  const tag = String(locale).toLowerCase();
  if (tag === "zh" || tag.startsWith("zh-")) return zh;
  return BUNDLES[tag] || en;
}

export default getConfirmCopy;
