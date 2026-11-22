import {describe, expect, it} from 'vitest';
import {parseTeam, teamDirectoryPath} from '../../src/session/teamDirectory';
import type {AdminUser} from '../../src/session/SessionProvider';

const actor: AdminUser = {id: 'staff-one', email: 'a@example.com', role: 'staff', sessionId: 'session-one', expiresAt: new Date(Date.now() + 600_000).toISOString(), permissions: ['admin_users.read'], assuranceLevel: 1, mfaAt: null, emailVerifiedAt: null, principalId: null, financialModel: 'canonical_evidence_ledger'};
const team = {currentEmail: actor.email, canManage: false, permissionsByRole: {owner: ['admin_users.manage'], staff: ['admin_users.read']}, members: [{id: 'staff-one', email: actor.email, role: 'staff', status: 'active', displayName: 'Operator', publicId: '123456', emailStatus: null}]};

describe('team access responses', () => {
  it('accepts a server-bound team list and its role permissions', () => {
    expect(parseTeam(team, actor)).toMatchObject({canManage: false, members: [{id: actor.id, status: 'active'}], permissionsByRole: {staff: ['admin_users.read']}});
  });
  it('rejects a team list for a different actor or an invented management grant', () => {
    expect(() => parseTeam({...team, currentEmail: 'other@example.com'}, actor)).toThrow();
    expect(() => parseTeam({...team, canManage: true}, actor)).toThrow();
  });
  it('rejects unknown roles, malformed statuses and duplicate member identities', () => {
    expect(() => parseTeam({...team, members: [{...team.members[0], role: 'superuser'}]}, actor)).toThrow();
    expect(() => parseTeam({...team, members: [{...team.members[0], status: 'unknown'}]}, actor)).toThrow();
    expect(() => parseTeam({...team, members: [team.members[0], team.members[0]]}, actor)).toThrow();
  });
  it('distinguishes a typed access notice from an invitation and validates its target', () => {
    const owner: AdminUser = {...actor, id: 'owner-one', email: 'current-owner@example.com', role: 'owner', principalId: 'owner-principal', permissions: ['admin_users.read', 'admin_users.manage'],
      ownerIdentity: {schemaVersion: 1, adminId: 'owner-one', principalId: 'owner-principal', email: 'current-owner@example.com'}};
    const id = 'cdd3c1c0-c124-4c8a-9719-bd2435d198d1';
    const receipt = {contractVersion: 2, id, requestId: '0f689afa-5a45-4fb5-a147-9aff36f137dd', messageKind: 'access_notice', noticeStatus: 'accepted', accessStatus: 'active', operation: 'notice_repair', replayed: false, duplicate: false, sourceRequestId: 'fa1e3f37-1e2b-4e57-9d7d-77f0c13d0d50'};
    const response = {contractVersion: 2, currentEmail: owner.email, canManage: true, permissionsByRole: {}, members: [{id, email: 'staff@example.com', role: 'staff', status: 'active', displayName: null, publicId: null, invitation: receipt}]};
    expect(teamDirectoryPath(owner, 'email', 2, true)).toBe('team/v2');
    expect(teamDirectoryPath(owner, 'email', 2, false)).toBe('team');
    expect(teamDirectoryPath({...owner, principalId: 'different-principal'}, 'email', 2, true)).toBe('team');
    expect(parseTeam(response, owner).members[0]).toMatchObject({invitationKind: 'access_notice', emailStatus: 'accepted'});
    expect(() => parseTeam({...response, members: [{...response.members[0], status: 'revoked'}]}, owner)).toThrow();
    expect(() => parseTeam(response, owner, 'email', 1)).toThrow(/version/);
  });
  it('retains managed v1 directory reads without accepting an unproven owner', () => {
    const legacyOwner: AdminUser = {...actor, email: 'info@ikanisa.com', role: 'owner', permissions: ['admin_users.read', 'admin_users.manage']};
    const response = {...team, currentEmail: legacyOwner.email, canManage: true};
    expect(teamDirectoryPath(legacyOwner, 'email', 2, true)).toBe('team');
    expect(parseTeam(response, legacyOwner)).toMatchObject({canManage: false, canRecoverInvitations: true, contractVersion: 1});
    expect(parseTeam(response, legacyOwner, 'authenticator')).toMatchObject({canManage: true});
    expect(() => parseTeam({...response, contractVersion: 2}, legacyOwner)).toThrow(/version/);
  });
  it('keeps legacy failed-delivery statuses scoped to the legacy backend', () => {
    const response = {...team, members: [{...team.members[0], emailStatus: 'failed'}]};
    expect(() => parseTeam(response, actor)).toThrow();
    expect(parseTeam(response, actor, 'authenticator').members[0].emailStatus).toBe('failed');
  });
  it('requires a correlated request and operation for managed v1 invitation history', () => {
    const requestId = '0f689afa-5a45-4fb5-a147-9aff36f137dd';
    const response = {...team, members: [{...team.members[0], emailStatus: 'accepted', invitationRequestId: requestId, invitationOperation: 'invite'}]};
    expect(parseTeam(response, actor).members[0]).toMatchObject({emailStatus: 'accepted', invitationRequestId: requestId, invitationOperation: 'invite'});
    expect(() => parseTeam({...response, members: [{...response.members[0], invitationRequestId: null}]}, actor)).toThrow(/history/);
    expect(() => parseTeam({...response, members: [{...response.members[0], invitationOperation: 'notice_repair'}]}, actor)).toThrow(/history/);
    expect(() => parseTeam({...response, members: [{...response.members[0], emailStatus: null}]}, actor)).toThrow(/history/);
  });
});
