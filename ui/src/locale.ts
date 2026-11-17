import { createContext, useContext } from "react";

export type Language = "ko" | "en";
export const LanguageContext = createContext<Language>("ko");
export const useLanguage = () => useContext(LanguageContext);
export type Translate = (korean: string, english: string) => string;

export function useText(): Translate {
  const language = useLanguage();
  return language === "en" ? englishText : koreanText;
}

const koreanText: Translate = (korean) => korean;
const englishText: Translate = (_, english) => english;
