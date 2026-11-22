import {verifyDeploymentProfile} from './deployment-profile.js';

// Run this request's database checks under collect_runtime before admitting work.
// The standalone query reads at most two collection IDs, including a possible
// competing collection. Only the matching decision crosses the SQL connection.
export async function prepareDeploymentCheck(env, standaloneCollectionId) {
  if (env.COLLECT_DEPLOYMENT_PROFILE === undefined) return undefined;
  await verifyDeploymentProfile(env);
  const digest = env.COLLECT_DEPLOYMENT_PROFILE_SHA256;
  return async (tx, registration = undefined) => {
    if (registration !== undefined) {
      if (standaloneCollectionId === undefined || registration.kind !== 'http_collect') {
        throw new Error('standalone_read_registration_required');
      }
      // MATERIALIZED evaluates the release and collection proof once. CASE
      // calls the existing volatile register only for that exact proof.
      const rows = await tx`WITH authorized AS MATERIALIZED (
        SELECT private.collect_assert_deployment(${digest}::text) AS allowed,
          (SELECT count(*) = 1 AND bool_and(id = ${standaloneCollectionId})
           FROM (SELECT id FROM app.collections LIMIT 2) AS visible) AS scope_matches
      )
      SELECT allowed, scope_matches, CASE WHEN allowed AND scope_matches THEN
        private.collect_fence_register(${registration.id}::uuid, ${registration.source}::text, ${registration.kind}::text)
      END AS result FROM authorized`;
      if (rows.length !== 1 || rows[0].allowed !== true) throw new Error('deployment_identity_mismatch');
      if (rows[0].scope_matches !== true) throw new Error('burimunsi_collection_mismatch');
      return rows[0].result;
    }
    const rows = standaloneCollectionId === undefined
      ? await tx`SELECT private.collect_assert_deployment(${digest}::text) AS allowed`
      : await tx`SELECT private.collect_assert_deployment(${digest}::text) AS allowed,
          (SELECT count(*) = 1 AND bool_and(id = ${standaloneCollectionId})
           FROM (SELECT id FROM app.collections LIMIT 2) AS visible) AS scope_matches`;
    if (rows.length !== 1 || rows[0].allowed !== true) throw new Error('deployment_identity_mismatch');
    if (standaloneCollectionId !== undefined && rows[0].scope_matches !== true) {
      throw new Error('burimunsi_collection_mismatch');
    }
  };
}

/** @param {string} [standaloneCollectionId] */
export async function assertRuntimeDeployment(sql, env, standaloneCollectionId = undefined) {
  const check = await prepareDeploymentCheck(env, standaloneCollectionId);
  if (!check) return;
  await sql.begin(async tx => {
    await tx`SET LOCAL ROLE collect_runtime`;
    await check(tx);
  });
}
