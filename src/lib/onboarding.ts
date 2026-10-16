export interface OnboardingQuestion {
  id: string;
  label: string;
  placeholder: string;
  long?: boolean;
}

export interface OnboardingSection {
  id: string;
  title: string;
  intro: string;
  questions: OnboardingQuestion[];
}

// Every field starts blank; nothing about any person is pre-filled.
export const ONBOARDING: OnboardingSection[] = [
  {
    id: "identity",
    title: "About you",
    intro: "The basics, so I can address you properly and keep time correctly.",
    questions: [
      { id: "name", label: "Your name", placeholder: "" },
      { id: "role", label: "Role or occupation", placeholder: "" },
      { id: "employer", label: "Employer or business (optional)", placeholder: "" },
      { id: "location", label: "Location and timezone", placeholder: "City, timezone" },
    ],
  },
  {
    id: "experience",
    title: "Experience and skills",
    intro: "Only things that are true. I treat this as the source of truth for anything I write about you.",
    questions: [
      { id: "experience", label: "Experience summary", placeholder: "Years, domains, notable work", long: true },
      { id: "skills", label: "Skills", placeholder: "Comma separated", long: true },
      { id: "certs", label: "Certifications", placeholder: "Name, issuer, year", long: true },
    ],
  },
  {
    id: "rules",
    title: "Your rules",
    intro: "How you want things done and what I should leave alone.",
    questions: [
      { id: "format", label: "Formatting and tone preferences", placeholder: "e.g. short answers, plain language", long: true },
      { id: "flag", label: "Always flag immediately", placeholder: "e.g. interview invites, bank alerts", long: true },
      { id: "ignore", label: "Ignore or never touch", placeholder: "e.g. ads, appointment-portal messages", long: true },
    ],
  },
  {
    id: "goals",
    title: "Goals",
    intro: "What you are working toward right now.",
    questions: [{ id: "goals", label: "Current goals and priorities", placeholder: "1 to 3 lines", long: true }],
  },
];

export type Answers = Record<string, string>;

export interface OnboardingState {
  step: number;
  answers: Answers;
  status: "pending" | "done" | "skipped";
}

const KEY = "mrvilsyagent.onboarding.v1";

export const emptyOnboarding = (): OnboardingState => ({ step: 0, answers: {}, status: "pending" });

export function loadOnboarding(): OnboardingState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as OnboardingState | null;
    if (parsed && typeof parsed.step === "number" && parsed.answers) return parsed;
  } catch {
    /* start fresh */
  }
  return emptyOnboarding();
}

export function saveOnboarding(state: OnboardingState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export interface MemoryNote {
  title: string;
  fact: string;
}

// One note per section, built only from non-empty answers.
export function buildMemoryNotes(answers: Answers): MemoryNote[] {
  const notes: MemoryNote[] = [];
  for (const section of ONBOARDING) {
    const lines = section.questions
      .map((question) => [question.label.replace(/\s*\(optional\)/i, ""), (answers[question.id] ?? "").trim()] as const)
      .filter(([, value]) => value)
      .map(([label, value]) => `- ${label}: ${value}`);
    if (lines.length) notes.push({ title: section.title, fact: `## ${section.title}\n${lines.join("\n")}` });
  }
  return notes;
}
