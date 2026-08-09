CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  quota_allowed integer NOT NULL DEFAULT 100,
  quota_used integer NOT NULL DEFAULT 0,
  quota_period_start timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.org_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position integer NOT NULL,
  type text NOT NULL CHECK (
    type IN (
      'llm_call',
      'http_request',
      'db_write',
      'notify',
      'conditional_branch',
      'approval_gate'
    )
  ),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, position)
);

CREATE TABLE public.workflow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (
    type IN ('manual', 'webhook', 'scheduled', 'database_event')
  ),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'running',
      'paused',
      'completed',
      'failed'
    )
  ),
  started_at timestamptz,
  completed_at timestamptz,
  error text
);

CREATE TABLE public.step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'running',
      'completed',
      'failed',
      'paused',
      'skipped'
    )
  ),
  input jsonb,
  output jsonb,
  error text,
  attempt_count integer NOT NULL DEFAULT 0,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_org_members_user_id
  ON public.org_members(user_id);

CREATE INDEX idx_org_members_org_id
  ON public.org_members(org_id);

CREATE INDEX idx_workflows_org_id
  ON public.workflows(org_id);

CREATE INDEX idx_workflow_steps_workflow_id
  ON public.workflow_steps(workflow_id);

CREATE INDEX idx_workflow_triggers_workflow_id
  ON public.workflow_triggers(workflow_id);

CREATE INDEX idx_workflow_runs_workflow_id
  ON public.workflow_runs(workflow_id);

CREATE INDEX idx_step_runs_workflow_run_id
  ON public.step_runs(workflow_run_id);

CREATE VIEW public.organization_usage AS
SELECT
  id AS organization_id,
  name,
  quota_allowed,
  quota_used,
  CASE
    WHEN quota_allowed = 0 THEN 0
    ELSE ROUND(
      (quota_used::numeric / quota_allowed::numeric) * 100,
      2
    )
  END AS quota_percentage
FROM public.organizations;
