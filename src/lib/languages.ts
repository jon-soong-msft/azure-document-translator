export interface Language {
  code: string;
  name: string;
}

/**
 * A curated subset of the most-used languages supported by Azure AI Translator.
 * The full list is large; these cover the vast majority of real-world use.
 */
export const LANGUAGES: Language[] = [
  { code: "ar", name: "Arabic" },
  { code: "bn", name: "Bengali" },
  { code: "zh-Hans", name: "Chinese (Simplified)" },
  { code: "zh-Hant", name: "Chinese (Traditional)" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "ms", name: "Malay" },
  { code: "no", name: "Norwegian" },
  { code: "fa", name: "Persian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
  { code: "sv", name: "Swedish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" },
];

export function languageName(code?: string): string {
  if (!code) return "Unknown";
  const match = LANGUAGES.find((l) => l.code.toLowerCase() === code.toLowerCase());
  return match ? match.name : code;
}
