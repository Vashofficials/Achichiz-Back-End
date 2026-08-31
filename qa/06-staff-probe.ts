/**
 * What does the Team & Roles screen actually have to render?
 *
 * The panel derives its member list from `/v1/admin/roles/{roleId}.members`.
 * If that array is empty for every role the screen shows "0 staff", which is
 * indistinguishable from a broken query — so count the real rows too.
 */
import { adminLogin, call, closeDb, unwrap, db, BASE } from './lib.js';

const main = async (): Promise<void> => {
  console.log(`target: ${BASE}\n`);
  const admin = await adminLogin();
  const t = { token: admin.access };

  const list = await call('GET', '/v1/admin/roles', t);
  const roles = (unwrap(list.body) as { id: string; key: string; staffCount?: number }[]) ?? [];
  console.log(`GET /v1/admin/roles -> ${list.status}, ${roles.length} role(s)\n`);

  let membersSeen = 0;
  for (const r of roles) {
    const d = await call('GET', `/v1/admin/roles/${r.id}`, t);
    const detail = unwrap(d.body) as { members?: unknown[] };
    const n = detail?.members?.length ?? 0;
    membersSeen += n;
    console.log(`  ${String(d.status).padEnd(4)} ${r.key.padEnd(24)} staffCount=${r.staffCount ?? '-'}  members=${n}`);
  }

  const { rows } = await db().query<{ n: string; active: string }>(
    "select count(*)::text n, count(*) filter (where status='active')::text active from staff_users",
  );
  console.log(`\nmembers summed from the API : ${membersSeen}`);
  console.log(`staff_users rows in the DB  : ${rows[0]?.n} (${rows[0]?.active} active)`);
  console.log(membersSeen === Number(rows[0]?.n)
    ? '\nMATCH — the screen is showing the truth.'
    : '\nMISMATCH — the API under-reports staff; the screen would show a false empty state.');

  await closeDb();
};

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(2); });
