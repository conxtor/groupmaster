export type Language = "de" | "es" | "ca" | "en" | "fr";
export type Category = "relevance" | "event" | "place" | "keyword" | "exclusion";

export const languageNames: Record<Language, string> = { de: "Deutsch", es: "Español", ca: "Català", en: "English", fr: "Français" };
export const categoryNames: Record<Category, string> = { relevance: "Relevanz", event: "Events", place: "Orte", keyword: "Knowledge-Schlüsselwort", exclusion: "Ausschlusswort" };
export const categoryDescriptions: Record<Category, string> = {
  relevance: "Begriffe, die die Relevanz einer Nachricht beeinflussen.",
  event: "Begriffe für Treffen, Termine und mehrteilige Ereignisse.",
  place: "Begriffe für Orte, Treffpunkte und Ortsangaben.",
  keyword: "Begriffe, die Knowledge-Themen und Unterthemen zuordnen.",
  exclusion: "Füllwörter und Floskeln, die Signale abschwächen.",
};
