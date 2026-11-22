-- Observation-only Admin phones do not create a paired incoming gateway.
-- An enrolled outgoing sender still receives a private wake for eligible receipts.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $migration$
DECLARE
  prior text;
  definition text;
  anchor constant text:='JOIN private.burimunsi_scopes s ON s.collection_id=p_group AND s.enabled';
  replacement constant text:='JOIN private.burimunsi_scopes s ON s.collection_id=p_group AND (s.enabled OR s.active_binding_id IS NULL)
  JOIN app.collections c ON c.id=s.collection_id AND c.status=''active''';
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS(SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
    RAISE EXCEPTION 'sender_wake_scope_requires_fence';
  END IF;
  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT prior,definition
    FROM pg_proc p WHERE p.oid='private._burimunsi_gateway_wake_allowed(text,text,text,text)'::regprocedure
      AND p.proowner='postgres'::regrole AND p.prosecdef;
  IF encode(sha256(convert_to(prior,'UTF8')),'hex')<>'2cc03b9c261d34c575fde3256ca913bfbda67deadf033f88904238e252eb3f9e'
     OR length(prior)-length(replace(prior,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'sender_wake_scope_preimage_changed';
  END IF;
  EXECUTE replace(definition,prior,replace(prior,anchor,replacement));
END;
$migration$;

-- The same protected authorization check runs at lease issue, topic join and
-- publication. The gateway login receives no direct collection access.
CREATE POLICY burimunsi_wake_active_collection ON app.collections FOR SELECT TO postgres
  USING (current_setting('burimunsi.gateway_wake_frame',true)='1' AND status='active');
COMMIT;
