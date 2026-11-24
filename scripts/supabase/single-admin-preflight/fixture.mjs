// Synthetic scenarios only. The epoch is deliberately fictitious.
export function scenario(phase = 'preflight', migrated = false) {
  const release = {
    format: 'burimunsi-single-admin-synthetic-v1',
    base: '2e7b4a2b2fb87dde04ff9da0090a1b416fe5bce3',
    migration: '20261123061132_burimunsi_single_admin.sql',
    sql: '631c125c2caed28585d15f9e47123ba8b8347ef1422da638e38c14d11ccd42ae',
    body: 'c73920b11be890931cf1b40ca22d8be937f5857f33b5ec78b38bccacf1cee68e',
  };
  const history = migrated ? {
    count: 111, tail: '20261123061132', targetEntries: 1, targetSql: release.sql,
    digest: '56949dbd4474555a1c7a0b09c01d6c28394be96aeab4f548d7269704b95cdb2c',
  } : {
    count: 110, tail: '20261122204000', targetEntries: 0, targetSql: null,
    digest: 'a2e678437a11012ee4be10a889fccd1cc64313fe3d3816d6ac51a8f04c892aaf',
  };
  const catalog = migrated ? {
    index: {
      name: 'private.burimunsi_single_admin', table: 'private.burimunsi_accounts', key: 'collection_id',
      predicate: 'role=admin AND active AND NOT removed', unique: true, valid: true, ready: true,
    },
    trigger: {
      name: 'burimunsi_refuse_new_inactive_admin', table: 'private.burimunsi_accounts',
      level: 'ROW', enabled: 'origin', guard: 'private.burimunsi_refuse_new_inactive_admin()',
      event: 'BEFORE INSERT OR UPDATE OF role,active,removed,collection_id',
    },
    guard: {
      signature: 'private.burimunsi_refuse_new_inactive_admin()', returns: 'trigger',
      language: 'plpgsql', execution: 'invoker', searchPath: 'pg_catalog,pg_temp',
      publicExec: false, expectedOwner: true, exactDefinition: true,
    },
  } : {index: null, trigger: null, guard: null};
  return [{release, expectedEpoch: 700, phase}, {
    history, catalog, fence: {mode: 'fenced', epoch: 700},
    admissions: {ingress: 'idle', effects: 'idle', schedulers: 'settled', inFlight: 0},
    conflictingActiveAdmins: 0,
  }];
}
