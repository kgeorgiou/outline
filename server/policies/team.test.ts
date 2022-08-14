import env from "@server/env";
import { buildUser, buildTeam, buildAdmin } from "@server/test/factories";
import { getTestDatabase } from "@server/test/support";
import { serialize } from "./index";

const db = getTestDatabase();

afterAll(db.disconnect);

beforeEach(db.flush);

it("should allow reading only", async () => {
  const team = await buildTeam();
  const user = await buildUser({
    teamId: team.id,
  });
  const abilities = serialize(user, team);
  expect(abilities.read).toEqual(true);
  expect(abilities.manage).toEqual(false);
  expect(abilities.createTeam).toEqual(false);
  expect(abilities.createAttachment).toEqual(true);
  expect(abilities.createCollection).toEqual(true);
  expect(abilities.createDocument).toEqual(true);
  expect(abilities.createGroup).toEqual(false);
  expect(abilities.createIntegration).toEqual(false);
});
it("should allow admins to manage", async () => {
  const team = await buildTeam();
  const admin = await buildAdmin({
    teamId: team.id,
  });
  const abilities = serialize(admin, team);
  expect(abilities.read).toEqual(true);
  expect(abilities.manage).toEqual(true);
  expect(abilities.createTeam).toEqual(false);
  expect(abilities.createAttachment).toEqual(true);
  expect(abilities.createCollection).toEqual(true);
  expect(abilities.createDocument).toEqual(true);
  expect(abilities.createGroup).toEqual(true);
  expect(abilities.createIntegration).toEqual(true);
});

it("should allow creation on hosted envs", async () => {
  env.DEPLOYMENT = "hosted";

  const team = await buildTeam();
  const admin = await buildAdmin({
    teamId: team.id,
  });
  const abilities = serialize(admin, team);
  expect(abilities.read).toEqual(true);
  expect(abilities.manage).toEqual(true);
  expect(abilities.createTeam).toEqual(true);
  expect(abilities.createAttachment).toEqual(true);
  expect(abilities.createCollection).toEqual(true);
  expect(abilities.createDocument).toEqual(true);
  expect(abilities.createGroup).toEqual(true);
  expect(abilities.createIntegration).toEqual(true);
});
