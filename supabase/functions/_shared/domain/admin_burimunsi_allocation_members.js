/** The cursor is an eligible member of this group. Names alone do not identify a member. */
export async function readAllocationMemberPage(sql, groupId, {q, limit, after}) {
  const rows = await sql.unsafe(`WITH eligible AS NOT MATERIALIZED (
    SELECT u.id,u.full_name AS name,u.public_id AS "publicId",m.membership_record_number AS "memberNumber"
    FROM app.memberships m JOIN app.users u ON u.id=m.user_id
    WHERE m.collection_id=$1 AND m.active=1 AND u.access_status='active' AND u.member_type<>'operator'
      AND (CASE WHEN $2 ~ '^([0-9]{6}|[0-9]{12})$' THEN u.public_id=$2 OR m.membership_record_number=$2
                ELSE strpos(lower(u.full_name),lower($2))>0 END)
  )
  SELECT id,name,"publicId","memberNumber" FROM eligible
  WHERE $3::text IS NULL OR (name,id)>(SELECT name,id FROM eligible WHERE id=$3)
  ORDER BY name,id LIMIT $4`, [groupId, q, after ?? null, limit + 1]);
  const items = rows.slice(0, limit);
  return {items, nextCursor: rows.length > limit ? items[items.length - 1].id : null};
}
