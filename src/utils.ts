import type { Candidate, CandidateStage } from "./types";

export function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value)).split("/").join("-");
}

export function candidateHireStatusText(value: unknown): string {
  return String(value ?? "").trim();
}

export function candidateYearsExperienceText(
  candidate: Pick<Partial<Candidate>, "years_experience" | "years_experience_raw" | "years_experience_display">,
): string {
  const display = String(candidate.years_experience_display ?? "").trim();
  if (display) return display;
  const raw = String(candidate.years_experience_raw ?? "").trim();
  if (raw) return raw;
  const numeric = candidate.years_experience;
  return numeric !== null && numeric !== undefined && Number.isFinite(Number(numeric))
    ? String(numeric)
    : "";
}

export function hasHireInformation(candidate: Pick<Candidate, "hire_status" | "hire_date" | "hire_position">): boolean {
  return Boolean(
    String(candidate.hire_status ?? "").trim()
    || String(candidate.hire_date ?? "").trim()
    || String(candidate.hire_position ?? "").trim(),
  );
}

export function candidateDisplayAge(
  candidate: Pick<Candidate, "birth_date" | "age">,
  today = new Date(),
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(candidate.birth_date?.trim() ?? "");
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    const validDate = parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
    if (validDate) {
      let age = today.getFullYear() - year;
      const birthdayPending = today.getMonth() + 1 < month
        || (today.getMonth() + 1 === month && today.getDate() < day);
      if (birthdayPending) age -= 1;
      if (age >= 0 && age <= 120) return age;
    }
  }

  if (candidate.age === null || candidate.age === undefined) return null;
  const importedAge = Number(candidate.age);
  return Number.isFinite(importedAge) && importedAge >= 0 && importedAge <= 120
    ? Math.floor(importedAge)
    : null;
}

export function maskPhone(phone: string): string {
  if (phone.length < 7) return phone || "-";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email ? "***" : "-";
  return `${name.slice(0, 1)}***@${domain}`;
}

export function initials(name: string): string {
  return name.trim().slice(-2) || "--";
}

export function stageClass(stage: CandidateStage): string {
  const map: Record<CandidateStage, string> = {
    "新候选人": "stage-new",
    "筛选中": "stage-screening",
    "面试中": "stage-interview",
    Offer: "stage-offer",
    "已入职": "stage-hired",
    "不合适": "stage-rejected",
  };
  return map[stage];
}

export function searchableCandidate(candidate: Candidate): string {
  return [
    candidate.name,
    candidate.current_company,
    candidate.current_title,
    candidate.location,
    candidate.owner,
    candidate.source,
    candidate.highest_school,
    candidate.highest_major,
    candidate.job_seeking_status,
    ...candidate.tags,
    ...candidate.talent_pools.map((pool) => pool.name),
  ]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function nextCandidateId(): string {
  const now = new Date();
  const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `CAN-${month}-${String(Date.now()).slice(-5)}`;
}
