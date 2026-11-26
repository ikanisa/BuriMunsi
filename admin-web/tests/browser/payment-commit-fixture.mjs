// A single in-memory synthetic allocation for the explicitly enabled loopback
// browser rehearsal. It cannot represent a PostgreSQL or hosted ledger effect.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPaymentCommitFixture({payment, member, json, readBody}) {
  if (payment.state !== 'unallocated' || !Number.isSafeInteger(payment.version) || payment.version < 1 ||
      !payment.id || !payment.groupId || !member.id) throw new Error('Expected one valid synthetic payment');
  const base = '/api/admin/burimunsi/payments';
  const detail = base + '/' + payment.id;
  let committed = null;
  let views = 0;
  let writes = 0;
  let effects = 0;
  let checkUnavailable = true;
  const lookupMatches = [];
  function readPayment() {
    if (!committed) return {...payment, canAllocate:true};
    return {...payment, canAllocate:true, state:'allocated', version:committed.version, memberId:member.id, memberName:member.display_name};
  }
  function evidence() {
    return {views, writes, effects, lookupMatches:[...lookupMatches]};
  }
  async function handle(request, response, url, session, canAllocate) {
    const path = url.pathname;
    const kind = new Map([[base + '/members','members'],[detail,'detail'],[detail + '/allocate','write'],
      [detail + '/allocation-receipt','lookup']]).get(path);
    if (!kind) return false;
    const fail = (status, code) => json(response, status, {error:{code}});
    if (!session?.accountId || !session?.sessionId) {fail(401, 'fixture_unauthorized'); return true;}
    if (!canAllocate) {fail(403, 'forbidden'); return true;}
    if (kind === 'members' && request.method === 'GET') {
      json(response, 200, {items:[{id:member.id, name:member.display_name}]}); return true;
    }
    if (url.search) {fail(400, 'invalid_fixture'); return true;}
    if (kind === 'detail' && request.method === 'GET') {
      views += 1;
      json(response, 200, readPayment()); return true;
    }
    if (kind === 'write' && request.method === 'POST') {
      if (request.headers['x-collect-csrf'] !== session.csrfToken) {fail(403, 'csrf_failed'); return true;}
      const key = request.headers['idempotency-key'];
      const body = await readBody(request);
      if (typeof key !== 'string' || !uuid.test(key) || !body ||
          Object.keys(body).sort().join(',') !== 'expectedVersion,memberId' ||
          body.memberId !== member.id || body.expectedVersion !== payment.version) {
        fail(400, 'invalid_fixture'); return true;
      }
      writes += 1;
      if (committed) {fail(409, 'fixture_second_write'); return true;}
      committed = {key, session:session.sessionId, account:session.accountId, version:payment.version + 1};
      effects += 1;
      // Never send a usable acknowledgement. Flush partial HTTP bytes first:
      // a zero-byte TCP close can trigger Chromium's transport-level resend
      // before fetch surfaces the failure, which is a different test case.
      response.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':'80'});
      response.write('{"paymentId":', () => response.destroy());
      return true;
    }
    if (kind === 'lookup' && request.method === 'GET') {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !uuid.test(key)) {fail(400, 'invalid_fixture'); return true;}
      const matches = committed?.key === key && committed?.session === session.sessionId && committed?.account === session.accountId;
      lookupMatches.push(matches === true);
      if (!matches) {json(response, 200, {state:'unconfirmed', requestId:key}); return true;}
      if (checkUnavailable) {checkUnavailable = false; fail(503, 'payments_unavailable'); return true;}
      json(response, 200, {state:'committed', requestId:key, receipt:{paymentId:payment.id,
        memberId:member.id, version:committed.version}});
      return true;
    }
    fail(405, 'fixture_read_only');
    return true;
  }
  return {handle, readPayment, evidence};
}
