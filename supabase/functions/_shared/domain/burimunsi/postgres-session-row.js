// The database and Edge use the same creation-time allowance for PIN proofs.
export const PIN_CLOCK_SKEW_MS=5000;

const exactPinColumns = `collection_id text, account_id uuid, principal_user_id text,
  native_session_id uuid, created_at bigint, expires_at bigint`;

// Both readers join the same account, installation, scope and upstream directory.
// The direct Home/Payments reader receives the original four-part proof from
// this statement's MATERIALIZED CTE in the already guarded read-only transaction.
export function sessionRowSql({pin,sameSnapshot,boundProof=false}) {
  const expiry=pin?'pin.expires_at':'s.expires_at';
  let pinJoin=pin?'JOIN LATERAL private.burimunsi_pin_context() pin ON pin.native_session_id=s.id':'';
  let selector=`s.collection_id=$1 AND ($2::uuid IS NULL OR s.id=$2::uuid) AND ($3::text IS NULL OR s.token_hash=$3)
        AND ($4::uuid IS NULL OR s.installation_id=$4::uuid)`;
  if(boundProof) {
    pinJoin=`JOIN LATERAL pg_catalog.jsonb_to_record(bound.proof) AS pin(${exactPinColumns}) ON pin.native_session_id=s.id`;
    selector='pin.collection_id=$5 AND s.collection_id=$5';
  }
  const clock=boundProof?'$6::bigint':'$5';
  const currentProof=sameSnapshot?`,
      (pin.collection_id=s.collection_id AND pin.principal_user_id=a.principal_user_id AND pin.account_id=a.id
       AND pin.created_at<=floor(extract(epoch FROM clock_timestamp())*1000)+${PIN_CLOCK_SKEW_MS}
       AND pin.expires_at>floor(extract(epoch FROM clock_timestamp())*1000)) AS pin_current,
      private.burimunsi_operator_is_current(a.collection_id,a.principal_user_id,a.phone,a.role,a.capabilities) AS operator_current`:'';
  return `SELECT s.id AS session_id,${expiry} AS expires_at,s.installation_id,
      a.id,a.collection_id,a.principal_user_id,a.phone,a.name,a.role,a.capabilities,d.profile AS installation_profile${currentProof}
      FROM private.burimunsi_sessions s
      ${pinJoin}
      JOIN private.burimunsi_accounts a ON a.id=s.account_id AND a.collection_id=s.collection_id
      JOIN private.burimunsi_device_grants d ON d.id=s.grant_id AND d.collection_id=s.collection_id
      JOIN private.burimunsi_device_accounts da ON da.grant_id=d.id AND da.account_id=a.id AND da.collection_id=s.collection_id
      JOIN private.burimunsi_scopes c ON c.collection_id=s.collection_id
      JOIN app.users u ON u.id=a.principal_user_id AND u.access_status='active'
      WHERE ${selector} AND NOT s.revoked AND ${expiry}>${clock}
        AND a.active AND NOT a.removed AND d.active AND ${pin?"(c.enabled OR s.auth_method='phone_pin')":'c.enabled'}
        AND a.credential_version=s.credential_version AND d.version=s.grant_version
        AND d.installation_id=s.installation_id AND s.principal_user_id=a.principal_user_id
        AND s.created_at<=${clock}${pin?`+${PIN_CLOCK_SKEW_MS}`:''}`;
}

export const PIN_READ_ACTOR_SQL=`WITH bound AS MATERIALIZED (
    SELECT private.burimunsi_set_pin_context($1,$2::uuid,$3,$4) AS proof
  )
  SELECT bound.proof AS result,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS checked_at,
    (SELECT pg_catalog.to_jsonb(authorized_session) FROM (
      ${sessionRowSql({pin:true,sameSnapshot:true,boundProof:true})}
    ) AS authorized_session) AS actor
  FROM bound`;
