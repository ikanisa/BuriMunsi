import {applicationWorkTuple,fenceFailure,reserveDatabaseConnection} from './application-fence.js';
import {adminPasscodeProof} from './domain/admin_email_policy.js';
import {ApiError} from './domain/core.js';

const beginWrite = 'BEGIN ISOLATION LEVEL READ COMMITTED';
const beginNativeRead = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const beginLockedRead = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE';
const runtimeSetup = "SET LOCAL ROLE collect_runtime; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'";

// Request-scoped PostgreSQL transactions share the original admission and claims.
// The compatibility adapter translates SQL dialects and statement results.
export class PostgresTransactions {
  #browserPasscode = null;
  #nativeRead = null;

  constructor(sql, claims = {}, work = null) {
    this.sql = sql;
    this.claims = claims;
    this.applicationWork = work;
  }

  setApplicationWork(work) {
    applicationWorkTuple(work);
    this.applicationWork = work;
  }

  setClaims(claims) {
    this.claims = claims;
  }

  setBrowserPasscodeAccount(account) {
    const proof = adminPasscodeProof(account);
    if (!proof || this.applicationWork?.kind !== 'http_admin') throw new Error('browser_passcode_admission_required');
    this.#browserPasscode = Object.freeze([proof.collectionId, account.token_hash, account.origin]);
  }

  hasBrowserPasscodeContext(statement) {
    return this.#browserPasscode!==null && statement.sql==='SELECT private.burimunsi_browser_pin_set_context(?,?,?) AS result' &&
      statement.values.length===3 && statement.values.every((value,index)=>value===this.#browserPasscode[index]);
  }

  async #applyBrowserPasscode(tx) {
    if (this.#browserPasscode === null) return;
    let result;
    try {
      result = await tx.unsafe('SELECT private.burimunsi_browser_pin_set_context($1,$2,$3) AS result', this.#browserPasscode);
    } catch (error) {
      if (error?.code !== '42501') throw error;
    }
    if (result?.[0]?.result !== true) {
      throw new ApiError(401,'unauthenticated','Your session has ended. Sign in again.');
    }
  }

  async readContext(tx, {isolation = 'repeatable read'} = {}) {
    // This path cannot grant write authority: the server must already enforce a
    // genuine read-only transaction at the requested closed isolation level
    // before role/claims setup. Existing callers retain repeatable-read.
    if (!['repeatable read', 'read committed'].includes(isolation)) throw fenceFailure(null);
    await this.#readContext(tx, isolation, 'on');
  }

  async #readContext(tx, isolation, readOnly, native = false) {
    const work = this.applicationWork;
    if (!work) throw fenceFailure(null);
    await work.assert();
    const claims = JSON.stringify(this.claims);
    if (native && work.kind === 'http_collect') {
      // A mode mismatch produces no row, so none of the transaction-local
      // settings are applied. The consumer runs only after the role is confirmed.
      const [setup] = await tx`SELECT
        pg_catalog.set_config('role','collect_runtime',true) AS runtime_role,
        pg_catalog.set_config('statement_timeout','15s',true),
        pg_catalog.set_config('lock_timeout','5s',true),
        pg_catalog.set_config('search_path','app,public,pg_catalog',true),
        pg_catalog.set_config('request.jwt.claims',${claims},true),
        pg_catalog.set_config('collect.edge_verified','true',true)
        WHERE pg_catalog.current_setting('transaction_read_only') = 'on'
          AND pg_catalog.current_setting('transaction_isolation') = 'repeatable read'`;
      if (setup?.runtime_role !== 'collect_runtime') throw fenceFailure(null);
      await this.#applyBrowserPasscode(tx);
      return;
    }
    const [mode] = await tx.unsafe("SELECT pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,pg_catalog.current_setting('transaction_isolation') AS transaction_isolation");
    if (mode?.transaction_read_only !== readOnly || mode?.transaction_isolation !== isolation) throw fenceFailure(null);
    await tx.unsafe(runtimeSetup);
    if (work.kind === 'http_admin') {
      const [id, epoch, source] = applicationWorkTuple(work);
      await tx`select pg_catalog.set_config('search_path','app,public,pg_catalog',true),pg_catalog.set_config('request.jwt.claims',${claims},true),pg_catalog.set_config('collect.edge_verified','true',true),pg_catalog.set_config('collect.fence_admission_id',${id},true),pg_catalog.set_config('collect.fence_epoch',${String(epoch)},true),pg_catalog.set_config('collect.fence_source_sha256',${source},true)`;
    } else {
      await tx`select pg_catalog.set_config('search_path','app,public,pg_catalog',true),pg_catalog.set_config('request.jwt.claims',${claims},true),pg_catalog.set_config('collect.edge_verified','true',true)`;
    }
    await this.#applyBrowserPasscode(tx);
  }

  async context(tx, claims = this.claims) {
    const work = this.applicationWork;
    if (!work) throw fenceFailure(null);
    await work.assert();
    const [admissionId, epoch, source] = applicationWorkTuple(work);
    await tx.unsafe(runtimeSetup);
    await tx`select pg_catalog.set_config('search_path','app,public,pg_catalog',true),pg_catalog.set_config('request.jwt.claims',${JSON.stringify(claims)},true),pg_catalog.set_config('collect.edge_verified','true',true),pg_catalog.set_config('collect.fence_admission_id',${admissionId},true),pg_catalog.set_config('collect.fence_epoch',${String(epoch)},true),pg_catalog.set_config('collect.fence_source_sha256',${source},true)`;
    try {
      const rows = await tx`select private.collect_fence_assert_write(${admissionId}::uuid,${epoch}::bigint,${source}::text) as result`;
      const result = rows[0]?.result;
      if (result?.contractVersion !== 1 || result.epoch !== epoch || !['open', 'quiescing'].includes(result.mode)) {
        throw new Error('collect_fence_unavailable');
      }
    } catch (error) {
      throw fenceFailure(error);
    }
    await this.#applyBrowserPasscode(tx);
  }

  // Only the read-only native entry point installs this connection. Reuse is
  // limited to the lifetime of one request, one admission and one SQL snapshot.
  async withNativeReadSnapshot(operation) {
    if (this.#nativeRead) return operation(this.#nativeRead);
    return this.#transaction(async tx => {
      await this.#readContext(tx, 'repeatable read', 'on', true);
      this.#nativeRead = tx;
      try {
        const result = await operation(tx);
        await this.applicationWork.assert();
        return result;
      } finally {
        this.#nativeRead = null;
      }
    }, beginNativeRead);
  }

  ownsNativeRead(tx) {
    return this.#nativeRead !== null && this.#nativeRead === tx;
  }

  transaction(fn) {
    if (this.#nativeRead) throw new Error('read_snapshot_cannot_write');
    return this.#transaction(fn);
  }

  #transaction(fn, begin = beginWrite) {
    const lockReadSnapshot = begin === beginLockedRead;
    const work = this.applicationWork;
    if (!work) throw fenceFailure(null);
    return work.waitUntil((async () => {
      await work.assert();
      const tx = await reserveDatabaseConnection(this.sql);
      let idleConfirmed = false;
      try {
        await tx.unsafe(begin);
        const result = await fn(tx);
        if (!lockReadSnapshot) {
          await tx.unsafe('COMMIT');
          idleConfirmed = true;
        }
        return result;
      } finally {
        if (!idleConfirmed) {
          try {
            await tx.unsafe('ROLLBACK');
            idleConfirmed = true;
          } catch (error) {
            work.abandon('work_lost');
            if (lockReadSnapshot) throw fenceFailure(error);
          }
        }
        // Releasing a postgres.js reservation does not reset its transaction.
        // Keep unconfirmed connections out of the pool.
        if (idleConfirmed) tx.release();
      }
    })());
  }

  // Identity and permission SELECTs take row locks, which require READ WRITE.
  // Use a guarded repeatable-read snapshot without mutation admission and
  // always roll back after materializing the projections.
  withLockedReadSnapshot(read) {
    const work = this.applicationWork;
    return this.#transaction(async tx => {
      await this.#readContext(tx, 'repeatable read', 'off');
      const result = await read(tx);
      await work.assert();
      if (this.applicationWork !== work) throw fenceFailure(null);
      return result;
    }, beginLockedRead);
  }
}
