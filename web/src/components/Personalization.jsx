import React from 'react';
import { Checkbox, DecimalInput } from './ui.jsx';

export const QUESTION_TYPES = [
  { value: 'text_input', label: 'Text the buyer types' },
  { value: 'dropdown', label: 'Dropdown (buyer picks one)' },
  { value: 'unlabeled_upload', label: 'File upload' },
  { value: 'labeled_upload', label: 'File upload (buyer names each file)' },
];

export const MAX_QUESTIONS = 5;

const blankQuestion = () => ({
  questionText: 'Personalization', instructions: '', questionType: 'text_input',
  isRequired: false, charCountMax: 256, maxFiles: 1, addOnPrice: '', options: [],
});

/**
 * Etsy's real personalization shape: up to 5 questions, each its own type
 * (free text, a dropdown, or a file upload), each optionally required and
 * optionally carrying an extra charge. Shared between the Draft desk and the
 * Listings edit drawer -- both stage the same { isPersonalizable, questions }
 * shape and send it through POST/DELETE .../personalization untouched.
 */
export function PersonalizationEditor({ value, changed, onChange }) {
  const v = value && Object.keys(value).length ? value : { isPersonalizable: false, questions: [] };
  const questions = v.questions?.length ? v.questions : [blankQuestion()];

  const setQuestions = (next) => onChange({ ...v, questions: next });
  const updateAt = (i, patch) => setQuestions(questions.map((q, n) => (n === i ? { ...q, ...patch } : q)));
  const removeAt = (i) => setQuestions(questions.filter((_, n) => n !== i));
  const addQuestion = () => setQuestions([...questions, blankQuestion()]);

  return (
    <div className="mb16">
      {changed && <div className="mb4"><span className="badge amber">changed</span></div>}
      <Checkbox
        checked={!!v.isPersonalizable}
        onChange={(checked) => onChange({ ...v, isPersonalizable: checked, questions: checked ? questions : v.questions })}
        label="Buyers can personalize this listing"
      />
      {v.isPersonalizable && (
        <>
          {questions.map((q, i) => (
            <div key={i} className="card mt8" style={{ padding: 10 }}>
              <div className="flex gap4" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="small dim">Question {i + 1} of {MAX_QUESTIONS}</span>
                {questions.length > 1 && (
                  <button type="button" className="btn xs ghost" onClick={() => removeAt(i)} aria-label="Remove question">×</button>
                )}
              </div>
              <div className="field">
                <label>Question shown to the buyer</label>
                <input className="input" value={q.questionText} onChange={(e) => updateAt(i, { questionText: e.target.value })} />
              </div>
              <div className="field">
                <label>Instructions</label>
                <input className="input" value={q.instructions} onChange={(e) => updateAt(i, { instructions: e.target.value })} />
              </div>
              <div className="split">
                <div className="field">
                  <label>Type</label>
                  <select className="select" value={q.questionType} onChange={(e) => updateAt(i, { questionType: e.target.value })}>
                    {QUESTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <Checkbox checked={q.isRequired} onChange={(checked) => updateAt(i, { isRequired: checked })} label="Required" />
              </div>

              {q.questionType === 'text_input' && (
                <div className="field">
                  <label>Max characters</label>
                  <input className="input" type="number" min={1} value={q.charCountMax ?? 256}
                         onChange={(e) => updateAt(i, { charCountMax: Number(e.target.value) })} />
                </div>
              )}

              {(q.questionType === 'unlabeled_upload' || q.questionType === 'labeled_upload') && (
                <div className="field">
                  <label>Max files</label>
                  <input className="input" type="number" min={1} value={q.maxFiles ?? 1}
                         onChange={(e) => updateAt(i, { maxFiles: Number(e.target.value) })} />
                </div>
              )}

              {q.questionType === 'dropdown' && (
                <div className="field">
                  <label>Options (one per line)</label>
                  <textarea className="textarea" rows={3} value={(q.options ?? []).join('\n')}
                            onChange={(e) => updateAt(i, { options: e.target.value.split('\n') })} />
                  <div className="hint">Blank lines are dropped when this is sent.</div>
                </div>
              )}

              <div className="field">
                <label>Extra charge for this (optional)</label>
                <DecimalInput value={q.addOnPrice} onChange={(v2) => updateAt(i, { addOnPrice: v2 })} placeholder="0.00" />
              </div>
            </div>
          ))}
          <button type="button" className="btn xs ghost mt8" disabled={questions.length >= MAX_QUESTIONS} onClick={addQuestion}>
            + Add question ({questions.length}/{MAX_QUESTIONS})
          </button>
        </>
      )}
    </div>
  );
}
