// src/engine/types.ts
// Written verbatim from the Connective Sandbox phase 1 build brief.
// FROZEN except for ONE captain-approved reviewed extension (module waves
// 1+2, 2026-09-30): `photo_slot` and `follow_up_card` joined the
// IntakeComponent union; `triage_verdict`, `quote_panel`, `escalation_card`,
// `thread_preview`, `status_queue`, `alert_feed`, `kpi_tiles`, and
// `pipeline_tracker` joined the DashboardPanel union. Nothing else changed.
// src/engine/ is pure: it must never import from src/data/, Supabase, or any
// network library.

type WorkflowSpec = {
  name: string
  description: string
  intake: { components: IntakeComponent[] }
  judges: Judge[]
  dashboard: { panels: DashboardPanel[] }
}

type FormField = {
  id: string
  label: string
  type: 'text' | 'textarea' | 'select'
  required?: boolean
  options?: { value: string; label: string }[]
}

type IntakeComponent =
  | { type: 'file_upload'; id: string; label: string; accept: string[]; multiple: boolean; instructions: string }
  | { type: 'chat'; id: string; placeholder: string; opening_message: string }
  | { type: 'button_group'; id: string; label: string; options: { value: string; label: string }[]; multi: boolean }
  | { type: 'text_field'; id: string; label: string; multiline: boolean }
  | { type: 'form'; id: string; fields: FormField[] }
  | { type: 'photo_slot'; id: string; label: string; capture_hint: string; accept: string[]; key: string }
  | { type: 'follow_up_card'; id: string; label: string; question: string; options: { value: string; label: string }[]; allow_text: boolean }

type Judge = {
  id: string
  state_from: string[]
  question: string
  question_type: 'choice' | 'boolean' | 'scalar'
  options?: string[]
  thresholds: { auto: number; review: number }
}

type DashboardPanel =
  | { type: 'confidence_meter'; id: string; judge_id: string; label: string }
  | { type: 'analysis'; id: string; title: string; source: 'llm' | 'judges' }
  | { type: 'monitoring'; id: string; metrics: string[] }
  | { type: 'decision_log'; id: string; limit: number }
  | { type: 'usage_counter'; id: string; label: string }
  | {
      type: 'triage_verdict'
      id: string
      judge_id: string
      verdicts: { value: string; label: string }[]
      follow_up_judge_id?: string
    }
  | {
      type: 'quote_panel'
      id: string
      title: string
      lines: { label: string; quantity?: number; amount: string }[]
      basis: string
      status: 'draft' | 'sent' | 'accepted' | 'expired'
      band_judge_id?: string
      bands?: { value: string; label: string }[]
    }
  | {
      type: 'escalation_card'
      id: string
      contact: string
      reason: string
      reference?: string
      action_label: string
      judge_id?: string
    }
  | {
      type: 'thread_preview'
      id: string
      title: string
      photo_slot_key?: string
      follow_up_judge_id?: string
      quote_judge_id?: string
    }
  | {
      type: 'status_queue'
      id: string
      title: string
      rows: { id: string; label: string; source: string; severity: 'low' | 'medium' | 'high'; state: string }[]
      actions: { value: string; label: string; primary: boolean }[]
    }
  | {
      type: 'alert_feed'
      id: string
      title: string
      alerts: { id: string; title: string; source: string; age_days: number; severity: 'low' | 'medium' | 'high' }[]
      action_label: string
      critical_after_days?: number
    }
  | { type: 'kpi_tiles'; id: string; title: string; metrics: { label: string; metric: string; delta?: { direction: 'up' | 'down' | 'flat'; text: string } }[] }
  | {
      type: 'pipeline_tracker'
      id: string
      title: string
      stages: { label: string; count?: number }[]
      current_judge_id?: string
      current?: string
    }

type JudgeQuestion = {
  id: string
  type: Judge['question_type']
  question: string
  options?: string[]
}

type JudgeAnswer = {
  id: string
  value: string | boolean | number
  probabilities: Record<string, number>
  confidence: number
}

interface JudgeProvider {
  judge(state: string | object, questions: JudgeQuestion[]): Promise<JudgeAnswer[]>
}

export type {
  WorkflowSpec,
  FormField,
  IntakeComponent,
  Judge,
  DashboardPanel,
  JudgeQuestion,
  JudgeAnswer,
}
export type { JudgeProvider }
