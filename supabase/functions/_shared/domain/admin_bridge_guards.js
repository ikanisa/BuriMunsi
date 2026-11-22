import { id } from './core.js';

/** Assert a predicate inside the caller's mutation batch. */
export function bridgeStateGuard(database, predicate, values = [], guardId = id()) {
  return [
    database.prepare(
      `INSERT INTO admin_bridge_guards(id,passed) SELECT ?,(CASE WHEN ${predicate} THEN 1 ELSE 0 END)`,
    ).bind(guardId, ...values),
    database.prepare('DELETE FROM admin_bridge_guards WHERE id=?').bind(guardId),
  ];
}
