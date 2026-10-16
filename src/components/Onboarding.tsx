import { useState } from "react";
import { ONBOARDING, buildMemoryNotes, saveOnboarding, type OnboardingState } from "../lib/onboarding";

interface Props {
  initial: OnboardingState;
  // Receives the notes to put in the Approvals queue; nothing is written until the user approves each one.
  onFinish: (notes: ReturnType<typeof buildMemoryNotes>, answers: OnboardingState["answers"]) => void;
  onSkip: (state: OnboardingState) => void;
}

export function Onboarding({ initial, onFinish, onSkip }: Props) {
  const [state, setState] = useState<OnboardingState>(initial);
  const last = ONBOARDING.length;
  const section = ONBOARDING[state.step];

  const update = (next: OnboardingState) => {
    setState(next);
    saveOnboarding(next);
  };
  const setAnswer = (id: string, value: string) => update({ ...state, answers: { ...state.answers, [id]: value } });

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="modal-header">
          <div>
            <div className="eyebrow">GETTING TO KNOW YOU · {Math.min(state.step + 1, last + 1)} OF {last + 1}</div>
            <h2 id="onboarding-title">{section ? section.title : "All set"}</h2>
          </div>
        </div>
        {section ? (
          <>
            <p className="mail-help">{section.intro} Everything stays on this device, and nothing is saved until you approve it.</p>
            {section.questions.map((question) => (
              <div className="settings-section" key={question.id}>
                <label htmlFor={`ob-${question.id}`}>{question.label}</label>
                {question.long ? (
                  <textarea id={`ob-${question.id}`} rows={2} value={state.answers[question.id] ?? ""} placeholder={question.placeholder} onChange={(event) => setAnswer(question.id, event.target.value)} />
                ) : (
                  <input id={`ob-${question.id}`} value={state.answers[question.id] ?? ""} placeholder={question.placeholder} onChange={(event) => setAnswer(question.id, event.target.value)} />
                )}
              </div>
            ))}
          </>
        ) : (
          <p className="mail-help">
            I will add what you told me to your approvals queue as short notes for MEMORY.md. Review and approve each one in Agent → Approvals.
            Next, you can connect your mail in Mail and grant a documents folder in Agent → Documents, so I can learn from them.
          </p>
        )}
        <div className="agent-row">
          {state.step > 0 && <button className="secondary-button" onClick={() => update({ ...state, step: state.step - 1 })}>Back</button>}
          {section ? (
            <button className="primary-button" onClick={() => update({ ...state, step: state.step + 1 })}>{state.step === last - 1 ? "Review" : "Next"}</button>
          ) : (
            <button className="primary-button" onClick={() => onFinish(buildMemoryNotes(state.answers), state.answers)}>Queue notes for approval</button>
          )}
          <button className="secondary-button" onClick={() => onSkip(state)}>Skip for now</button>
        </div>
      </section>
    </div>
  );
}
