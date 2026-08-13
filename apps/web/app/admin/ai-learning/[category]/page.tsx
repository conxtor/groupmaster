"use client";

import { useSearchParams } from "next/navigation";
import { AuthGate } from "../../../auth";
import LearningTermManager, { isLearningCategory } from "../learning-term-manager";
import { Language } from "../learning-shared";

export default function AdminAILearningCategoryPage({ params }: { params: { category: string } }) {
  const { category } = params;
  const searchParams = useSearchParams();
  const requestedLanguage = searchParams.get("language");
  const language = requestedLanguage === "es" || requestedLanguage === "ca" || requestedLanguage === "en" || requestedLanguage === "fr" ? requestedLanguage as Language : "de";
  if (!isLearningCategory(category)) return <AuthGate><main className="shell adminPage"><div className="notice">Unbekannte Lernmodell-Kategorie.</div></main></AuthGate>;
  return <AuthGate><LearningTermManager category={category} initialLanguage={language} /></AuthGate>;
}
