import {verifyDeploymentProfile} from './deployment-profile.js';

// Read-only before admission. A valid public profile cannot accidentally run
// against another deployment's database even if its connection is reachable.
/** @param {string} [standaloneCollectionId] */
export async function assertRuntimeDeployment(sql,env,standaloneCollectionId=undefined){
 // Legacy unbound deployments retain their old behavior. Every explicit
 // profile, including managed production, must match this database's immutable
 // identity before the application fence or any provider work is opened.
 if(env.COLLECT_DEPLOYMENT_PROFILE===undefined)return;
 await verifyDeploymentProfile(env);
 await sql.begin(async tx=>{
  await tx`SET LOCAL ROLE collect_runtime`;
  await assertDatabaseIdentity(tx,env,standaloneCollectionId);
 });
}

export async function assertDatabaseIdentity(tx,env,standaloneCollectionId){
 const digest=env.COLLECT_DEPLOYMENT_PROFILE_SHA256;
 const rows=standaloneCollectionId===undefined
  ? await tx`SELECT private.collect_assert_deployment(${digest}::text) AS allowed`
  : await tx`SELECT private.collect_assert_deployment(${digest}::text) AS allowed,
      ARRAY(SELECT id FROM app.collections LIMIT 2) AS collections`;
 if(rows.length!==1||rows[0].allowed!==true)throw new Error('deployment_identity_mismatch');
 if(standaloneCollectionId!==undefined&&
    (rows[0].collections?.length!==1||rows[0].collections[0]!==standaloneCollectionId))
  throw new Error('burimunsi_collection_mismatch');
}
