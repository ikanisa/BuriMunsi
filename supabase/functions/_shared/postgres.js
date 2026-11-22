import {PostgresTransactions} from './postgres-transactions.js';
import {compileSql} from './postgres-compatibility-sql.js';
import {COLLECT_MUTATION_LOCK} from './postgres-mutation-lock.js';

// Existing consumers of the D1 compatibility entrypoint keep their exports.
export {connection, fenceConnection, leaseOwnedControlPool} from './postgres-connections.js';
export {compileSql};

class Statement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.db, this.sql, values);
  }

  async all() {
    return this.db.execute(this);
  }

  async first(column) {
    const row = (await this.all()).results[0] ?? null;
    return column && row ? row[column] : row;
  }

  async run() {
    return this.all();
  }

  async raw() {
    return (await this.all()).results.map(Object.values);
  }
}

export class PostgresDatabase extends PostgresTransactions {
  prepare(text) {
    return new Statement(this, text);
  }

  withSession() {
    return this;
  }

  async statement(tx, statement) {
    const query = compileSql(statement.sql, statement.values);
    let result;
    try {
      result = await tx.unsafe(query.text, query.values);
    } catch (error) {
      error.collectSql = query.text;
      throw error;
    }
    const changes = result.count ?? result.length;
    await tx`select pg_catalog.set_config('collect.last_changes',${String(changes)},true)`;
    return {success: true, results: Array.from(result), meta: {changes}};
  }

  async #runStatements(statements, execute) {
    const results = [];
    for (const statement of statements) results.push(await execute(statement));
    return results;
  }

  async execute(statement) {
    return this.transaction(async tx => {
      await this.context(tx);
      return this.statement(tx, statement);
    });
  }

  // Use one admitted transaction for all awaited work in the operation.
  withWriteTransaction(operation) {
    const claims = this.claims;
    const assertClaims = () => {
      if (this.claims !== claims) throw new Error('write_transaction_claims_changed');
    };
    return this.transaction(async tx => {
      assertClaims();
      await this.context(tx, claims);
      // D1 serialized all mutations. Serialize financial and authority batches
      // until reviewed per-group locking proves equivalent under concurrency.
      await tx.unsafe(`SELECT pg_catalog.pg_advisory_xact_lock(${COLLECT_MUTATION_LOCK}::bigint)`);
      let open = true;
      const assertOpen = () => {
        if (!open) throw new Error('write_transaction_closed');
        assertClaims();
      };
      const execute = statement => {
        assertOpen();
        return this.statement(tx, statement);
      };
      const scope = {
        prepare: text => new Statement(scope, text),
        execute,
        batch: statements => {
          assertOpen();
          return this.#runStatements(statements, execute);
        },
        setClaims: next => {
          assertOpen();
          if (next !== claims) throw new Error('write_transaction_claims_changed');
        },
      };
      try {
        assertOpen();
        const result = await operation(scope);
        assertOpen();
        return result;
      } finally {
        open = false;
      }
    });
  }

  async batch(statements) {
    return this.withWriteTransaction(scope => scope.batch(statements));
  }

  async adminReadBatch(context, check, statements) {
    return this.withLockedReadSnapshot(async tx => {
      await this.statement(tx, context);
      const authority = await this.statement(tx, check);
      if (authority.results.length !== 1 || authority.results[0].allowed !== true) throw new Error('admin_account_authority');
      return this.#runStatements(statements, statement => this.statement(tx, statement));
    });
  }

  async query(text, values = []) {
    return this.execute(this.prepare(text).bind(...values));
  }
}
