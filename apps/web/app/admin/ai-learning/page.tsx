"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch, useAppLocale } from "../../auth";
import { adminCategoryDescription, adminCategoryName, adminTranslate } from "../admin-i18n";
import { Category, categoryDescriptions, categoryNames, Language, languageNames } from "./learning-shared";

type SummaryCategory = { category: Category; count: number; activeCount: number; learned24h: number; learned7d: number; learned30d: number };
type SummaryPoint = { bucket: string; counts: Record<Category, number> };
type Summary = { categories: SummaryCategory[]; hourly: SummaryPoint[]; daily: SummaryPoint[] };
type LearningPeriod = "24h" | "7d" | "30d";
type ReassessmentJob = { id: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; totalCount: number; processedCount: number; failedCount: number; skippedCount: number; error?: string };

const categoryColors: Record<Category, string> = { relevance: "#4c8b68", event: "#d8794e", place: "#6b82b4", keyword: "#9a78b3", exclusion: "#9b9b72" };
function formatDate(value?: string) {
  if (!value) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function LearningSummaryGraph({ points, period, locale }: { points: SummaryPoint[]; period: LearningPeriod; locale: import("../../i18n").Locale }) {
  const categories = Object.keys(categoryNames) as Category[];
  const width = 960;
  const height = 220;
  const chartTop = 22;
  const chartBottom = 182;
  const visiblePoints = period === "24h" ? points.slice(-24) : period === "7d" ? points.slice(-7) : points.slice(-30);
  const totals = visiblePoints.map((point) => categories.reduce((total, category) => total + (point.counts[category] ?? 0), 0));
  const maxValue = Math.max(1, ...totals);
  const step = width / Math.max(visiblePoints.length, 1);
  const barWidth = Math.max(3, step * 0.72);
  const periodLabel = period === "24h" ? adminTranslate(locale, "last24h") : period === "7d" ? adminTranslate(locale, "last7d") : adminTranslate(locale, "lastMonth");
  const formatBucket = (bucket: string) => new Date(bucket).toLocaleString("de-DE", period === "24h" ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", year: "numeric" });
  return <div className="learningChart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${adminTranslate(locale, "learnedOverTime")} · ${periodLabel}`}><line x1="0" y1={chartBottom} x2={width} y2={chartBottom} stroke="var(--line)" />{visiblePoints.map((point, index) => { let stackedHeight = 0; return categories.map((category) => { const value = point.counts[category] ?? 0; const barHeight = ((chartBottom - chartTop) * value) / maxValue; const total = totals[index] ?? 0; const rect = <rect key={`${point.bucket}-${category}`} x={index * step + (step - barWidth) / 2} y={chartBottom - stackedHeight - barHeight} width={barWidth} height={Math.max(0, barHeight)} rx="1.5" fill={categoryColors[category]}><title>{`${formatBucket(point.bucket)} · ${adminCategoryName(locale, category)}: ${value} · Gesamt: ${total}`}</title></rect>; stackedHeight += barHeight; return rect; }); })}<text x="0" y="211" fill="var(--muted)" fontSize="11">{visiblePoints[0] ? new Date(visiblePoints[0].bucket).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }) : ""}</text><text x={width - 48} y="211" fill="var(--muted)" fontSize="11">{visiblePoints.length ? new Date(visiblePoints[visiblePoints.length - 1].bucket).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }) : ""}</text></svg><div className="learningChartLegend" aria-label={adminTranslate(locale, "learnedOverTime")} >{categories.map((category) => <span key={category}><i style={{ background: categoryColors[category] }} aria-hidden="true" />{adminCategoryName(locale, category)}</span>)}</div></div>;
}

function ReassessmentCard() {
  const { locale } = useAppLocale();
  const at = (key: Parameters<typeof adminTranslate>[1], values?: Record<string, string | number>) => adminTranslate(locale, key, values);
  const [jobs, setJobs] = useState<ReassessmentJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const latest = jobs[0];
  async function loadJobs() {
    const response = await apiFetch("/api/v1/admin/ai-learning/reassessment");
    if (!response.ok) throw new Error(at("loadFailed"));
    setJobs(await response.json() as ReassessmentJob[]);
  }
  useEffect(() => { void loadJobs().catch((value) => setError(value instanceof Error ? value.message : at("loadFailed"))); }, []);
  useEffect(() => {
    if (!latest || !["queued", "running"].includes(latest.status)) return;
    const timer = window.setInterval(() => { void loadJobs().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [latest?.id, latest?.status]);
  async function start() {
    if (!window.confirm(at("reassessConfirm"))) return;
    setStarting(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/ai-learning/reassessment", { method: "POST" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? at("reassessStart"));
      await loadJobs();
    } catch (value) { setError(value instanceof Error ? value.message : at("failedStatus")); } finally { setStarting(false); }
  }
  const progress = latest && latest.totalCount > 0 ? Math.min(100, Math.round(((latest.processedCount + latest.failedCount + latest.skippedCount) / latest.totalCount) * 100)) : 0;
  const statusLabels = { queued: at("queuedStatus"), running: at("runningStatus"), completed: at("completedStatus"), failed: at("failedStatus"), cancelled: at("cancelledStatus") };
  return <section className="panel adminPanel learningReassessment"><div className="panelHead"><div><h2>{at("reassessTitle")}</h2><p className="muted">{at("reassessHint")}</p></div><button className="primaryButton" type="button" disabled={starting || latest?.status === "queued" || latest?.status === "running"} onClick={() => void start()}>{starting ? at("reassessStarting") : at("reassessStart")}</button></div>{error && <div className="notice">{error}</div>}{latest && <div className="learningJobStatus"><div><strong>{statusLabels[latest.status]}</strong><span>{latest.processedCount} verarbeitet · {latest.failedCount} fehlgeschlagen · {latest.skippedCount} übersprungen von {latest.totalCount}</span></div><div className="learningProgress"><i style={{ width: `${progress}%` }} /></div>{latest.error && <small className="statusLineError">{latest.error}</small>}</div>}</section>;
}

function AdminAILearningOverview() {
  const { locale } = useAppLocale();
  const at = (key: Parameters<typeof adminTranslate>[1], values?: Record<string, string | number>) => adminTranslate(locale, key, values);
  const [language, setLanguage] = useState<Language>("de");
  const [period, setPeriod] = useState<LearningPeriod>("7d");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void apiFetch(`/api/v1/admin/ai-learning/summary?language=${language}`).then(async (response) => { if (!response.ok) throw new Error("Lernmodell-Zusammenfassung konnte nicht geladen werden"); setSummary(await response.json() as Summary); }).catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen")); }, [language]);
  const categories = (Object.keys(categoryNames) as Category[]).map((category) => summary?.categories.find((item) => item.category === category) ?? { category, count: 0, activeCount: 0, learned24h: 0, learned7d: 0, learned30d: 0 });
  const graphPoints = period === "24h" ? summary?.hourly ?? [] : summary?.daily ?? [];
  const periodLabels: Record<LearningPeriod, string> = { "24h": at("last24h"), "7d": at("last7d"), "30d": at("lastMonth") };
  return <main className="shell adminPage"><header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{at("learningTitle")}</h1><p className="muted">{at("learningHint")}</p></div></header>{error && <div className="notice">{error}</div>}<ReassessmentCard /><section className="panel adminPanel"><div className="panelHead"><div><h2>{at("learningCategories")}</h2><p className="muted">{at("learningCategoriesHint")}</p></div><label className="learningLanguagePicker"><span>{at("language")}</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>{Object.entries(languageNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className="learningCategoryGrid">{categories.map((item) => <Link className="learningCategoryCard" href={`/admin/ai-learning/${item.category}?language=${language}`} key={item.category}><span className="learningCategoryAccent" style={{ background: categoryColors[item.category] }} /><strong>{adminCategoryName(locale, item.category)}</strong><small>{adminCategoryDescription(locale, item.category)}</small><div className="learningCategoryFacts"><b>{item.count}</b><span>{at("termCount", { count: item.activeCount })}</span></div><div className="learningCategoryPeriods"><span>24 h <b>{item.learned24h}</b></span><span>7 Tage <b>{item.learned7d}</b></span><span>1 Monat <b>{item.learned30d}</b></span></div></Link>)}</div></section><section className="panel adminPanel"><div className="panelHead"><div><h2>{at("learnedOverTime")}</h2><p className="muted">{at("learnedOverTimeHint")}</p></div><div className="learningChartControls"><span>{languageNames[language]}</span><label><span className="srOnly">{at("period")}</span><select value={period} onChange={(event) => setPeriod(event.target.value as LearningPeriod)}>{Object.entries(periodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></div><LearningSummaryGraph points={graphPoints} period={period} locale={locale} /><div className="learningMetricStrip">{categories.map((item) => <div key={item.category}><strong>{item.learned24h}</strong><span>{adminCategoryName(locale, item.category)} · 24 h</span><small>7 Tage: {item.learned7d} · 1 Monat: {item.learned30d}</small></div>)}</div></section></main>;
}

export default function AdminAILearningPage() { return <AuthGate><AdminAILearningOverview /></AuthGate>; }
