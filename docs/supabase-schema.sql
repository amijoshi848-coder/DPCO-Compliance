-- Already applied to project sxhlxlqsdvldccayomyq as dpco_server_state.
-- Reference for provisioning another project; do not reapply to the current table.
CREATE TABLE public.dpco_app_state (
  id text PRIMARY KEY CHECK (id = 'main'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.dpco_app_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dpco_app_state FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.dpco_app_state TO service_role;
COMMENT ON TABLE public.dpco_app_state IS
  'Server-only DPCO application state; existing application authorization applies. No browser access.';
